import { config } from "@/lib/config";
import { getProviders } from "@/lib/providers";
import { estimateTokens } from "@/lib/providers/tokens";
import { hashEmbed } from "@/lib/providers/offline";
import type { Repository } from "@/lib/store/repository";
import { contentTerms, weightedCoverage } from "@/lib/text";
import type { Chunk, ScoredChunk, Source } from "@/lib/types";

/**
 * Retrieval.
 *
 * Four stages, each fixing a specific failure I could observe on the sample
 * corpus:
 *
 * 1. Dense + lexical in parallel. Dense alone misses "MI-412" and "Kellerman";
 *    BM25 alone misses "how are we handling scale" when the transcript says
 *    "throughput" and "load". Meeting language is informal enough that both
 *    fail often, but rarely on the same query.
 *
 * 2. Reciprocal rank fusion. Cosine similarity and BM25 are on incomparable
 *    scales, and normalising them means picking a weight that is really a guess.
 *    RRF only reads ranks, so there is nothing to tune and one strong signal
 *    cannot be drowned out by the other's scale.
 *
 * 3. MMR. The top hits for "what did we decide about the database" are often the
 *    same exchange three times over, because of chunk overlap. Diversity is
 *    worth more than the fourth copy of the same turn.
 *
 * 4. Neighbour expansion. This is the conversational-data fix. A decision is
 *    proposal → objection → confirmation, spread over turns that may straddle a
 *    chunk boundary. Pulling the adjacent chunks of the best hits recovers the
 *    part of the exchange that scored just below the cut.
 */

export interface RetrievalOptions {
  meetingIds?: string[];
  denseK?: number;
  lexicalK?: number;
  finalK?: number;
  neighborRadius?: number;
  neighborSeeds?: number;
  contextTokenBudget?: number;
}

export interface RetrievalResult {
  sources: Source[];
  /** Everything considered before packing, for the trace inspector. */
  candidates: ScoredChunk[];
  denseCount: number;
  lexicalCount: number;
  embeddingTokens: number;
  droppedForBudget: number;
  /** Why the pipeline concluded there was, or was not, relevant evidence. */
  relevance: { maxDenseScore: number; queryCoverage: number; gated: boolean };
}

export async function retrieve(
  repository: Repository,
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const settings = {
    denseK: options.denseK ?? config.retrieval.denseK,
    lexicalK: options.lexicalK ?? config.retrieval.lexicalK,
    finalK: options.finalK ?? config.retrieval.finalK,
    neighborRadius: options.neighborRadius ?? config.retrieval.neighborRadius,
    neighborSeeds: options.neighborSeeds ?? config.retrieval.neighborSeeds,
    contextTokenBudget: options.contextTokenBudget ?? config.retrieval.contextTokenBudget,
  };

  const providers = getProviders();
  const { vectors, tokens: embeddingTokens } = await providers.embeddings.embed([query]);
  const queryVector = vectors[0] ?? [];

  const dense = repository.denseSearch(
    queryVector,
    settings.denseK,
    options.meetingIds,
    config.retrieval.minDenseSimilarity,
  );
  const lexical = repository.lexicalSearch(query, settings.lexicalK, options.meetingIds);

  const titles = repository.meetingTitles();
  const fused = fuseRanks(dense, lexical, config.retrieval.rrfK).map((entry) => {
    const meta = titles.get(entry.chunk.meetingId);
    return {
      ...entry.chunk,
      denseRank: entry.denseRank,
      lexicalRank: entry.lexicalRank,
      fusedScore: entry.score,
      meetingTitle: meta?.title ?? "Unknown meeting",
      meetingDate: meta?.date ?? null,
    } satisfies ScoredChunk;
  });

  const relevant = fused.filter((chunk) => chunk.fusedScore >= config.retrieval.minFusedScore);
  const selected = selectWithFloor(relevant, dense, lexical, query, settings);

  // Relevance gate. Two independent signals, and evidence is rejected only when
  // both say no: a strong dense hit vouches for a paraphrased question, and
  // lexical coverage vouches for one phrased in the transcript's own vocabulary.
  const maxDenseScore = dense[0]?.score ?? 0;
  const terms = contentTerms(query);
  // Measured over the whole selected set. I tried restricting it to the top three
  // hits, on the theory that evidence should be concentrated — it made the gate
  // strictly worse on the evaluation set, falsely refusing the cross-meeting
  // "which decision was reversed" case, whose evidence is legitimately spread
  // across two meetings, without fixing any of the cases it was meant to catch.
  const coverage = weightedCoverage(
    terms,
    selected.map((chunk) => chunk.text).join("\n"),
    repository.documentFrequencies(terms),
    Math.max(1, repository.countChunks()),
  );
  /**
   * The gate is deliberately cheap insurance, not the arbiter of answerability.
   *
   * Calibration against real embeddings (`npm run gate`) showed neither signal
   * separates the two populations: a question shaped like the corpus scores 0.40
   * cosine on a subject the corpus never mentions, above several genuinely
   * answerable questions, and lexical coverage reaches 0.69 for "who won the
   * football match last night" because those words all occur somewhere. So the gate
   * only catches what is unambiguous, and the model — which reads the excerpts and
   * judges them correctly — decides the rest, with `looksLikeDecline` recognising
   * when it has declined.
   *
   * `dense.length === 0` is that unambiguous case: not one chunk in the corpus
   * cleared the absolute similarity floor, so there is no semantic evidence at all
   * and any lexical hits are incidental word overlap. On the calibration set every
   * answerable question scored at least 0.22, so nothing real is lost here.
   */
  const gated =
    selected.length === 0 ||
    dense.length === 0 ||
    (maxDenseScore < config.retrieval.strongDenseSimilarity && coverage < config.retrieval.minQueryCoverage);

  const relevance = {
    maxDenseScore: Number(maxDenseScore.toFixed(4)),
    queryCoverage: Number(coverage.toFixed(3)),
    gated,
  };

  if (gated) {
    return { sources: [], candidates: fused, denseCount: dense.length, lexicalCount: lexical.length, embeddingTokens, droppedForBudget: 0, relevance };
  }

  const expanded = expandNeighbours(repository, selected, settings.neighborRadius, settings.neighborSeeds, titles);
  const { sources, dropped } = packWithinBudget(expanded, settings.contextTokenBudget);

  return {
    sources,
    candidates: fused,
    denseCount: dense.length,
    lexicalCount: lexical.length,
    embeddingTokens,
    droppedForBudget: dropped,
    relevance,
  };
}

/**
 * Fusion, then MMR — but with a guaranteed slot for each retriever's own best hits.
 *
 * RRF rewards appearing in both lists over being excellent in one, and on this
 * corpus that loses real answers. For "was any earlier decision reversed later",
 * the turn that states the reversal outright is BM25's second hit by a wide margin
 * (3.40, against 0.66 for the fourth) but is absent from the dense top-k, so it
 * earns a single 1/(60+2) contribution — and is outranked by chunks that are 18th
 * and 11th in the two lists yet collect two contributions each. Fused rank 11 with
 * finalK=8 means the sentence containing the answer never reaches the model.
 *
 * Reading BM25's scores instead of its ranks would fix this case, but normalising
 * two incomparable scales means choosing a weight by guesswork, which is the exact
 * problem RRF is used to avoid. Reserving the first `perRetrieverFloor` slots for
 * each retriever keeps fusion tuning-free and still lets either one insist on the
 * handful of hits it is most confident about.
 */
export function selectWithFloor(
  relevant: ScoredChunk[],
  dense: { chunk: Chunk }[],
  lexical: { chunk: Chunk }[],
  query: string,
  settings: { finalK: number },
): ScoredChunk[] {
  const eligible = new Map(relevant.map((chunk) => [chunk.id, chunk]));
  const floor = Math.min(config.retrieval.perRetrieverFloor, Math.floor(settings.finalK / 2));

  const guaranteed: ScoredChunk[] = [];
  const claimed = new Set<string>();
  // Interleaved so neither retriever's quota is starved when finalK is small.
  for (let rank = 0; rank < floor; rank += 1) {
    for (const list of [dense, lexical]) {
      const chunk = eligible.get(list[rank]?.chunk.id ?? "");
      if (!chunk || claimed.has(chunk.id)) continue;
      claimed.add(chunk.id);
      guaranteed.push(chunk);
    }
  }

  const remaining = relevant.filter((chunk) => !claimed.has(chunk.id));
  const filled = mmrSelect(remaining, query, Math.max(0, settings.finalK - guaranteed.length), config.retrieval.mmrLambda);
  return [...guaranteed, ...filled];
}

interface FusedEntry {
  chunk: Chunk;
  score: number;
  denseRank: number | null;
  lexicalRank: number | null;
}

/**
 * Reciprocal rank fusion: score = sum over lists of 1 / (k + rank). `k` damps the
 * top of each list so a single list cannot dominate on its first result alone.
 */
export function fuseRanks(
  dense: { chunk: Chunk; score: number }[],
  lexical: { chunk: Chunk; score: number }[],
  k: number,
): FusedEntry[] {
  const merged = new Map<string, FusedEntry>();

  const add = (list: { chunk: Chunk }[], field: "denseRank" | "lexicalRank") => {
    list.forEach((item, index) => {
      const rank = index + 1;
      const existing = merged.get(item.chunk.id);
      const contribution = 1 / (k + rank);
      if (existing) {
        existing.score += contribution;
        existing[field] = rank;
      } else {
        merged.set(item.chunk.id, {
          chunk: item.chunk,
          score: contribution,
          denseRank: field === "denseRank" ? rank : null,
          lexicalRank: field === "lexicalRank" ? rank : null,
        });
      }
    });
  };

  add(dense, "denseRank");
  add(lexical, "lexicalRank");

  return [...merged.values()].sort((a, b) => b.score - a.score);
}

/**
 * Maximal marginal relevance. Similarity between candidates is computed with the
 * offline hashed embedding rather than the real one: it is free, synchronous, and
 * good enough to spot near-duplicate text, which is all this needs to do.
 * Paying for an extra embedding round-trip to deduplicate would be absurd.
 */
export function mmrSelect<T extends ScoredChunk>(candidates: T[], query: string, limit: number, lambda: number): T[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  const queryVector = hashEmbed(query);
  const vectors = new Map(candidates.map((candidate) => [candidate.id, hashEmbed(candidate.text)]));
  const relevanceToQuery = new Map(
    candidates.map((candidate) => [candidate.id, dot(vectors.get(candidate.id) ?? [], queryVector)]),
  );

  // Fused scores are tiny (~1/60); scaling relevance to [0,1] over the candidate
  // set keeps the lambda trade-off meaningful instead of always favouring one term.
  const scores = candidates.map((candidate) => candidate.fusedScore);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const span = maxScore - minScore || 1;

  const selected: T[] = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (!candidate) continue;
      const relevance = (candidate.fusedScore - minScore) / span;
      const queryAffinity = relevanceToQuery.get(candidate.id) ?? 0;
      const redundancy = selected.reduce(
        (max, chosen) => Math.max(max, dot(vectors.get(candidate.id) ?? [], vectors.get(chosen.id) ?? [])),
        0,
      );
      const value = lambda * (0.7 * relevance + 0.3 * queryAffinity) - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) selected.push(chosen);
  }

  return selected;
}

function dot(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/**
 * Only the top `seeds` hits get neighbours. Expanding all of them turned eight
 * sources into seventeen on the sample corpus, which is not "more context" but a
 * diluted prompt: the model has to find the answer among twice as much text, and
 * the budget starts evicting real hits in favour of adjacent filler.
 */
function expandNeighbours(
  repository: Repository,
  selected: ScoredChunk[],
  radius: number,
  seeds: number,
  titles: Map<string, { title: string; date: string | null }>,
): (ScoredChunk & { viaNeighbour: boolean })[] {
  const base = selected.map((chunk) => ({ ...chunk, viaNeighbour: false }));
  if (radius <= 0 || seeds <= 0 || selected.length === 0) return base;

  const have = new Set(selected.map((chunk) => chunk.id));
  const wanted = new Map<string, Set<number>>();
  for (const chunk of selected.slice(0, seeds)) {
    for (let offset = -radius; offset <= radius; offset += 1) {
      if (offset === 0) continue;
      const ordinal = chunk.ordinal + offset;
      if (ordinal < 0) continue;
      const id = `${chunk.meetingId}:${ordinal}`;
      if (have.has(id)) continue;
      const set = wanted.get(chunk.meetingId) ?? new Set<number>();
      set.add(ordinal);
      wanted.set(chunk.meetingId, set);
    }
  }

  const neighbours: (ScoredChunk & { viaNeighbour: boolean })[] = [];
  for (const [meetingId, ordinals] of wanted) {
    for (const chunk of repository.getNeighbourChunks(meetingId, [...ordinals])) {
      if (have.has(chunk.id)) continue;
      have.add(chunk.id);
      const meta = titles.get(chunk.meetingId);
      neighbours.push({
        ...chunk,
        denseRank: null,
        lexicalRank: null,
        // Ranked below every retrieved chunk: useful context, not evidence in its own right.
        fusedScore: 0,
        meetingTitle: meta?.title ?? "Unknown meeting",
        meetingDate: meta?.date ?? null,
        viaNeighbour: true,
      });
    }
  }

  return [...base, ...neighbours];
}

/**
 * Packs sources into the context budget, then orders them chronologically.
 *
 * Retrieved chunks arrive in relevance order, which is exactly the wrong order to
 * reason about a meeting in: "we agreed X" before "actually, not X" inverts the
 * outcome. Sorting by meeting and then by timestamp before labelling means the
 * S-numbers themselves run forwards in time, which visibly improved answers to
 * "what did we end up deciding".
 */
export function packWithinBudget(
  candidates: (ScoredChunk & { viaNeighbour: boolean })[],
  budget: number,
): { sources: Source[]; dropped: number } {
  // Retrieved chunks claim budget first; neighbours only fill what is left.
  const ordered = [...candidates].sort((a, b) => {
    if (a.viaNeighbour !== b.viaNeighbour) return a.viaNeighbour ? 1 : -1;
    return b.fusedScore - a.fusedScore;
  });

  const kept: (ScoredChunk & { viaNeighbour: boolean })[] = [];
  let used = 0;
  let dropped = 0;
  for (const candidate of ordered) {
    const cost = candidate.tokenCount + estimateTokens(candidate.meetingTitle) + 24; // 24 ≈ the source header line
    if (used + cost > budget && kept.length > 0) {
      dropped += 1;
      continue;
    }
    kept.push(candidate);
    used += cost;
  }

  kept.sort((a, b) => {
    if (a.meetingDate !== b.meetingDate) return (a.meetingDate ?? "9999").localeCompare(b.meetingDate ?? "9999");
    if (a.meetingId !== b.meetingId) return a.meetingId.localeCompare(b.meetingId);
    return (a.startMs ?? 0) - (b.startMs ?? 0) || a.ordinal - b.ordinal;
  });

  return {
    sources: kept.map((candidate, index) => ({ ...candidate, label: `S${index + 1}` })),
    dropped,
  };
}
