import { describe, expect, it } from "vitest";
import { fuseRanks, mmrSelect, packWithinBudget, selectWithFloor } from "@/lib/rag/retrieve";
import type { Chunk, ScoredChunk } from "@/lib/types";

function chunk(id: string, text = "some text", overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    meetingId: "m1",
    ordinal: Number(id.split(":")[1] ?? 0),
    text,
    header: "",
    speakers: ["Alice"],
    startMs: 0,
    endMs: 1000,
    firstTurnIndex: 0,
    lastTurnIndex: 1,
    tokenCount: 100,
    ...overrides,
  };
}

type Candidate = ScoredChunk & { viaNeighbour: boolean };

function scored(id: string, fusedScore: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    ...chunk(id),
    denseRank: 1,
    lexicalRank: null,
    fusedScore,
    meetingTitle: "Weekly Sync",
    meetingDate: "2026-03-04",
    viaNeighbour: false,
    ...overrides,
  };
}

describe("fuseRanks", () => {
  it("ranks a chunk found by both retrievers above one found by only one", () => {
    const both = chunk("m1:1");
    const denseOnly = chunk("m1:2");
    const lexicalOnly = chunk("m1:3");

    const fused = fuseRanks(
      [
        { chunk: denseOnly, score: 0.9 },
        { chunk: both, score: 0.8 },
      ],
      [
        { chunk: lexicalOnly, score: 5 },
        { chunk: both, score: 4 },
      ],
      60,
    );

    expect(fused[0]?.chunk.id).toBe("m1:1");
    expect(fused[0]?.denseRank).toBe(2);
    expect(fused[0]?.lexicalRank).toBe(2);
  });

  it("depends only on rank, not on the incomparable raw scores", () => {
    const a = chunk("m1:1");
    const b = chunk("m1:2");
    const withSmallScores = fuseRanks([{ chunk: a, score: 0.001 }, { chunk: b, score: 0.0005 }], [], 60);
    const withLargeScores = fuseRanks([{ chunk: a, score: 9000 }, { chunk: b, score: 10 }], [], 60);
    expect(withSmallScores.map((entry) => entry.chunk.id)).toEqual(withLargeScores.map((entry) => entry.chunk.id));
    expect(withSmallScores[0]?.score).toBe(withLargeScores[0]?.score);
  });

  it("handles either list being empty", () => {
    expect(fuseRanks([], [], 60)).toEqual([]);
    expect(fuseRanks([{ chunk: chunk("m1:1"), score: 1 }], [], 60)).toHaveLength(1);
  });
});

describe("mmrSelect", () => {
  it("prefers a diverse candidate over a near-duplicate of an already selected one", () => {
    const candidates = [
      scored("m1:1", 0.03, { text: "We decided to use Postgres for the analytics store." }),
      scored("m1:2", 0.029, { text: "We decided to use Postgres for the analytics store." }),
      scored("m1:3", 0.02, { text: "Tom will provision the dedicated analytics read replica." }),
    ];
    const selected = mmrSelect(candidates, "analytics storage decision", 2, 0.5);
    expect(selected).toHaveLength(2);
    expect(selected.map((candidate) => candidate.id)).toContain("m1:3");
  });

  it("keeps pure relevance order when lambda is 1", () => {
    const candidates = [scored("m1:1", 0.03), scored("m1:2", 0.02), scored("m1:3", 0.01)];
    const selected = mmrSelect(candidates, "anything", 3, 1);
    expect(selected.map((candidate) => candidate.id)).toEqual(["m1:1", "m1:2", "m1:3"]);
  });

  it("never returns more than the limit, or more than it was given", () => {
    expect(mmrSelect([scored("m1:1", 0.01)], "q", 5, 0.7)).toHaveLength(1);
    expect(mmrSelect([], "q", 5, 0.7)).toHaveLength(0);
  });
});

describe("selectWithFloor", () => {
  /**
   * The failure this exists to prevent, reproduced with the shape of the real
   * case: a chunk that is BM25's second hit but absent from the dense list earns
   * one fusion contribution, and loses to chunks that are mediocre in both lists
   * yet collect two.
   */
  it("keeps a retriever's top hit that fusion ranks below mediocre both-list chunks", () => {
    const lexicalStar = scored("m1:9", 0.0161, { denseRank: null, lexicalRank: 2 });
    const bothMediocre = [0, 1, 2, 3].map((n) => scored(`m1:${n}`, 0.027 - n * 0.0001, { denseRank: 15 + n, lexicalRank: 8 + n }));
    const relevant = [...bothMediocre, lexicalStar];

    const dense = bothMediocre.map((candidate) => ({ chunk: candidate }));
    const lexical = [bothMediocre[0]!, lexicalStar].map((candidate) => ({ chunk: candidate }));

    const withoutFloor = mmrSelect(relevant, "q", 2, 0.7);
    expect(withoutFloor.map((c) => c.id)).not.toContain("m1:9");

    const withFloor = selectWithFloor(relevant, dense, lexical, "q", { finalK: 4 });
    expect(withFloor.map((c) => c.id)).toContain("m1:9");
  });

  it("never exceeds finalK, and never reserves more than half of it", () => {
    const relevant = Array.from({ length: 20 }, (_, n) => scored(`m1:${n}`, 0.03 - n * 0.001));
    const dense = relevant.map((candidate) => ({ chunk: candidate }));
    const lexical = [...relevant].reverse().map((candidate) => ({ chunk: candidate }));

    for (const finalK of [1, 2, 5, 10]) {
      const selected = selectWithFloor(relevant, dense, lexical, "q", { finalK });
      expect(selected).toHaveLength(finalK);
      expect(new Set(selected.map((c) => c.id)).size).toBe(finalK);
    }
  });

  it("degrades to plain fusion order when a retriever returned nothing", () => {
    const relevant = [scored("m1:1", 0.03), scored("m1:2", 0.02), scored("m1:3", 0.01)];
    const selected = selectWithFloor(relevant, [], [], "q", { finalK: 3 });
    expect(selected.map((c) => c.id).sort()).toEqual(["m1:1", "m1:2", "m1:3"]);
  });
});

describe("packWithinBudget", () => {
  it("orders the selected sources chronologically, not by score", () => {
    const candidates = [
      scored("m1:5", 0.03, { startMs: 500_000, ordinal: 5 }),
      scored("m1:1", 0.02, { startMs: 60_000, ordinal: 1 }),
      scored("m1:3", 0.01, { startMs: 300_000, ordinal: 3 }),
    ];
    const { sources } = packWithinBudget(candidates, 10_000);
    expect(sources.map((source) => source.id)).toEqual(["m1:1", "m1:3", "m1:5"]);
    // Labels run forwards in time, which is what lets the model reason about order.
    expect(sources.map((source) => source.label)).toEqual(["S1", "S2", "S3"]);
  });

  it("orders across meetings by date first", () => {
    const candidates = [
      scored("m2:0", 0.03, { meetingId: "m2", meetingDate: "2026-02-05", startMs: 0 }),
      scored("m1:0", 0.02, { meetingId: "m1", meetingDate: "2026-01-15", startMs: 0 }),
    ];
    const { sources } = packWithinBudget(candidates, 10_000);
    expect(sources.map((source) => source.meetingId)).toEqual(["m1", "m2"]);
  });

  it("drops the weakest sources when the budget is exceeded", () => {
    const candidates = [scored("m1:1", 0.03), scored("m1:2", 0.02), scored("m1:3", 0.01)];
    const { sources, dropped } = packWithinBudget(candidates, 260);
    expect(sources).toHaveLength(2);
    expect(dropped).toBe(1);
    expect(sources.map((source) => source.id)).not.toContain("m1:3");
  });

  it("always keeps at least one source even if it alone exceeds the budget", () => {
    const { sources } = packWithinBudget([scored("m1:1", 0.03, { tokenCount: 9999 })], 10);
    expect(sources).toHaveLength(1);
  });

  it("gives retrieved chunks priority over neighbours when the budget is tight", () => {
    const candidates = [
      scored("m1:1", 0, { viaNeighbour: true }),
      scored("m1:2", 0.03, { viaNeighbour: false }),
    ];
    const { sources } = packWithinBudget(candidates, 130);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe("m1:2");
  });
});
