# Meeting Intelligence

A conversational assistant over meeting transcripts. Ask what was decided, who owns
what, who disagreed, or whether a decision was later reversed — and get an answer
where every claim links back to the exact turn in the transcript that supports it.

Built for the "Meeting Intelligence System" option: transcripts with speaker labels
and timestamps, questions about discussions, decisions and action items, accurate
timestamped citations.

![The workspace: corpus on the left, cited answer in the middle, evidence on the right](docs/screenshots/02-answer-with-sources.png)

---

## Run it

Requires Node 22.18+ — `node:sqlite` for the store, and native TypeScript execution
for the CLI scripts. Node 24 is what the Docker image uses. No database to install,
no vector service to provision, no API key needed to try it.

```bash
npm install
npm run seed     # indexes the five sample transcripts in data/transcripts/
npm run dev      # http://localhost:3000
```

With no `OPENAI_API_KEY` the app runs in **offline mode**: deterministic hashed
embeddings and extractive answering, no network calls, no cost. Everything is
exercisable — ingestion, hybrid retrieval, citations, the trace inspector — but the
answers are stitched-together excerpts rather than prose. For real answer quality:

```bash
cp .env.example .env   # then set OPENAI_API_KEY
```

Docker, if you prefer:

```bash
docker compose up --build     # http://localhost:3000
```

Other commands:

```bash
npm test          # 88 unit + integration tests, offline, no network
npm run eval      # retrieval quality against the hand-written answer key
npm run eval -- --answers   # also generates answers and grades citations
npm run lint && npm run typecheck
npm run reset     # drop the local index
```

---

## What it does

**Ingest** a transcript by upload, paste, or audio file. Five input shapes are
parsed: `[00:12:34] Speaker: text`, `Speaker: text`, WebVTT, SRT, and speaker-only
notes with no timestamps at all. The detected format is shown in the UI, so a bad
parse is visible rather than silent.

![Ingestion: drop files, paste text, or transcribe audio](docs/screenshots/06-upload.png)

**At ingestion**, each meeting gets a structured brief extracted once and stored:
summary, topics, decisions with status (`agreed` / `tentative` / `reversed`), action
items with owner and due date as spoken, and open questions. Doing this at write
time rather than per question means "what did we decide" is a lookup, not a
re-reading of the transcript.

![The extracted brief, with the reversal detected across two meetings](docs/screenshots/04-meeting-brief.png)

**Ask** questions in a conversation, optionally scoped to a subset of meetings.
Every assertion carries a `[S1]`-style citation; clicking one opens the transcript
scrolled to that turn and highlights it, so any claim can be checked in two clicks.

![Clicking a citation opens the transcript at the cited turn](docs/screenshots/05-transcript-viewer.png)

**Inspect** any answer. The trace panel shows the route taken, the rewritten query,
per-stage latency, how many candidates each retriever produced, the relevance
signals behind a refusal, token counts and estimated cost.

![The trace inspector](docs/screenshots/03-trace-inspector.png)

---

## The core decision: why RAG here

The brief asks for the reasoning, so: **long-context prompting is the right default
for one meeting, and the wrong one for this product.**

A single hour-long meeting is roughly 8–10k tokens. That fits any modern context
window several times over, and for a one-meeting product I would simply send the
transcript — no chunking, no embeddings, no vector store, no retrieval bugs, and
better answers, because the model sees everything.

What breaks that is the question this product exists to answer. "Was that decision
reversed?" spans meetings weeks apart. A team's quarter is 40+ meetings, 400k+
tokens, and it only grows. Three things then go wrong at once: cost scales linearly
with corpus size on *every* question; latency goes with it; and accuracy actually
*falls*, because a decision reversed in meeting 12 competes for attention with
eleven meetings of irrelevant context.

So retrieval is not a workaround for a small context window. It is what makes the
cost of a question depend on the question rather than on how long the team has been
keeping minutes.

The system keeps both paths, and picks per question (`src/lib/rag/answer.ts`):

| Route | When | Why |
| --- | --- | --- |
| `whole-meeting` | 1–3 meetings selected, under 12k tokens total, and either the question is about the meeting overall ("summarise", "all the action items", "walk me through") or the transcript fits the budget comfortably | Top-k retrieval loses by construction on "summarise this" — the answer is spread over the whole transcript, so any selection omits most of it |
| `retrieval` | Everything else | Cost and latency proportional to the question, not the corpus |
| `refused` | Nothing cleared the relevance gate | See guardrails |

This felt like the honest answer to "would long-context work instead?" — sometimes
yes, and the system should use it then, rather than pretending retrieval is always
superior.

---

## RAG design

### Chunking: the speaking turn is the unit

`src/lib/transcript/chunk.ts`

Fixed-size character windows are wrong for conversation, and cheap to get wrong in a
way that is invisible until you read the retrieved text. Three rules:

1. **Never split mid-turn.** A sentence cut across two chunks leaves neither able to
   answer a question about it. A turn is split only if it alone exceeds 520 tokens
   (a monologue), and then on sentence boundaries.
2. **Overlap in whole turns, budgeted in tokens** (~320 target, ~60 overlap). A
   decision is almost never one turn: someone proposes, someone objects, someone
   confirms. Repeating the previous chunk's tail turns keeps that exchange intact
   in at least one chunk.
3. **Attribution inside the text.** Every line is `[00:12:34] Speaker: words`, so a
   retrieved chunk is self-describing — the model can attribute a claim and quote a
   timecode with no extra plumbing, and the citation is verifiable by construction.

A meeting/speaker header is prepended **for embedding only**. Without it, a chunk
like "yes, let's do that" embeds into a meaningless region of the space. It is
excluded from what the user sees, so citations stay honest.

### Retrieval: hybrid, fused, diversified, then widened

`src/lib/rag/retrieve.ts`

Four stages, each added to fix a failure I could reproduce on the sample corpus:

1. **Dense + BM25 in parallel.** Dense alone misses `MI-412` and surnames; BM25
   alone misses "how are we handling scale" when the transcript says "throughput"
   and "load". Meeting language is informal enough that both fail often, but rarely
   on the same query.
2. **Reciprocal rank fusion.** Cosine and BM25 live on incomparable scales, and
   normalising them means choosing a weight by guesswork. RRF reads only ranks, so
   there is nothing to tune and neither signal can be drowned out by the other's
   scale.
3. **MMR** (λ=0.7) for diversity. Chunk overlap means the top hits for "what did we
   decide about the database" are often the same exchange three times over.
4. **Neighbour expansion** (±1 chunk, top 3 hits only). This is the
   conversational-data fix: it recovers the half of an exchange that fell just below
   the cut. Limited to the strongest hits — expanding all of them turned 8 sources
   into 17, which is not "more context" but a diluted prompt.

Sources are then **ordered chronologically, not by score**, before being labelled.
"We agreed X" arriving after "actually, not X" inverts the outcome; making the
S-numbers run forwards in time visibly improved answers about what was finally
decided.

#### One fix worth describing, because the evaluation set caught it

RRF has a known bias: it rewards *appearing in both lists* over *being excellent in
one*. On "was any earlier decision reversed later", the turn that states the
reversal outright — "We are reversing the fifteenth of January decision to run
pgvector on the primary RDS instance" — is BM25's **second** hit by a wide margin
(3.40, against 0.66 for the fourth). But it is absent from the dense top-k, so it
earns a single `1/(60+2)` contribution and lands at fused rank **11**, behind chunks
that are 18th and 11th in the two lists yet collect two contributions each. With
`finalK=8`, the sentence containing the answer never reached the model. Retrieval
recall on that case: 50%.

Reading BM25's *scores* instead of its ranks would fix it, but that reintroduces
exactly the normalisation guesswork RRF is used to avoid. Instead, each retriever
gets a small **reserved quota** (`perRetrieverFloor=2`): fusion decides most slots,
but either retriever can insist on the handful of hits it is most confident about.

That alone traded one failure for another — with 8 slots, guaranteeing the reversal
chunk evicted the evidence for "which database did we choose". The two cases were
competing for the last slot, so `finalK` went to 10 (~3.2k prompt tokens, well
inside budget). Both hold now. This is in the README because the sequence is the
point: the metric found it, and the fix is a design change with a stated trade-off
rather than a tuned constant.

### Embeddings and the vector store

`src/lib/store/db.ts`, `src/lib/store/repository.ts`

**SQLite, via Node's built-in `node:sqlite`.** Vectors are Float32 blobs; cosine
similarity is a brute-force scan in JS. FTS5 with the `porter` tokenizer provides
BM25 in the same file and the same transaction, kept in sync by triggers so no code
path can forget to reindex.

This is the choice I would defend hardest and also the first I would replace. At
this scale it is *better* than a real vector database: zero dependencies, zero
setup, one file to back up, trivially reproducible in CI, and a brute-force scan
over a few thousand vectors is sub-millisecond — far below the network round-trip a
hosted index would add. It stops being right at roughly 10⁵ chunks, where the scan
becomes the bottleneck. The repository is a narrow interface (`denseSearch`,
`lexicalSearch`, `documentFrequencies`) precisely so that swap is contained;
Postgres with `pgvector` would keep the hybrid query in one round-trip and is where
I would go next, not a dedicated vector service.

Embeddings are `text-embedding-3-small` (1536d) — the quality-per-dollar choice; a
transcript corpus does not need `-large`. Offline mode substitutes 512d hashed
vectors over word unigrams and bigrams, so the whole pipeline runs deterministically
with no key. Bigrams matter even in the mock: "postpone migration" should not look
like "postpone standup".

---

## Grounding, and how refusal is made possible

`src/lib/rag/guardrails.ts`

The failure that destroys trust in a meeting assistant is not an unsafe answer, it
is a confident invented one. There is no content to moderate here — the corpus is
the user's own meetings — so the guardrails target grounding:

- **No evidence → refuse before calling the model.** Cheaper and far more reliable
  than hoping the model declines on its own.
- **Invalid citations are stripped and counted.** Models invent `[S14]` when ten
  sources were given; the count surfaces in the UI so it lends no false authority.
- **Citation coverage is measured, not enforced.** Below 50% the UI shows a "verify
  this" banner. Rejecting the answer instead would trade a slightly ungrounded
  answer for no answer, which users like less than a flagged one.
- **Injection is handled by framing, not filtering.** A transcript can contain
  anything someone said out loud. Sources are delimited and declared to be data;
  ingested text that reads like instructions is flagged at ingestion.

The non-obvious part is making "I don't know" *reachable at all*. A top-k search
always returns k results however unrelated, and rank fusion then hands them
respectable-looking scores. So refusal needs an absolute signal, and the gate uses
two independent ones, refusing only when both say no:

- an **absolute cosine floor** on the best dense hit, and
- **specificity-weighted lexical coverage**: how much of the query's vocabulary
  actually appears in the retrieved text, weighting rare terms above common ones.

Two signals rather than one because each covers the other's blind spot. A correctly
paraphrased question ("why are the counts fuzzy?") shares no vocabulary with the
transcript and would be refused by coverage alone; a question in the corpus's own
words but semantically off would slip past the cosine floor.

---

## Evaluation

`npm run eval` — 12 hand-written cases in `data/eval/golden.json`, run against a
throwaway in-memory index so it never touches the dev corpus.

I did not want a score that looks authoritative while measuring nothing, so this
measures what can be checked against an answer key:

- **Retrieval recall** — did the evidence that *must* be present to answer actually
  reach the prompt? This is the metric that matters, because no prompt engineering
  recovers from evidence that was never retrieved. It is also model-independent, so
  it is meaningful in offline mode.
- **Refusal correctness** — on questions the corpus cannot answer, did it decline?
- With `--answers`: citation validity, citation coverage, latency, cost. Keyword
  presence is reported too and **labelled a weak proxy**, because that is what it
  is.

Current, offline mode, over the 5-meeting / 30-chunk sample corpus:

```
cases                  12
mean retrieval recall  100.0%
full recall            12/12
refusal correctness    11/12   (reported only — see below)
median retrieval       3 ms
mean citation coverage 100.0%
invalid citations      0
```

The harness exits non-zero below a 0.8 recall floor, so it can gate a pipeline.

**The one failure, stated plainly.** One "unanswerable" case ("what is the company's
parental leave policy?") is not refused in offline mode, and refusal correctness is
therefore *reported but not enforced* unless a real embedding model is configured.
The reason is the offline stand-in, not the gate: hashed n-gram vectors score an
unrelated question at ~0.15 and a relevant one at ~0.20, so no cosine threshold
separates them, and lexical coverage alone has to carry the decision — which it
cannot, because that question shares "policy", "leave" and "company" with a corpus
that discusses retention policies. Failing CI over a limitation of the mock would
only teach us to lower the bar. With a real embedding model both signals work and
the case refuses correctly.

---

## Architecture

```
Next.js 16 (App Router) — one process, server routes + React UI

src/lib/transcript/   parse (5 formats) → turns → chunk by speaking turn
src/lib/providers/    OpenAI-compatible | offline deterministic (same interface)
src/lib/store/        SQLite: chunks + Float32 vectors + FTS5 + traces
src/lib/rag/          ingest · retrieve · answer (routing) · brief · guardrails
src/app/api/          health · meetings · chat (NDJSON stream) · traces · transcribe
src/components/       workspace shell, chat, sources, brief, trace, transcript
```

The domain layer holds no framework or vendor types, which is why the retrieval
pipeline is unit-testable with no Next.js, no database file and no network.

**Observability** is not a dashboard: every request gets a trace id, structured
stage-level logs (`pretty` locally, `json` in production), and the full trace
persisted to SQLite and rendered in the UI. When an answer looks wrong, the question
"was it retrieval or generation?" is answerable in one click, which is the only
observability that actually shortens a debugging loop.

**Streaming** is NDJSON over `fetch`, not SSE: one `meta` event (route, sources) so
source cards render while tokens are still arriving, then `delta`s, then `done`
(verdict, usage, timings). Post-generation checks do not hold the stream back.

**Tests** — 88 across 6 files: parsing per format, chunk boundaries and overlap,
fusion/MMR/budget-packing (including a regression test for the RRF bias above),
guardrails, and integration tests that ingest, retrieve, stream and assert a trace
was recorded. All offline and deterministic.

---

## Trade-offs I made deliberately

**Token counting is `chars / 4`, not a real tokenizer.** Budgets are approximate and
labelled as estimates. A tokenizer dependency to make a heuristic budget 5% tighter
is not worth it; the ceiling has slack for exactly this reason.

**No reranker.** A cross-encoder over the top ~30 candidates is the highest-value
next addition, and I left it out because it would be a second model to host and the
evaluation set does not currently show the failure it fixes. Adding it without a
metric that moves would be decoration.

**The brief is extracted once at ingestion, not per query.** Cheap lookups and
stable results, but a schema change means re-ingesting. Right trade for a read-heavy
product.

**Whole-meeting answers use a map-reduce over chunks** when a transcript exceeds the
ceiling — slower and more expensive than one pass, and the only honest way to
summarise something that does not fit.

**Conversation history is passed for rewriting, not embedded.** Query rewriting
costs a round-trip only when history exists.

---

## What I would do next, in order

1. **Cross-encoder reranking** over the fused candidates — the standard biggest
   precision win, and it removes the need to tune `finalK` at all.
2. **Postgres + pgvector**, with hybrid scoring in one SQL round-trip. The
   repository interface exists to make this a contained change.
3. **LLM-as-judge grading** against reference answers, pairwise, to replace keyword
   presence with something that measures answer quality rather than proxying it.
4. **Speaker diarisation** on the audio path. Transcription currently produces text
   without reliable speaker labels, which is the weakest link in that flow.
5. **Multi-tenant isolation and auth.** Meeting transcripts are among the most
   sensitive documents a company has; today the corpus is single-tenant and
   unauthenticated, which is fine for a local tool and not fine for a deployment.
6. **Incremental re-embedding** on chunk-strategy changes, instead of full
   re-ingestion.

## Known limitations

- Offline mode cannot judge relevance well enough to refuse reliably (measured and
  explained above). Set an API key for real behaviour.
- Cosine similarity is a full scan: fine to ~10⁵ chunks, then it needs an index.
- Timestamps for the final turn of a transcript are estimated from speaking rate,
  since nothing follows it to bound the end.
- Transcripts with no timestamps at all (the standup notes sample) are indexed and
  cited by turn, but citations cannot deep-link to a time that was never recorded.
- Cost figures are estimates from a static price table, and labelled as such.
