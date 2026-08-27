import { config } from "@/lib/config";
import { estimateTokens } from "@/lib/providers/tokens";
import type { Chunk, Turn } from "@/lib/types";
import { formatTimecode } from "./time";

/**
 * Chunking strategy.
 *
 * The unit of meaning in a meeting is the speaking turn, not the sentence and
 * definitely not a fixed character window. Three rules follow from that:
 *
 * 1. Never split mid-turn. Cutting a sentence in half between two chunks means
 *    neither chunk can answer a question about it. A turn is only split when it
 *    alone exceeds `maxTokens` (a monologue), and then on sentence boundaries.
 *
 * 2. Overlap in whole turns, sized in tokens. A decision is almost never inside
 *    one turn — someone proposes, someone objects, someone confirms. Repeating
 *    the tail turns of the previous chunk keeps that exchange intact in at least
 *    one chunk.
 *
 * 3. Carry attribution inside the text. Every line is rendered
 *    `[timestamp] Speaker: words`, so a retrieved chunk is self-describing: the
 *    model can attribute a claim and cite a timecode without extra plumbing.
 *
 * A `header` with the meeting title, date and speaker list is prepended for
 * embedding only. Without it, a chunk like "yes, let's do that" embeds into a
 * meaningless region of the space; with it, it at least lands near its meeting
 * and its participants. It is excluded from what the user sees, to keep
 * citations honest.
 */

export interface ChunkInput {
  meetingId: string;
  title: string;
  date: string | null;
  turns: Turn[];
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"'(\p{Lu}])/u;

function renderTurn(turn: Turn): string {
  const stamp = turn.startMs !== null ? `[${formatTimecode(turn.startMs, true)}] ` : "";
  return `${stamp}${turn.speaker}: ${turn.text}`;
}

/** Splits an over-long turn into sentence-aligned pieces that keep the speaker label. */
function splitLongTurn(turn: Turn, maxTokens: number): Turn[] {
  if (estimateTokens(turn.text) <= maxTokens) return [turn];
  const sentences = turn.text.split(SENTENCE_BOUNDARY);
  const pieces: Turn[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    pieces.push({ ...turn, text: buffer.join(" ") });
    buffer = [];
  };
  for (const sentence of sentences) {
    const candidate = [...buffer, sentence].join(" ");
    if (buffer.length > 0 && estimateTokens(candidate) > maxTokens) flush();
    buffer.push(sentence);
  }
  flush();
  return pieces.length > 0 ? pieces : [turn];
}

export function chunkTranscript(input: ChunkInput, options?: Partial<typeof config.chunking>): Chunk[] {
  const { targetTokens, overlapTokens, maxTokens } = { ...config.chunking, ...options };

  // Flatten monologues first so the windowing loop only deals with turns that fit.
  const units = input.turns.flatMap((turn) => splitLongTurn(turn, maxTokens));
  if (units.length === 0) return [];

  const header = buildHeader(input);
  const chunks: Chunk[] = [];
  let window: Turn[] = [];
  let windowTokens = 0;
  let ordinal = 0;

  const flush = () => {
    if (window.length === 0) return;
    chunks.push(materialise(input, header, window, ordinal));
    ordinal += 1;

    // Keep trailing turns worth up to `overlapTokens` as the start of the next window.
    const carried: Turn[] = [];
    let carriedTokens = 0;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const turn = window[i];
      if (!turn) continue;
      const cost = estimateTokens(renderTurn(turn));
      if (carriedTokens + cost > overlapTokens) break;
      carried.unshift(turn);
      carriedTokens += cost;
      // Never carry the entire window, or an over-long turn would loop forever.
      if (carried.length >= window.length) break;
    }
    window = carried.length < window.length ? carried : [];
    windowTokens = window.reduce((sum, turn) => sum + estimateTokens(renderTurn(turn)), 0);
  };

  for (const turn of units) {
    const cost = estimateTokens(renderTurn(turn));
    if (windowTokens > 0 && windowTokens + cost > targetTokens) flush();
    window.push(turn);
    windowTokens += cost;
  }
  if (window.length > 0) {
    chunks.push(materialise(input, header, window, ordinal));
  }

  // The overlap carry can make the final window a duplicate suffix of the previous one.
  return dedupeTrailingDuplicate(chunks);
}

function buildHeader(input: ChunkInput): string {
  const speakers = [...new Set(input.turns.map((turn) => turn.speaker))];
  const datePart = input.date ? ` on ${input.date}` : "";
  return `Meeting "${input.title}"${datePart}. Speakers: ${speakers.join(", ")}.`;
}

function materialise(input: ChunkInput, header: string, window: Turn[], ordinal: number): Chunk {
  const text = window.map(renderTurn).join("\n");
  const starts = window.map((turn) => turn.startMs).filter((value): value is number => value !== null);
  const ends = window.map((turn) => turn.endMs).filter((value): value is number => value !== null);
  const first = window[0];
  const last = window.at(-1);
  return {
    id: `${input.meetingId}:${ordinal}`,
    meetingId: input.meetingId,
    ordinal,
    text,
    header,
    speakers: [...new Set(window.map((turn) => turn.speaker))],
    startMs: starts.length > 0 ? Math.min(...starts) : null,
    endMs: ends.length > 0 ? Math.max(...ends) : null,
    firstTurnIndex: first?.index ?? 0,
    lastTurnIndex: last?.index ?? 0,
    tokenCount: estimateTokens(text),
  };
}

function dedupeTrailingDuplicate(chunks: Chunk[]): Chunk[] {
  if (chunks.length < 2) return chunks;
  const last = chunks.at(-1);
  const previous = chunks.at(-2);
  if (last && previous && previous.text.includes(last.text)) return chunks.slice(0, -1);
  return chunks;
}

/** Text actually sent to the embedding model. */
export function embeddingText(chunk: Pick<Chunk, "header" | "text">): string {
  return `${chunk.header}\n\n${chunk.text}`;
}
