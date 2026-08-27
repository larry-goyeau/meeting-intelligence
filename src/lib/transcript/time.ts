/** Parsing and formatting of transcript timecodes. Kept separate: it is pure and heavily tested. */

const TIME_PATTERN = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:[.,](\d{1,3}))?$/;

/**
 * Accepts `mm:ss`, `hh:mm:ss`, and either decimal separator for milliseconds.
 *
 * Two-part timecodes are read as mm:ss, which is the convention in every
 * transcript tool I checked. It is ambiguous with hh:mm, and a transcript that
 * genuinely means "1 hour 5 minutes" as `01:05` will be read as 65 seconds —
 * accepted, because the alternative (guessing from context) fails less
 * predictably.
 */
export function parseTimecode(raw: string): number | null {
  const match = TIME_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, a, b, c, frac] = match;
  const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
  if (c === undefined) {
    return Number(a) * 60_000 + Number(b) * 1000 + ms;
  }
  return Number(a) * 3_600_000 + Number(b) * 60_000 + Number(c) * 1000 + ms;
}

/** `hh:mm:ss` when the meeting runs past an hour, `mm:ss` otherwise. */
export function formatTimecode(ms: number | null, forceHours = false): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--";
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0 || forceHours) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatRange(startMs: number | null, endMs: number | null): string {
  if (startMs === null) return "no timestamp";
  const forceHours = (endMs ?? startMs) >= 3_600_000;
  if (endMs === null || endMs <= startMs) return formatTimecode(startMs, forceHours);
  return `${formatTimecode(startMs, forceHours)}\u2013${formatTimecode(endMs, forceHours)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Fallback end time for the final turn, at 150 words per minute. Only ever used
 * for display, never for retrieval.
 */
export function estimateSpokenMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 60_000);
}
