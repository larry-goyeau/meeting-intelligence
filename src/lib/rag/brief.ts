import { z } from "zod";
import { getProviders } from "@/lib/providers";
import { estimateTokens } from "@/lib/providers/tokens";
import type { MeetingBrief } from "@/lib/types";
import { BRIEF_REDUCE_SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT, buildBriefMapPrompt } from "./prompts";

/**
 * Structured extraction at ingest time.
 *
 * "What did we decide?" and "what are my action items?" are the two questions
 * people actually ask a meeting tool, and both are badly served by retrieval:
 * the answer is a complete list, and top-k gives a sample. Extracting them once
 * when the transcript arrives turns them into a lookup — consistent between
 * asks, and instant.
 *
 * Long transcripts are handled map-reduce: extract per segment, then merge. The
 * merge step is what catches a decision that was made and later undone, which a
 * single-pass extraction over segments would report twice, contradictorily.
 */

const decisionSchema = z.object({
  decision: z.string().min(1),
  rationale: z.string().nullish().transform((value) => value ?? null),
  owner: z.string().nullish().transform((value) => value ?? null),
  status: z.enum(["agreed", "tentative", "reversed"]).catch("agreed"),
  atMs: z.number().nullish().transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : null)),
});

const actionItemSchema = z.object({
  task: z.string().min(1),
  owner: z.string().nullish().transform((value) => value ?? null),
  due: z.string().nullish().transform((value) => value ?? null),
  atMs: z.number().nullish().transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : null)),
});

/**
 * Everything is lenient on purpose. A model that returns `"owner": ""` or omits
 * `topics` should cost us that one field, not the whole brief — the brief is a
 * convenience layer, and retrieval still answers the question without it.
 */
const briefPayloadSchema = z.object({
  summary: z.string().default(""),
  topics: z.array(z.string()).default([]),
  decisions: z.array(decisionSchema).default([]),
  actionItems: z.array(actionItemSchema).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type BriefPayload = z.infer<typeof briefPayloadSchema>;

/** Tolerates a model that wraps JSON in prose or a fenced block. */
export function parseBriefPayload(raw: string): BriefPayload | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  candidates.push(raw);

  for (const candidate of candidates) {
    try {
      const parsed = briefPayloadSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Splits the transcript on turn boundaries into segments that fit one extraction call. */
export function segmentTranscript(transcript: string, maxTokens = 3000): string[] {
  const lines = transcript.split("\n");
  const segments: string[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (tokens + cost > maxTokens && buffer.length > 0) {
      segments.push(buffer.join("\n"));
      buffer = [];
      tokens = 0;
    }
    buffer.push(line);
    tokens += cost;
  }
  if (buffer.length > 0) segments.push(buffer.join("\n"));
  return segments;
}

export interface BriefResult {
  brief: MeetingBrief;
  promptTokens: number;
  completionTokens: number;
  segments: number;
}

export async function generateBrief(
  transcript: string,
  meta: { title: string; date: string | null },
): Promise<BriefResult> {
  const providers = getProviders();
  const segments = segmentTranscript(transcript);
  let promptTokens = 0;
  let completionTokens = 0;

  const partials: BriefPayload[] = [];
  for (const segment of segments) {
    const result = await providers.chat.complete({
      task: "brief-map",
      json: true,
      temperature: 0,
      maxOutputTokens: 1500,
      messages: [
        { role: "system", content: BRIEF_SYSTEM_PROMPT },
        { role: "user", content: buildBriefMapPrompt(segment, meta) },
      ],
    });
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    const parsed = parseBriefPayload(result.text);
    if (parsed) partials.push(parsed);
  }

  if (partials.length === 0) {
    return {
      brief: emptyBrief(`${providers.chat.model} (extraction failed)`),
      promptTokens,
      completionTokens,
      segments: segments.length,
    };
  }

  let merged: BriefPayload;
  if (partials.length === 1) {
    merged = partials[0] as BriefPayload;
  } else {
    const result = await providers.chat.complete({
      task: "brief-reduce",
      json: true,
      temperature: 0,
      maxOutputTokens: 2000,
      messages: [
        { role: "system", content: BRIEF_REDUCE_SYSTEM_PROMPT },
        { role: "user", content: partials.map((partial) => JSON.stringify(partial)).join("\n") },
      ],
    });
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    // If the merge fails, a mechanical concatenation is better than no brief.
    merged = parseBriefPayload(result.text) ?? mergeLocally(partials);
  }

  return {
    brief: { ...merged, generatedBy: providers.remote ? providers.chat.model : "offline heuristics (no LLM)" },
    promptTokens,
    completionTokens,
    segments: segments.length,
  };
}

function mergeLocally(partials: BriefPayload[]): BriefPayload {
  return {
    summary: partials.map((partial) => partial.summary).filter(Boolean).join(" "),
    topics: [...new Set(partials.flatMap((partial) => partial.topics))].slice(0, 10),
    decisions: partials.flatMap((partial) => partial.decisions),
    actionItems: partials.flatMap((partial) => partial.actionItems),
    openQuestions: [...new Set(partials.flatMap((partial) => partial.openQuestions))],
  };
}

export function emptyBrief(generatedBy: string): MeetingBrief {
  return { summary: "", topics: [], decisions: [], actionItems: [], openQuestions: [], generatedBy };
}
