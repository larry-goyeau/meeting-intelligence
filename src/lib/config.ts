import path from "node:path";

/**
 * All tunables in one place, read once. Every knob that affects retrieval
 * quality is overridable from the environment so an evaluation run can sweep
 * it without touching code.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

/**
 * The bundler traces filesystem calls to decide what to ship. `path.join` with a
 * literal subpath keeps that trace scoped to `data/`; the env-driven data
 * directory is opted out explicitly because it only ever exists at runtime.
 */
const sampleDir = path.join(process.cwd(), "data", "transcripts");
const dataDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), str("DATA_DIR", ".data"));

export const config = {
  dataDir,
  dbPath: path.join(dataDir, "meetings.db"),
  uploadsDir: path.join(dataDir, "uploads"),
  sampleDir,

  provider: {
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
    chatModel: str("CHAT_MODEL", "gpt-4.1-mini"),
    embeddingModel: str("EMBEDDING_MODEL", "text-embedding-3-small"),
    transcriptionModel: str("TRANSCRIPTION_MODEL", "whisper-1"),
    /** Hard ceiling so a runaway loop cannot bill a fortune. */
    maxOutputTokens: num("MAX_OUTPUT_TOKENS", 1200),
    requestTimeoutMs: num("PROVIDER_TIMEOUT_MS", 60_000),
  },

  chunking: {
    targetTokens: num("CHUNK_TARGET_TOKENS", 320),
    overlapTokens: num("CHUNK_OVERLAP_TOKENS", 60),
    /** A single turn longer than this is split on sentence boundaries. */
    maxTokens: num("CHUNK_MAX_TOKENS", 520),
  },

  retrieval: {
    denseK: num("RETRIEVAL_DENSE_K", 24),
    lexicalK: num("RETRIEVAL_LEXICAL_K", 24),
    /**
     * Raised from 8 after the evaluation set showed two cases competing for the
     * last slot: at 8, fixing "which decision was reversed" broke
     * "which database did we choose". 10 holds both, at ~3.2k prompt tokens.
     */
    finalK: num("RETRIEVAL_FINAL_K", 10),
    /** RRF constant. 60 is the value from the original paper; not tuned here. */
    rrfK: num("RETRIEVAL_RRF_K", 60),
    mmrLambda: num("RETRIEVAL_MMR_LAMBDA", 0.7),
    /**
     * Slots reserved for each retriever's own top hits, before fusion decides the
     * rest. Guards against rank fusion discarding a chunk that one retriever is
     * highly confident about purely because the other never saw it.
     *
     * 2 is the smallest value that reaches full recall on the evaluation set;
     * larger values reserve slots fusion could spend better.
     */
    perRetrieverFloor: num("RETRIEVAL_PER_RETRIEVER_FLOOR", 2),
    neighborRadius: num("RETRIEVAL_NEIGHBOR_RADIUS", 1),
    contextTokenBudget: num("CONTEXT_TOKEN_BUDGET", 6000),
    /**
     * Absolute cosine floor for dense hits.
     *
     * Without this, "no evidence" can never happen: a top-k search always returns
     * k results, however unrelated, and rank fusion then hands them a respectable
     * score. The floor is what makes refusal possible. The value has to differ by
     * embedding model, because "unrelated" sits at a different similarity in each
     * space: around 0.0-0.15 for text-embedding-3-small, much lower for the
     * offline hashed vectors, which are sparse and near-orthogonal by construction.
     */
    minDenseSimilarity: num("RETRIEVAL_MIN_DENSE_SIMILARITY", process.env.OPENAI_API_KEY ? 0.18 : 0.05),
    /** Secondary gate on the fused score, for candidates that clear the dense floor but only barely. */
    minFusedScore: num("RETRIEVAL_MIN_SCORE", 0.008),
    /** Only the strongest hits get their neighbours pulled in, or the prompt fills with context. */
    neighborSeeds: num("RETRIEVAL_NEIGHBOR_SEEDS", 3),
  },

  guardrails: {
    maxQuestionChars: num("MAX_QUESTION_CHARS", 2000),
    /** Under this share of cited sentences the UI shows a "verify this" warning. */
    minCitationCoverage: num("MIN_CITATION_COVERAGE", 0.5),
    /** A meeting under this size is answered from the full transcript, no retrieval. */
    wholeMeetingTokenCeiling: num("WHOLE_MEETING_TOKEN_CEILING", 12_000),
  },

  observability: {
    /** Traces are kept in SQLite; this caps what the inspector lists. */
    traceListLimit: num("TRACE_LIST_LIMIT", 50),
    logFormat: str("LOG_FORMAT", "pretty") === "json" ? ("json" as const) : ("pretty" as const),
  },
} as const;

export const hasRemoteProvider = config.provider.apiKey.length > 0;
