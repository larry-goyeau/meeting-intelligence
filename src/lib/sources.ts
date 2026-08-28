import { formatRange } from "./transcript/time";
import type { Source } from "./types";

/**
 * The one place that decides how retrieved evidence is laid out for the model.
 *
 * Sources are wrapped in explicit delimiters for two reasons: the model is told
 * that everything inside is untrusted data rather than instructions (transcripts
 * can contain sentences that read like commands), and the offline provider can
 * parse the block back out to build an extractive answer.
 */
export const SOURCES_OPEN = "<sources>";
export const SOURCES_CLOSE = "</sources>";

export function renderSources(sources: Source[]): string {
  const body = sources
    .map((source) => {
      const meta = [
        source.meetingTitle,
        source.meetingDate ?? "undated",
        formatRange(source.startMs, source.endMs),
        source.speakers.join(", "),
      ].join(" | ");
      return `[${source.label}] ${meta}\n${source.text}`;
    })
    .join("\n\n");
  return `${SOURCES_OPEN}\n${body}\n${SOURCES_CLOSE}`;
}

export interface ParsedSource {
  label: string;
  meta: string;
  text: string;
}

export function parseSourceBlock(prompt: string): ParsedSource[] {
  const start = prompt.indexOf(SOURCES_OPEN);
  const end = prompt.indexOf(SOURCES_CLOSE);
  if (start === -1 || end === -1 || end < start) return [];
  const body = prompt.slice(start + SOURCES_OPEN.length, end).trim();
  if (body.length === 0) return [];

  const parsed: ParsedSource[] = [];
  const pattern = /^\[(S\d+)\]\s*(.*)$/;
  let current: ParsedSource | null = null;
  for (const line of body.split("\n")) {
    const header = pattern.exec(line.trim());
    if (header) {
      if (current) parsed.push(current);
      current = { label: header[1] ?? "", meta: header[2] ?? "", text: "" };
      continue;
    }
    if (current) current.text += (current.text.length > 0 ? "\n" : "") + line;
  }
  if (current) parsed.push(current);
  return parsed;
}

/**
 * The canonical citation marker, shared by the grader, the sanitiser and the
 * renderer so they cannot disagree about what counts as a citation.
 *
 * A bracket may carry a timecode alongside the labels, because the model is asked
 * both to cite `[S2]` and to give timestamps, and it reasonably combines them into
 * `[S6, 00:05:12]`. Matching labels only meant those citations were invisible: not
 * counted towards coverage, and — worse — rendered as plain text instead of a
 * clickable pill, so the one feature this product exists for silently stopped
 * working on most real answers. The prompt asks for the clean form; this tolerates
 * the drift, because a prompt is a request and a parser is a guarantee.
 */
const TIMECODE = String.raw`\d{1,3}:[0-5]\d(?::[0-5]\d)?`;
/** A moment or a span: models cite `00:04:27` and `00:01:40–02:42` about equally often. */
const TIME_ITEM = String.raw`(?:at\s+)?${TIMECODE}(?:\s*[\u2013\u2014-]\s*${TIMECODE})?`;
const CITATION_ITEM = String.raw`(?:S\d+|${TIME_ITEM})`;
export const CITATION_PATTERN = new RegExp(String.raw`\[\s*${CITATION_ITEM}(?:\s*[,;]\s*${CITATION_ITEM})*\s*\]`, "g");

export interface CitationItem {
  kind: "label" | "timecode";
  value: string;
}

/**
 * Splits a marker into its parts, in the order written.
 *
 * Order is kept because a marker often pairs each label with its own span —
 * `[S3, 00:06:47–08:10; S7, 01:20–02:52]` — and collecting all labels then all
 * timecodes loses which span belongs to which source, which then renders as a row
 * of pills followed by a row of unattached numbers.
 */
export function parseCitationToken(token: string): { items: CitationItem[]; labels: string[]; timecodes: string[] } {
  const items = token
    .slice(1, -1)
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map<CitationItem>((part) => ({ kind: /^S\d+$/.test(part) ? "label" : "timecode", value: part }));

  return {
    items,
    labels: items.filter((item) => item.kind === "label").map((item) => item.value),
    timecodes: items.filter((item) => item.kind === "timecode").map((item) => item.value),
  };
}

/** Citation markers the model emitted, in order of appearance, deduplicated. */
export function extractCitations(answer: string): string[] {
  const found = answer.match(CITATION_PATTERN) ?? [];
  return [...new Set(found.flatMap((token) => parseCitationToken(token).labels))];
}
