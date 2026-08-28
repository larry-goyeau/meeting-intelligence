import type { ParsedTranscript, TranscriptFormat, Turn } from "@/lib/types";
import { estimateSpokenMs, parseTimecode } from "./time";

/**
 * Transcript parsing.
 *
 * Real transcripts come out of Zoom, Teams, Otter, Whisper and hand-written
 * notes, and no two agree on a layout. Rather than demand one format, this
 * detects the common ones. The format that was detected is reported back and
 * shown in the UI, because a transcript that silently parses as one giant
 * unattributed turn destroys retrieval quality and the user needs to see that
 * happen rather than wonder why the answers are bad.
 */

/** `[00:12:34] Alice: text` — also tolerates parentheses, no brackets, and an en dash separator. */
const BRACKETED = /^[[(]?\s*(\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:[.,]\d{1,3})?)\s*[\])]?\s*[-\u2013]?\s*([^:]{1,60}?)\s*:\s*(.*)$/;

/** `Alice (00:12:34): text` or `Alice [00:12:34]: text` */
const SPEAKER_FIRST = /^([^:[(]{1,60}?)\s*[[(]\s*(\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:[.,]\d{1,3})?)\s*[\])]\s*:\s*(.*)$/;

/**
 * `Leah Moreau 0:07` alone on a line, with the utterance on the lines below — what
 * Google Meet and the Docs "Transcript" export produce, and the shape most likely to
 * be pasted in from a real meeting.
 *
 * It has to be recognised before `SPEAKER_ONLY`, which otherwise matches it on the
 * colon inside the timecode and yields the speaker "Leah Moreau 0" saying "07 uh
 * okay wait" — a fresh participant per minute and every timestamp lost.
 */
const SPEAKER_HEADING = /^(.{1,60}?)\s+(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\s*$/;

/** `Alice: text` with no timecode at all. */
const SPEAKER_ONLY = /^([^:]{1,60}?)\s*:\s*(.*)$/;

/** WebVTT / SRT cue range. */
const CUE_RANGE = /^(\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:[.,]\d{1,3})?)/;

const HEADER = /^(title|date|meeting|participants|attendees|subject)\s*:\s*(.+)$/i;

/** Exporter chrome that carries no meeting content. */
const BOILERPLATE = /^transcript$|computer generated|change the text after|^recording\b/i;

/**
 * Words that look like a speaker label to `SPEAKER_ONLY` but are really prose
 * ("Note: we should..."). Without this a stray colon invents a participant.
 */
const NOT_A_SPEAKER = new Set([
  "note",
  "notes",
  "action",
  "actions",
  "action item",
  "action items",
  "decision",
  "decisions",
  "agenda",
  "summary",
  "todo",
  "next steps",
  "attendees",
  "participants",
  "recording",
  "transcript",
  "warning",
  "http",
  "https",
]);

/** Lowercase words that legitimately appear inside a name. */
const NAME_PARTICLES = new Set(["de", "del", "della", "van", "von", "der", "den", "du", "da", "di", "la", "le", "el", "bin", "al", "ibn"]);

/**
 * Stricter than `looksLikeSpeaker`, because `SPEAKER_HEADING` has no colon to anchor
 * on: any short line ending in a timecode matches it, including the utterance "Let's
 * meet at 10:30". Requiring every word to be capitalised — bar the particles in names
 * like "Nadia El Amrani" — rejects prose while accepting names.
 */
function looksLikeName(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (/^unknown speaker$/i.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  if (words.length > 5) return false;
  return words.every((word) => /^[\p{Lu}]/u.test(word) || NAME_PARTICLES.has(word.toLowerCase()));
}

function looksLikeSpeaker(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (NOT_A_SPEAKER.has(trimmed.toLowerCase())) return false;
  // A speaker label is a handful of words, not a sentence.
  if (trimmed.split(/\s+/).length > 5) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  return /[\p{L}]/u.test(trimmed);
}

function normaliseSpeaker(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[-\u2013*\s]+/, "")
    .trim();
}

interface RawTurn {
  speaker: string;
  startMs: number | null;
  endMs: number | null;
  lines: string[];
}

function detectFormat(lines: string[]): TranscriptFormat {
  let bracketed = 0;
  let speakerFirst = 0;
  let heading = 0;
  let speakerOnly = 0;
  let cues = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (CUE_RANGE.test(line)) cues += 1;
    else if (BRACKETED.test(line)) bracketed += 1;
    else if (SPEAKER_FIRST.test(line)) speakerFirst += 1;
    // Before SPEAKER_ONLY, which also matches these lines but on the wrong colon.
    else if (isHeadingLine(line)) heading += 1;
    else if (SPEAKER_ONLY.test(line)) speakerOnly += 1;
  }
  // The WEBVTT magic line is definitive; without it, two or more cue ranges are
  // enough to call it SRT. A single range could be prose containing an arrow.
  if (lines.some((line) => /^WEBVTT\b/i.test(line.trim())) && cues >= 1) return "vtt";
  if (cues >= 2) return "srt";
  if (bracketed >= speakerFirst && bracketed >= heading && bracketed >= speakerOnly && bracketed > 0) return "bracketed";
  if (speakerFirst > 0 && speakerFirst >= heading && speakerFirst >= speakerOnly) return "speaker-first";
  // Three is the smallest count that cannot be a coincidence of prose ending in a
  // clock time, and a real transcript in this format has dozens.
  if (heading >= 3 && heading >= speakerOnly) return "speaker-heading";
  if (speakerOnly > 0) return "plain";
  return "unknown";
}

function isHeadingLine(line: string): boolean {
  const match = SPEAKER_HEADING.exec(line);
  return match !== null && looksLikeName(match[1] ?? "");
}

/**
 * `Name M:SS` heading, utterance on the following lines until the next heading.
 *
 * Blank lines do not end a turn here: the exporter wraps long utterances across
 * paragraphs, and treating a blank line as a boundary would split one person's
 * sentence into two unattributed turns.
 */
function parseHeadingBased(lines: string[]): RawTurn[] {
  const turns: RawTurn[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const match = SPEAKER_HEADING.exec(line);
    if (match && looksLikeName(match[1] ?? "")) {
      turns.push({
        speaker: normaliseSpeaker(match[1] ?? ""),
        startMs: parseTimecode(match[2] ?? ""),
        endMs: null,
        lines: [],
      });
      continue;
    }

    const current = turns.at(-1);
    if (current) current.lines.push(line);
  }
  return turns;
}

function parseCueBased(lines: string[]): RawTurn[] {
  const turns: RawTurn[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = CUE_RANGE.exec(lines[i] ?? "");
    if (!match) continue;
    const startMs = parseTimecode(match[1] ?? "");
    const endMs = parseTimecode(match[2] ?? "");
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = (lines[j] ?? "").trim();
      if (line.length === 0 || CUE_RANGE.test(line)) break;
      // SRT numeric index lines carry no content.
      if (/^\d+$/.test(line)) continue;
      body.push(line);
    }
    if (body.length === 0) continue;

    // Cue text is usually `Speaker: words`; voice spans are `<v Alice>words`.
    let speaker = "Unknown";
    let first = body[0] ?? "";
    const voiceSpan = /^<v\s+([^>]+)>\s*(.*)$/.exec(first);
    if (voiceSpan) {
      speaker = normaliseSpeaker(voiceSpan[1] ?? "");
      first = (voiceSpan[2] ?? "").replace(/<\/v>\s*$/, "");
    } else {
      const withSpeaker = SPEAKER_ONLY.exec(first);
      if (withSpeaker && looksLikeSpeaker(withSpeaker[1] ?? "")) {
        speaker = normaliseSpeaker(withSpeaker[1] ?? "");
        first = withSpeaker[2] ?? "";
      }
    }
    const text = [first, ...body.slice(1)].join(" ").replace(/<[^>]+>/g, "").trim();
    if (text.length === 0) continue;

    // Consecutive cues from the same speaker are one turn: cue boundaries are an
    // artefact of subtitle timing, not of the conversation.
    const previous = turns.at(-1);
    if (previous && previous.speaker === speaker) {
      previous.lines.push(text);
      previous.endMs = endMs;
    } else {
      turns.push({ speaker, startMs, endMs, lines: [text] });
    }
  }
  return turns;
}

function parseLineBased(lines: string[]): { turns: RawTurn[]; orphanLines: number } {
  const turns: RawTurn[] = [];
  let orphanLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^WEBVTT/i.test(line)) continue;

    const bracketed = BRACKETED.exec(line);
    if (bracketed && looksLikeSpeaker(bracketed[2] ?? "")) {
      turns.push({
        speaker: normaliseSpeaker(bracketed[2] ?? ""),
        startMs: parseTimecode(bracketed[1] ?? ""),
        endMs: null,
        lines: [(bracketed[3] ?? "").trim()],
      });
      continue;
    }

    const speakerFirst = SPEAKER_FIRST.exec(line);
    if (speakerFirst && looksLikeSpeaker(speakerFirst[1] ?? "")) {
      turns.push({
        speaker: normaliseSpeaker(speakerFirst[1] ?? ""),
        startMs: parseTimecode(speakerFirst[2] ?? ""),
        endMs: null,
        lines: [(speakerFirst[3] ?? "").trim()],
      });
      continue;
    }

    const speakerOnly = SPEAKER_ONLY.exec(line);
    if (speakerOnly && looksLikeSpeaker(speakerOnly[1] ?? "")) {
      turns.push({
        speaker: normaliseSpeaker(speakerOnly[1] ?? ""),
        startMs: null,
        endMs: null,
        lines: [(speakerOnly[2] ?? "").trim()],
      });
      continue;
    }

    // A line with no speaker prefix continues the current turn (wrapped text).
    const current = turns.at(-1);
    if (current) current.lines.push(line);
    else {
      orphanLines += 1;
      turns.push({ speaker: "Unknown", startMs: null, endMs: null, lines: [line] });
    }
  }

  return { turns, orphanLines };
}

export function parseTranscript(raw: string): ParsedTranscript {
  const warnings: string[] = [];
  const normalised = raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const allLines = normalised.split("\n");

  // Header block: consumed only from the top of the file, before any dialogue.
  let title: string | null = null;
  let date: string | null = null;
  const declaredParticipants: string[] = [];
  let cursor = 0;
  for (; cursor < allLines.length; cursor += 1) {
    const line = (allLines[cursor] ?? "").trim();
    if (line.length === 0) continue;
    const header = HEADER.exec(line);
    if (!header) break;
    const key = (header[1] ?? "").toLowerCase();
    const value = (header[2] ?? "").trim();
    if (key === "title" || key === "meeting" || key === "subject") title = value;
    else if (key === "date") date = normaliseDate(value);
    else declaredParticipants.push(...value.split(/[,;]/).map(normaliseSpeaker).filter(Boolean));
  }

  const body = allLines.slice(cursor);
  const format = detectFormat(body);

  // WebVTT has no header block, but exporters routinely put the meeting name in a
  // `NOTE` comment, which is the only title such a file will ever carry.
  if (title === null && (format === "vtt" || format === "srt")) {
    const note = body.find((line) => /^NOTE\s+\S/.test(line.trim()));
    if (note) {
      const text = note.trim().replace(/^NOTE\s+/, "").trim();
      const trailingDate = /\s+[-\u2013]\s+(\d{4}-\d{2}-\d{2})$/.exec(text);
      title = trailingDate ? text.slice(0, trailingDate.index).trim() : text;
      if (trailingDate?.[1] && date === null) date = trailingDate[1];
    }
  }

  let rawTurns: RawTurn[];
  if (format === "speaker-heading") {
    // Everything above the first heading is the exporter's preamble: the meeting
    // name, the date, and a disclaimer about machine transcription. The first two are
    // the only title and date such a file carries; the disclaimer must not become
    // searchable content, or "was this generated automatically" retrieves it.
    const firstHeading = body.findIndex((line) => isHeadingLine(line.trim()));
    for (const rawLine of body.slice(0, firstHeading === -1 ? 0 : firstHeading)) {
      const line = rawLine.trim();
      if (line.length === 0 || BOILERPLATE.test(line)) continue;
      if (date === null && looksLikeDate(line)) date = normaliseDate(line);
      else if (title === null) title = line;
    }
    rawTurns = parseHeadingBased(body.slice(firstHeading === -1 ? 0 : firstHeading));
  } else if (format === "vtt" || format === "srt") {
    rawTurns = parseCueBased(body);
  } else {
    const result = parseLineBased(body);
    rawTurns = result.turns;
    if (result.orphanLines > 0) {
      warnings.push(
        `${result.orphanLines} line(s) had no recognisable speaker label and were attributed to "Unknown".`,
      );
    }
  }

  if (format === "unknown" && rawTurns.length > 0) {
    warnings.push("No speaker labels or timestamps recognised. Retrieval will still work but citations lose attribution.");
  }

  const turns: Turn[] = rawTurns
    .map((turn, index) => ({
      index,
      speaker: turn.speaker || "Unknown",
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.lines.join(" ").replace(/\s+/g, " ").trim(),
    }))
    .filter((turn) => turn.text.length > 0)
    .map((turn, index) => ({ ...turn, index }));

  // Close open intervals: a turn ends where the next one starts.
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn || turn.endMs !== null) continue;
    const next = turns[i + 1];
    if (next?.startMs !== null && next?.startMs !== undefined && turn.startMs !== null && next.startMs > turn.startMs) {
      turn.endMs = next.startMs;
    } else if (turn.startMs !== null) {
      turn.endMs = turn.startMs + estimateSpokenMs(turn.text);
    }
  }

  const withTimestamps = turns.filter((turn) => turn.startMs !== null).length;
  if (turns.length > 0 && withTimestamps === 0) {
    warnings.push("No timestamps found. Answers will cite speakers but cannot link to a point in time.");
  } else if (withTimestamps > 0 && withTimestamps < turns.length * 0.5) {
    warnings.push(`Only ${withTimestamps} of ${turns.length} turns carry a timestamp.`);
  }

  const speakers = [...new Set(turns.map((turn) => turn.speaker))].filter((s) => s !== "Unknown");
  const participants = declaredParticipants.length > 0 ? unique([...declaredParticipants, ...speakers]) : speakers;

  if (turns.length === 0) warnings.push("No dialogue could be extracted from this file.");

  return { title, date, participants, turns, format, warnings };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** A short line that is a date and nothing else, like the `Aug 28, 2026` under a title. */
function looksLikeDate(line: string): boolean {
  if (line.length > 30 || !/\d/.test(line)) return false;
  return !Number.isNaN(new Date(line).getTime());
}

/** Best-effort ISO normalisation; unparseable dates are kept verbatim rather than dropped. */
function normaliseDate(value: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // Local components, not toISOString: "Aug 28, 2026" parses as local midnight, and
  // converting to UTC from any zone ahead of it reports the 27th.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** Renders turns the way the model and the transcript viewer both see them. */
export function renderTurns(turns: Turn[], withTimestamps = true): string {
  return turns
    .map((turn) => {
      const stamp = withTimestamps && turn.startMs !== null ? `[${msToClock(turn.startMs)}] ` : "";
      return `${stamp}${turn.speaker}: ${turn.text}`;
    })
    .join("\n");
}

function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
