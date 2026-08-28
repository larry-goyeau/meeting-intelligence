/**
 * Domain vocabulary for the whole app. Kept free of any framework or vendor
 * type so the retrieval pipeline can be unit-tested without Next.js, without
 * a database and without network access.
 */

/** One contiguous stretch of speech by a single speaker. */
export interface Turn {
  /** Position in the transcript, 0-based. Stable identifier for deep links. */
  index: number;
  speaker: string;
  /** Milliseconds from the start of the meeting. Null when the source has no timestamps. */
  startMs: number | null;
  /** Inferred from the next turn's start, or estimated from speaking rate for the last turn. */
  endMs: number | null;
  text: string;
}

export interface ParsedTranscript {
  /** Title taken from a `Title:` header, otherwise derived from the filename by the caller. */
  title: string | null;
  /** ISO date (YYYY-MM-DD) taken from a `Date:` header when present. */
  date: string | null;
  participants: string[];
  turns: Turn[];
  /** The detected input format, surfaced in the UI so a bad parse is visible rather than silent. */
  format: TranscriptFormat;
  /** Non-fatal parsing problems. Shown to the user instead of being swallowed. */
  warnings: string[];
}

export type TranscriptFormat = "bracketed" | "speaker-first" | "vtt" | "srt" | "plain" | "unknown";

/** A retrieval unit: a window of consecutive turns. */
export interface Chunk {
  id: string;
  meetingId: string;
  /** Position within the meeting, used for neighbour expansion and chronological ordering. */
  ordinal: number;
  /** Speaker-labelled, timestamped text. This is what the model reads. */
  text: string;
  /** Meeting/speaker context prepended only for embedding, never shown to the user. */
  header: string;
  speakers: string[];
  startMs: number | null;
  endMs: number | null;
  firstTurnIndex: number;
  lastTurnIndex: number;
  tokenCount: number;
}

export interface ScoredChunk extends Chunk {
  denseRank: number | null;
  lexicalRank: number | null;
  /** Reciprocal-rank-fusion score. Not a probability, only meaningful for ordering. */
  fusedScore: number;
  meetingTitle: string;
  meetingDate: string | null;
}

/** A chunk selected for the prompt, with the label the model must cite ("S1", "S2", ...). */
export interface Source extends ScoredChunk {
  label: string;
  /** True when the chunk was pulled in as a neighbour rather than retrieved on its own merit. */
  viaNeighbour: boolean;
}

export type DecisionStatus = "agreed" | "tentative" | "reversed";

export interface Decision {
  decision: string;
  rationale: string | null;
  owner: string | null;
  status: DecisionStatus;
  atMs: number | null;
}

export interface ActionItem {
  task: string;
  owner: string | null;
  /** Free text as spoken ("end of next sprint"), not normalised into a date on purpose. */
  due: string | null;
  atMs: number | null;
}

export interface MeetingBrief {
  summary: string;
  topics: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: string[];
  /** Which pipeline produced this brief, so a mock-mode brief is never mistaken for a real one. */
  generatedBy: string;
}

export type MeetingSource = "sample" | "upload" | "audio";

export interface Meeting {
  id: string;
  title: string;
  date: string | null;
  source: MeetingSource;
  createdAt: string;
  durationMs: number | null;
  participants: string[];
  turnCount: number;
  chunkCount: number;
  tokenCount: number;
  format: TranscriptFormat;
  warnings: string[];
  brief: MeetingBrief | null;
}

export interface MeetingWithTurns extends Meeting {
  turns: Turn[];
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GuardrailVerdict {
  /** Fraction of answer sentences carrying at least one citation. */
  citationCoverage: number;
  /** Citations the model invented that point at no real source. Stripped before display. */
  invalidCitations: string[];
  /**
   * The model judged the evidence insufficient and said so. Tracked separately from
   * a gate refusal: this one cost a model call but is the more reliable of the two.
   */
  declined: boolean;
  flags: GuardrailFlag[];
}

export type GuardrailFlag =
  | "no-evidence"
  | "declined"
  | "low-citation-coverage"
  | "invalid-citations"
  | "out-of-scope"
  | "input-too-long"
  | "possible-injection-in-corpus";

export interface StageTiming {
  stage: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  embeddingTokens: number;
  /** USD, from a static price table. An estimate, clearly labelled as such in the UI. */
  estimatedCostUsd: number;
}

export interface Trace {
  id: string;
  createdAt: string;
  question: string;
  standaloneQuestion: string;
  meetingScope: string[];
  route: RetrievalRoute;
  sources: Source[];
  stages: StageTiming[];
  usage: Usage;
  totalMs: number;
  answer: string;
  verdict: GuardrailVerdict;
  provider: string;
  models: { chat: string; embedding: string };
}

/**
 * Not every question is a retrieval question. Routing is what keeps
 * "summarise the whole meeting" from being answered off eight chunks.
 */
export type RetrievalRoute = "retrieval" | "whole-meeting" | "refused";
