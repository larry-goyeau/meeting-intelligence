import { describe, expect, it } from "vitest";
import { parseTranscript } from "@/lib/transcript/parse";
import { formatRange, formatTimecode, parseTimecode } from "@/lib/transcript/time";

describe("parseTimecode", () => {
  it("reads two-part timecodes as minutes and seconds", () => {
    expect(parseTimecode("01:30")).toBe(90_000);
  });

  it("reads three-part timecodes as hours, minutes and seconds", () => {
    expect(parseTimecode("01:02:03")).toBe(3_723_000);
  });

  it("accepts both decimal separators for milliseconds", () => {
    expect(parseTimecode("00:00:01.250")).toBe(1250);
    expect(parseTimecode("00:00:01,250")).toBe(1250);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(parseTimecode("banana")).toBeNull();
    expect(parseTimecode("1:99")).toBeNull();
    expect(parseTimecode("")).toBeNull();
  });
});

describe("formatting", () => {
  it("omits hours for short meetings and includes them for long ones", () => {
    expect(formatTimecode(90_000)).toBe("01:30");
    expect(formatTimecode(3_723_000)).toBe("01:02:03");
  });

  it("renders a range and degrades when the end is unknown", () => {
    expect(formatRange(60_000, 90_000)).toBe("01:00\u201301:30");
    expect(formatRange(60_000, null)).toBe("01:00");
    expect(formatRange(null, null)).toBe("no timestamp");
  });
});

describe("parseTranscript", () => {
  it("parses the bracketed timestamp layout and reads the header block", () => {
    const parsed = parseTranscript(
      [
        "Title: Weekly Sync",
        "Date: 2026-03-04",
        "Participants: Alice Smith, Bob Jones",
        "",
        "[00:00:04] Alice Smith: Let's start with the release.",
        "[00:00:12] Bob Jones: I'd rather cut scope than the date.",
      ].join("\n"),
    );

    expect(parsed.format).toBe("bracketed");
    expect(parsed.title).toBe("Weekly Sync");
    expect(parsed.date).toBe("2026-03-04");
    expect(parsed.participants).toEqual(["Alice Smith", "Bob Jones"]);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({ speaker: "Alice Smith", startMs: 4000, text: "Let's start with the release." });
  });

  it("parses the speaker-first layout", () => {
    const parsed = parseTranscript(["Alice (00:01:00): First point.", "Bob [00:01:30]: Second point."].join("\n"));
    expect(parsed.format).toBe("speaker-first");
    expect(parsed.turns.map((turn) => turn.startMs)).toEqual([60_000, 90_000]);
  });

  it("closes each turn at the start of the next one", () => {
    const parsed = parseTranscript(["[00:00:00] Alice: One.", "[00:00:10] Bob: Two."].join("\n"));
    expect(parsed.turns[0]?.endMs).toBe(10_000);
    // The final turn has no successor, so its end is estimated from speaking rate.
    expect(parsed.turns[1]?.endMs).toBeGreaterThan(10_000);
  });

  it("treats an unprefixed line as a continuation of the current turn", () => {
    const parsed = parseTranscript(["[00:00:00] Alice: This sentence wraps", "onto a second line."].join("\n"));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.text).toBe("This sentence wraps onto a second line.");
  });

  it("does not invent a speaker from prose that happens to contain a colon", () => {
    const parsed = parseTranscript(["[00:00:00] Alice: Here is the plan.", "Note: we should revisit this."].join("\n"));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.participants).toEqual(["Alice"]);
  });

  it("parses WebVTT with voice spans and merges consecutive cues from one speaker", () => {
    const parsed = parseTranscript(
      [
        "WEBVTT",
        "",
        "1",
        "00:00:01.000 --> 00:00:04.000",
        "<v Alice>First half of the thought.",
        "",
        "2",
        "00:00:04.000 --> 00:00:07.000",
        "<v Alice>Second half of the thought.",
        "",
        "3",
        "00:00:07.000 --> 00:00:09.000",
        "<v Bob>Understood.",
      ].join("\n"),
    );

    expect(parsed.format).toBe("vtt");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe("First half of the thought. Second half of the thought.");
    expect(parsed.turns[0]?.endMs).toBe(7000);
    expect(parsed.turns[1]?.speaker).toBe("Bob");
  });

  it("takes the title and date from a WebVTT NOTE comment, the only place such a file carries them", () => {
    const parsed = parseTranscript(
      ["WEBVTT", "", "NOTE Orion Sprint 1 Planning - 2026-01-22", "", "00:00:01.000 --> 00:00:03.000", "<v Alice>Hello."].join("\n"),
    );
    expect(parsed.title).toBe("Orion Sprint 1 Planning");
    expect(parsed.date).toBe("2026-01-22");
  });

  it("warns instead of failing when a transcript has no timestamps", () => {
    const parsed = parseTranscript(["Alice: No timecodes here.", "Bob: None here either."].join("\n"));
    expect(parsed.format).toBe("plain");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.warnings.join(" ")).toMatch(/No timestamps/i);
  });

  it("reports an empty transcript rather than throwing", () => {
    const parsed = parseTranscript("   \n\n  ");
    expect(parsed.turns).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("normalises CRLF input", () => {
    const parsed = parseTranscript("[00:00:00] Alice: One.\r\n[00:00:05] Bob: Two.\r\n");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1]?.text).toBe("Two.");
  });
});
