# Meeting Intelligence

A conversational assistant over meeting transcripts. Ask what was decided, who owns
what, who disagreed, or whether a decision was later reversed — every claim links back
to the exact turn that supports it. Audio-to-transcript is included as the bonus.

![The workspace: corpus on the left, cited answer in the middle, evidence on the right](docs/screenshots/02-answer-with-sources.png)

## Run it

Requires Node 22.18+ (`node:sqlite`, native TypeScript for the CLI scripts). No
database to install, no vector service, no API key needed to try it.

```bash
npm install
npm run seed     # indexes the six sample transcripts in data/transcripts/
npm run dev      # http://localhost:3000
```

With no `OPENAI_API_KEY` the app runs **offline**: deterministic hashed embeddings and
extractive answering, no network, no cost. Everything is exercisable — ingestion,
hybrid retrieval, citations, traces — but answers are stitched excerpts rather than
prose. For real quality, `cp .env.example .env` and set `OPENAI_API_KEY`.

```bash
docker compose up --build     # http://localhost:3000

npm test          # 103 tests, always offline, no network
npm run eval      # retrieval quality against the hand-written answer key
npm run eval -- --answers     # also generates answers and grades citations
npm run gate      # calibrate the refusal signals for the active embedding model
npm run lint && npm run typecheck
npm run reset     # drop the local index
```

## What it does

**Ingest** by upload, paste, or audio. Six transcript shapes are parsed:
`[00:12:34] Speaker: text`, `Speaker: text`, `Speaker (00:12:34): text`, the Google
Meet export where `Leah Moreau 0:07` sits alone above what she said, WebVTT, SRT. The
detected format is shown in the UI, because a format that parses *almost* correctly is
the worst case.

![Ingestion: drop files, paste text, or transcribe audio](docs/screenshots/06-upload.png)

**At ingestion** each meeting gets a brief extracted once and stored: summary, topics,
decisions with status (`agreed` / `tentative` / `reversed`), action items with owner and
due date as spoken, open questions. At write time rather than per question, so "what
did we decide" is a lookup, not a re-reading of the transcript.

![The extracted brief, with a decision reversed a month later in another meeting](docs/screenshots/04-meeting-brief.png)

**Ask** in a conversation, optionally scoped to some meetings. Clicking a `[S1]`
citation opens the transcript at that turn, so any claim is checkable in two clicks.
**New conversation** resets the thread, because history feeds query rewriting: a stale
thread makes a bare "who owns it?" resolve against the wrong subject.

![Clicking a citation opens the transcript at the cited turn](docs/screenshots/05-transcript-viewer.png)

**Decline** in the interface, not only in the prose. Below, retrieval returned thirteen
excerpts — the question is close enough in shape to fool a similarity threshold — but
the model judged them insufficient, and the badge reports that as the outcome.

![A declined question, badged as having no answer in the sources](docs/screenshots/07-declined.png)

**Inspect** any answer: route, rewritten query, per-stage latency, candidates per
retriever, the signals behind a refusal, tokens, estimated cost.

![The trace inspector](docs/screenshots/03-trace-inspector.png)

## Why RAG here, and when not to

**Long-context is the right default for one meeting and the wrong one for this
product.** An hour-long meeting is 8–10k tokens; for a one-meeting tool I would send
the whole transcript and get better answers, with no chunking or retrieval bugs.

What breaks that is the question this product exists for. "Was that decision
reversed?" spans meetings weeks apart, and a team's quarter is 40+ meetings and 400k+
tokens. Cost and latency then scale with corpus size on *every* question, and accuracy
*falls*, because the reversal in meeting 12 competes with eleven meetings of noise.
Retrieval makes the cost of a question depend on the question, not on how long the team
has kept minutes. So both paths exist and the route is chosen per question
(`src/lib/rag/answer.ts`):

| Route | When | Why |
| --- | --- | --- |
| `whole-meeting` | 1–3 meetings, under 12k tokens, question about the meeting overall ("summarise", "all the action items") | Top-k loses by construction here: the answer is spread over the transcript, so any selection omits most of it |
| `retrieval` | Everything else | Cost and latency proportional to the question |
| `refused` | Nothing cleared the relevance gate | Below |

**No orchestration framework.** I considered LangChain and LlamaIndex and wrote the
pipeline directly. It is six stages I want to read and test without indirection, and
the parts carrying the quality — a reserved quota inside rank fusion, chronological
source ordering, neighbour expansion, a shared citation grammar — are exactly what I
would be overriding in a framework. At ten pipelines rather than one, I would revisit.

## RAG design

**Chunking: the speaking turn is the unit** (`src/lib/transcript/chunk.ts`). Fixed-size
character windows are wrong for conversation and fail invisibly. Never split mid-turn —
a sentence cut in two leaves neither half able to answer; a turn splits only above 520
tokens, on sentence bounds. Overlap in whole turns, budgeted in tokens (~320 target,
~60 overlap), because a decision is rarely one turn — propose, object, confirm — and
repeating the previous tail keeps that exchange intact somewhere. Every line carries
`[00:12:34] Speaker:`, so a chunk is self-describing and citations are verifiable by
construction. A meeting/speaker header is prepended **for embedding only** (without it
"yes, let's do that" embeds nowhere useful) and hidden from the user.

**Retrieval: hybrid, fused, diversified, widened** (`src/lib/rag/retrieve.ts`). Each
stage fixes a reproducible failure.

1. **Dense + BM25 in parallel.** Dense misses `MI-412` and surnames; BM25 misses "how
   are we handling scale" when the transcript says "throughput". Both fail often,
   rarely on the same query.
2. **Reciprocal rank fusion.** Cosine and BM25 are incomparable scales and normalising
   them means guessing a weight. RRF reads ranks only, so there is nothing to tune.
3. **MMR** (λ=0.7), since chunk overlap makes the top hits the same exchange three
   times.
4. **Neighbour expansion** (±1 chunk, top 3 hits) recovers the half of an exchange that
   fell below the cut. Limited to the strongest hits: expanding all turned 8 sources
   into 17, which is a diluted prompt, not more context.

Sources are then **ordered chronologically, not by score** — "we agreed X" arriving
after "actually, not X" inverts the outcome.

One fix worth naming, because the eval caught it and the answer was structural: RRF
rewards *appearing in both lists* over *being excellent in one*. The turn stating a
reversal outright was BM25's second hit by a wide margin but absent from the dense
top-k, so it landed at fused rank 11 and never reached the model — 50% recall there.
Reading BM25's scores would reintroduce the normalisation guesswork RRF avoids, so each
retriever gets a small **reserved quota** (`perRetrieverFloor=2`). That evicted another
case at 8 slots, so `finalK` went to 10. Both hold.

**Store: SQLite via `node:sqlite`** (`src/lib/store/`). Vectors are Float32 blobs,
cosine is a brute-force scan; FTS5 with the `porter` tokenizer gives BM25 in the same
file and transaction, kept in sync by triggers so no path can forget to reindex. This
is the choice I would defend hardest and also replace first: at this scale it beats a
real vector database — zero dependencies, one file to back up, reproducible in CI, and
a scan over a few thousand vectors is sub-millisecond, below the round-trip a hosted
index would add. It stops being right near 10⁵ chunks, and the repository is a narrow
interface (`denseSearch`, `lexicalSearch`, `documentFrequencies`) so that swap stays
contained.

**Models.** `text-embedding-3-small` (1536d) for quality per dollar — a transcript
corpus does not need `-large`. `gpt-4.1-mini` for the same reason: this task is
extraction and faithful attribution, not reasoning. Offline mode substitutes 512d
hashed vectors over unigrams and bigrams, so the pipeline runs deterministically with
no key.

## Grounding and refusal

`src/lib/rag/guardrails.ts` — the failure that destroys trust here is not an unsafe
answer but a confident invented one. There is nothing to moderate (the corpus is the
user's own meetings), so the guardrails target grounding:

- **No evidence → refuse before calling the model.** Free, and needs no judgement.
- **Invalid citations stripped and counted.** Models invent `[S14]` when ten sources
  were given; the count surfaces so it lends no false authority.
- **Citation coverage measured, not enforced.** Below 50% the UI warns. Rejecting the
  answer would trade a slightly ungrounded answer for none, which users like less.
- **Injection handled by framing, not filtering.** Sources are delimited and declared
  data; ingested text reading like instructions is flagged.

**Who decides "I don't know."** Top-k always returns k results however unrelated, so
refusal needs an absolute signal. I first built the decision as a threshold gate on
two: an absolute cosine floor, and specificity-weighted lexical coverage. Then I
measured whether a separating threshold exists (`npm run gate`). It does not:

```
dense     answerable min 0.221  refusable max 0.402  OVERLAPS by 0.181
coverage  answerable min 0.306  refusable max 0.691  OVERLAPS by 0.385
```

"What did we decide about the Kubernetes migration?" scores 0.402 — above eight
answerable questions — because the embedding is dominated by the *shape* of the
question, which matches this corpus exactly, not by the absent subject. So the design
follows the evidence: **the gate refuses only when there is nothing to reason about**
(nothing survived fusion, or no chunk cleared the floor) and **the model decides the
rest**, which it does correctly on every deferred case. `looksLikeDecline` then
recognises a decline so it is reported as one rather than filed as an answer that
forgot to cite. Deliberate trade: a hard refusal costs a model call and ~2 s where a
threshold was free — worth it, because the threshold refused real answers.

## Evaluation

`npm run eval` — 16 hand-written cases in `data/eval/golden.json`, against a throwaway
in-memory index. I did not want a score that looks authoritative while measuring
nothing, so it checks what an answer key can: **retrieval recall** (did the evidence
that must be present reach the prompt? — model-independent, and no prompt engineering
recovers from evidence never retrieved), **refusal correctness**, and with `--answers`
citation validity, coverage, latency and cost. Keyword presence is reported and
labelled a weak proxy, because that is what it is.

```
cases                  16
mean retrieval recall  100.0%      full recall  16/16
refusal correctness    16/16       (gate 0, model decline 1)
median retrieval       337 ms      median end-to-end  2596 ms
mean citation coverage 70.5%       (over 15 answers; 1 declined, nothing to cite)
invalid citations      0
keyword presence       93.8%       (weak proxy, not accuracy)
total estimated cost   $0.0311     (sixteen questions, answers included)
```

The harness exits non-zero below 0.8 recall, so it can gate a pipeline. Answers sample
at 0.2, so one run is not a measurement: across runs coverage ranged **60–78%** while
recall, refusal correctness and invalid citations were identical — quote the range.
Declines are excluded from the coverage average, having nothing to cite. Offline mode
reaches the same recall, but its refusal correctness is *reported, not enforced*:
hashed vectors score unrelated and relevant questions 0.15 against 0.20, carrying no
information.

Four cases come from a deliberately awful transcript — a real Google Meet export,
disfluent, bilingual, self-correcting, with numbers the speakers contradict themselves
on. Three check that uncertainty given is uncertainty reported: "4217 or 4219" must
stay ambiguous, and a +18% A/B result must arrive with its broken-link caveat.

![Answering over the noisy pasted transcript](docs/screenshots/08-noisy-transcript.png)

Measurement, not inspection, found every real bug here: citation markers parsed more
narrowly than the model writes them (coverage read 15%, then 0% on a different shape,
while answers were fully cited — and the same narrow pattern in the UI silently turned
citations into dead grey text); a test suite quietly running against the live API
whenever a key was exported; and a pasted transcript matching the wrong parser on the
colon inside a timecode, inventing 36 speakers and losing all 53 timestamps while
reporting success. Each is pinned by a test carrying the string that broke it.

## Architecture

```
Next.js 16 (App Router) — one process, server routes + React UI

src/lib/transcript/   parse (6 formats) → turns → chunk by speaking turn
src/lib/providers/    OpenAI-compatible | offline deterministic (same interface)
src/lib/store/        SQLite: chunks + Float32 vectors + FTS5 + traces
src/lib/rag/          ingest · retrieve · answer (routing) · brief · guardrails
src/app/api/          health · meetings · chat (NDJSON stream) · traces · transcribe
src/components/       workspace shell, chat, sources, brief, trace, transcript
```

The domain layer holds no framework or vendor types, which is why the retrieval
pipeline is unit-testable with no Next.js, no database file and no network.

**Observability** is not a dashboard: every request gets a trace id, structured
stage-level logs (`pretty` locally, `json` in production), and the full trace persisted
to SQLite and rendered in the UI. "Was it retrieval or generation?" is answerable in
one click, which is the only observability that shortens a debugging loop.

**Streaming** is NDJSON over `fetch`, not SSE: one `meta` event so source cards render
while tokens arrive, then `delta`s, then `done` (verdict, usage, timings).
Post-generation checks do not hold the stream back.

## Productionising it

The gap is mostly state, not code: the process is already stateless apart from SQLite.

| Concern | Local today | On AWS |
| --- | --- | --- |
| Store | SQLite file | Aurora Postgres + `pgvector`; hybrid stays one round-trip, and the repository interface is the seam |
| Transcripts, audio | local disk | S3, with the DB holding keys only |
| Ingestion | inline in the request | SQS + worker; embedding a 40-meeting upload does not belong in an HTTP request |
| App | `next start` | ECS Fargate behind an ALB, or Vercel; horizontal scaling is trivial once state leaves the process |
| Secrets | `.env` | Secrets Manager, rotated |
| Logs, traces | stdout + SQLite | OpenTelemetry → CloudWatch or Datadog, same trace id |
| Cost | printed per answer | per-tenant budgets and rate limits, enforced before the model call |

Four things need real work beyond lifting and shifting. **Multi-tenancy**: transcripts
are among the most sensitive documents a company has, so isolation belongs at the row
level with a tenant id on every query and per-tenant keys — retrofitting that is far
worse than starting with it. **Auth and audit**: SSO, and a record of who asked what.
**Caching**: question embeddings and briefs are both cacheable, and repeat questions
are common here. **Retrieval eval in CI** on every prompt or chunking change — the
harness already exits non-zero, so this is wiring, and it is what stops a silent
quality regression reaching users. Cheaper at scale: batch embeddings at ingestion, and
route brief extraction to a smaller model than the one answering.

## Engineering standards

**Followed.** TypeScript strict, no `any` in the domain layer, and no framework or
vendor types there either — that is what makes it testable without a server. Provider
access goes through one interface with two implementations, so offline mode is a real
code path rather than a mock. 103 tests over parsing, chunk boundaries, fusion/MMR/
budget packing, guardrails and citation grammar, plus integration tests that ingest,
retrieve, stream and assert a trace was written; forced offline in `vitest.config.mts`,
so they are deterministic, free, and fail for one reason only. Lint and typecheck
clean. Structured logs with a trace id per request. Comments explain why, not what.
Secrets out of the repo, image non-root and multi-stage.

**Skipped, knowingly.** No auth or multi-tenancy — right for a local tool,
disqualifying for a deployment, first on the list above. No CI config, though every
gate it would run exists as a script. No migrations: the schema is created on open,
fine while every deployment is a fresh one. No E2E browser suite; Playwright captures
screenshots, it does not assert. No coverage threshold — I would rather have six test
files pinning real bugs than a number. Token counting is `chars / 4`, not a real
tokenizer: budgets are labelled estimates and the ceiling has slack for that. No
accessibility audit beyond keyboard paths and semantic controls.

## What I would do next, in order

1. **Cross-encoder reranking** over the fused candidates — the standard precision win,
   and it removes the need to tune `finalK`. Left out because the eval set does not yet
   show the failure it fixes, and adding it without a metric that moves is decoration.
2. **Postgres + pgvector**, hybrid scoring in one SQL round-trip.
3. **LLM-as-judge grading**, pairwise against reference answers, replacing keyword
   presence with something that measures answer quality rather than proxying it.
4. **Speaker diarisation** on the audio path — transcription produces text without
   reliable speaker labels, the weakest link in that flow.
5. **Multi-tenant isolation and auth**, per above.
6. **Incremental re-embedding** on chunk-strategy changes instead of full re-ingestion.

## Known limitations

- Offline mode cannot judge relevance well enough to refuse reliably (measured above).
- Refusal on hard cases costs a model call, because the cheap signals provably cannot
  make it. A classifier over the retrieved evidence would win it back.
- `looksLikeDecline` matches patterns in the first sentence and errs towards
  under-detection: an unusual phrasing is reported as low coverage instead.
- Cosine similarity is a full scan: fine to ~10⁵ chunks, then it needs an index.
- The final turn's end timestamp is estimated from speaking rate, since nothing follows
  it to bound.
- Transcripts without timestamps are indexed and cited by turn, but citations cannot
  deep-link to a time that was never recorded.
- Cost figures are estimates from a static price table, and labelled as such.
- The brief is extracted once at ingestion: cheap lookups, but a schema change means
  re-ingesting.
