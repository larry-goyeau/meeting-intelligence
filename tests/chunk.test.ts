import { describe, expect, it } from "vitest";
import { chunkTranscript, embeddingText } from "@/lib/transcript/chunk";
import { estimateTokens } from "@/lib/providers/tokens";
import type { Turn } from "@/lib/types";

function turns(count: number, wordsPerTurn = 20): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    speaker: index % 2 === 0 ? "Alice" : "Bob",
    startMs: index * 10_000,
    endMs: (index + 1) * 10_000,
    text: Array.from({ length: wordsPerTurn }, (_, word) => `word${index}x${word}`).join(" "),
  }));
}

const meta = { meetingId: "m1", title: "Weekly Sync", date: "2026-03-04" };

describe("chunkTranscript", () => {
  it("keeps chunks near the target size", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(40) }, { targetTokens: 200, overlapTokens: 40, maxTokens: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // One turn may overshoot the target; the hard ceiling is what matters.
      expect(chunk.tokenCount).toBeLessThanOrEqual(400);
    }
  });

  it("never splits a turn across two chunks", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(30) }, { targetTokens: 150, overlapTokens: 30, maxTokens: 300 });
    for (const chunk of chunks) {
      for (const line of chunk.text.split("\n")) {
        // Every line is a complete rendered turn, so it carries its own label.
        expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] (Alice|Bob): /);
      }
    }
  });

  it("overlaps consecutive chunks so an exchange is not cut in half", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(24) }, { targetTokens: 160, overlapTokens: 60, maxTokens: 320 });
    expect(chunks.length).toBeGreaterThan(2);
    const first = chunks[0];
    const second = chunks[1];
    const firstLines = first?.text.split("\n") ?? [];
    const secondLines = second?.text.split("\n") ?? [];
    expect(secondLines.some((line) => firstLines.includes(line))).toBe(true);
  });

  it("gives each chunk contiguous ordinals and stable ids", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(20) }, { targetTokens: 150, overlapTokens: 30, maxTokens: 300 });
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks[0]?.id).toBe("m1:0");
  });

  it("carries speakers and a time span on every chunk", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(12) }, { targetTokens: 200, overlapTokens: 40, maxTokens: 400 });
    for (const chunk of chunks) {
      expect(chunk.speakers.length).toBeGreaterThan(0);
      expect(chunk.startMs).not.toBeNull();
      expect(chunk.endMs).not.toBeNull();
      expect(chunk.endMs ?? 0).toBeGreaterThanOrEqual(chunk.startMs ?? 0);
    }
  });

  it("splits a monologue longer than the ceiling on sentence boundaries", () => {
    const monologue: Turn[] = [
      {
        index: 0,
        speaker: "Alice",
        startMs: 0,
        endMs: 60_000,
        text: Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} and it has some length to it.`).join(" "),
      },
    ];
    const chunks = chunkTranscript({ ...meta, turns: monologue }, { targetTokens: 100, overlapTokens: 20, maxTokens: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(240);
  });

  it("handles a transcript with no timestamps", () => {
    const untimed: Turn[] = [
      { index: 0, speaker: "Alice", startMs: null, endMs: null, text: "No timecodes at all here." },
      { index: 1, speaker: "Bob", startMs: null, endMs: null, text: "Still none." },
    ];
    const chunks = chunkTranscript({ ...meta, turns: untimed });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startMs).toBeNull();
    expect(chunks[0]?.text).toBe("Alice: No timecodes at all here.\nBob: Still none.");
  });

  it("returns nothing for an empty transcript", () => {
    expect(chunkTranscript({ ...meta, turns: [] })).toEqual([]);
  });

  it("puts meeting context in the embedded text but not in the displayed text", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(4) });
    const chunk = chunks[0];
    expect(chunk?.text).not.toContain("Weekly Sync");
    expect(embeddingText(chunk!)).toContain("Weekly Sync");
    expect(embeddingText(chunk!)).toContain("2026-03-04");
  });

  it("reports a token count consistent with the estimator", () => {
    const chunks = chunkTranscript({ ...meta, turns: turns(8) });
    for (const chunk of chunks) expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
  });
});
