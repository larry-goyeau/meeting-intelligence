import { createLogger, timed } from "@/lib/logger";
import { getProviders } from "@/lib/providers";
import { estimateTokens } from "@/lib/providers/tokens";
import { checksumOf, Repository, type MeetingRecord } from "@/lib/store/repository";
import { chunkTranscript, embeddingText } from "@/lib/transcript/chunk";
import { parseTranscript } from "@/lib/transcript/parse";
import type { Meeting, MeetingSource, StageTiming } from "@/lib/types";
import { detectInjectionAttempts } from "./guardrails";
import { emptyBrief, generateBrief } from "./brief";

/**
 * Ingestion: raw text in, searchable meeting out.
 *
 * parse → chunk → embed → persist → extract brief. The brief is generated after
 * the meeting is already queryable, so a failure there costs the summary panel
 * and nothing else.
 */

export interface IngestInput {
  filename: string;
  content: string;
  source: MeetingSource;
  /** Overrides the parsed header, for the upload form. */
  title?: string;
  date?: string;
}

export interface IngestResult {
  meeting: Meeting;
  stages: StageTiming[];
  reused: boolean;
  warnings: string[];
}

export async function ingestTranscript(input: IngestInput, repository = new Repository()): Promise<IngestResult> {
  const logger = createLogger(undefined, { filename: input.filename });
  const stages: StageTiming[] = [];
  const providers = getProviders();

  const checksum = checksumOf(input.content);
  const existing = repository.findByChecksum(checksum);
  if (existing) {
    // Same bytes, same meeting. Re-embedding would burn tokens and duplicate chunks.
    logger.info("ingest.deduplicated", { meetingId: existing.id });
    const { transcript: _t, turns: _u, checksum: _c, ...meeting } = existing;
    return { meeting, stages, reused: true, warnings: ["This transcript is already indexed; showing the existing copy."] };
  }

  const parsed = await timed(stages, "parse", async () => parseTranscript(input.content), (result) => ({
    turns: result.turns.length,
    format: result.format,
  }));

  if (parsed.turns.length === 0) {
    throw new IngestError("No dialogue could be extracted from this file. Expected lines like `[00:01:23] Alice: ...`.");
  }

  const meetingId = crypto.randomUUID();
  const title = input.title?.trim() || parsed.title?.trim() || titleFromFilename(input.filename);
  // Exported transcripts are almost always named by date, and the date matters:
  // it is what orders sources chronologically, which is what makes "was this
  // decision later reversed" answerable.
  const date = input.date?.trim() || parsed.date || dateFromFilename(input.filename);

  const chunks = await timed(
    stages,
    "chunk",
    async () => chunkTranscript({ meetingId, title, date, turns: parsed.turns }),
    (result) => ({ chunks: result.length, avgTokens: Math.round(average(result.map((chunk) => chunk.tokenCount))) }),
  );

  const { vectors } = await timed(
    stages,
    "embed",
    () => providers.embeddings.embed(chunks.map(embeddingText)),
    (result) => ({ vectors: result.vectors.length, tokens: result.tokens, model: providers.embeddings.model }),
  );

  const warnings = [...parsed.warnings];
  const injections = detectInjectionAttempts(input.content);
  if (injections.length > 0) {
    // Not blocked: a participant may legitimately have been talking about prompt
    // injection. Flagged so it is visible if an answer later looks manipulated.
    warnings.push("This transcript contains text that resembles prompt instructions. It is treated as data, but check answers that draw on it.");
    logger.warn("ingest.injection_pattern", { patterns: injections });
  }

  const lastTurn = parsed.turns.at(-1);
  const record: MeetingRecord = {
    id: meetingId,
    title,
    date: date ?? null,
    source: input.source,
    createdAt: new Date().toISOString(),
    durationMs: lastTurn?.endMs ?? lastTurn?.startMs ?? null,
    participants: parsed.participants,
    turnCount: parsed.turns.length,
    chunkCount: chunks.length,
    tokenCount: estimateTokens(input.content),
    format: parsed.format,
    warnings,
    brief: null,
    transcript: input.content,
    turns: parsed.turns,
    checksum,
  };

  await timed(stages, "persist", async () =>
    repository.saveMeeting(record, chunks, vectors, providers.embeddings.model),
  );

  // Queryable from here on. The brief is best-effort.
  let brief = emptyBrief(providers.remote ? providers.chat.model : "offline heuristics (no LLM)");
  try {
    const result = await timed(
      stages,
      "brief",
      () => generateBrief(renderForBrief(record), { title, date: date ?? null }),
      (value) => ({
        segments: value.segments,
        decisions: value.brief.decisions.length,
        actions: value.brief.actionItems.length,
      }),
    );
    brief = result.brief;
    repository.updateBrief(meetingId, brief);
  } catch (error) {
    logger.warn("ingest.brief_failed", { message: error instanceof Error ? error.message : "unknown" });
    warnings.push("The meeting brief could not be generated. Question answering is unaffected.");
  }

  logger.info("ingest.done", {
    meetingId,
    turns: parsed.turns.length,
    chunks: chunks.length,
    totalMs: stages.reduce((sum, stage) => sum + stage.ms, 0),
  });

  const { transcript: _t, turns: _u, checksum: _c, ...meeting } = record;
  return { meeting: { ...meeting, brief, warnings }, stages, reused: false, warnings };
}

/**
 * The brief reads the normalised transcript rather than the raw upload, so
 * extraction sees consistent `[hh:mm:ss] Speaker: text` lines whatever the input
 * format was. That is what lets it report reliable timestamps.
 */
function renderForBrief(record: MeetingRecord): string {
  return record.turns
    .map((turn) => {
      const stamp = turn.startMs !== null ? `[${msToClock(turn.startMs)}] ` : "";
      return `${stamp}${turn.speaker}: ${turn.text}`;
    })
    .join("\n");
}

function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function dateFromFilename(filename: string): string | null {
  const match = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(filename);
  if (!match) return null;
  const [, year, month, day] = match;
  const candidate = `${year}-${month}-${day}`;
  return Number.isNaN(new Date(candidate).getTime()) ? null : candidate;
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const withoutLeadingDate = base.replace(/^\d{4}[-\s]\d{2}[-\s]\d{2}\s*/, "");
  const cleaned = (withoutLeadingDate || base).trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}
