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

/** Citation markers the model emitted, in order of appearance, deduplicated. */
export function extractCitations(answer: string): string[] {
  const found = answer.match(/\[S\d+(?:\s*,\s*S\d+)*\]/g) ?? [];
  const labels = found.flatMap((group) => group.slice(1, -1).split(/\s*,\s*/));
  return [...new Set(labels.map((label) => label.trim()))];
}
