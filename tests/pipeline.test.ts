import { beforeAll, describe, expect, it } from "vitest";
import { ask } from "@/lib/rag/answer";
import { ingestTranscript } from "@/lib/rag/ingest";
import { retrieve } from "@/lib/rag/retrieve";
import { createMemoryDb } from "@/lib/store/db";
import { Repository } from "@/lib/store/repository";
import { extractCitations } from "@/lib/sources";
import type { AskEvent } from "@/lib/rag/answer";

/**
 * End-to-end over the real pipeline: ingest, index, retrieve, answer.
 *
 * No network and no mocks. The offline provider is deterministic, so these
 * assertions are stable and free, which is the whole reason it exists. What is
 * being tested is the machinery — that chunks reach the index, that both
 * retrievers contribute, that scope filtering works, that citations resolve, and
 * that an unanswerable question is refused rather than answered. Answer *quality*
 * is a different question, measured by `npm run eval`.
 */

const ARCHITECTURE = [
  "Title: Architecture Review",
  "Date: 2026-01-15",
  "",
  "[00:00:10] Daniel Okoye: Three options for the analytics store. Postgres aggregate tables, DynamoDB with pre-computed partitions, or ClickHouse.",
  "[00:00:40] Marcus Webb: ClickHouse is genuinely faster for cohort comparisons, two hundred milliseconds against four seconds.",
  "[00:01:05] Tom Nakamura: Single-owner infrastructure is how you get a four hour outage. That decides it for me.",
  "[00:01:30] Daniel Okoye: DynamoDB fails on the cohort query. Any query crossing accounts is a scan or a second copy of the data.",
  "[00:02:00] Sofia Alvarez: We are going with aggregate tables in the existing Postgres cluster, monthly partitions, nightly rollup for cohorts.",
  "[00:02:30] Daniel Okoye: Second thing. I propose we enable pgvector on the existing RDS instance for the H2 prototype.",
  "[00:03:00] Tom Nakamura: On the same instance as the transactional workload? For a prototype I will live with it.",
  "[00:03:30] Sofia Alvarez: Decision: pgvector on the existing RDS instance, self-hosted, no new vendor.",
  "[00:04:00] Priya Raman: Multi-region. Two design partners are in the EU, and our database is single-region us-east-1.",
  "[00:04:30] Sofia Alvarez: They have not asked. We defer it and revisit if it comes up in the beta.",
].join("\n");

const POSTMORTEM = [
  "Title: MI-412 Postmortem",
  "Date: 2026-02-05",
  "",
  "[00:00:10] Tom Nakamura: MI-412 was connection pool exhaustion on the primary. Forty minutes of degraded writes, no data loss.",
  "[00:00:50] Tom Nakamura: Tuesday the backfill evicted the working set from shared buffers and checkout latency went from forty milliseconds to nine hundred.",
  "[00:01:40] Tom Nakamura: In the architecture review we decided to enable pgvector on the existing RDS instance. I want to reverse that decision.",
  "[00:02:20] Daniel Okoye: My original argument assumed the prototype was harmless. Tuesday shows it is not, so I withdraw it.",
  "[00:03:00] Sofia Alvarez: We are reversing the fifteenth of January decision. The new decision is pgvector on the dedicated analytics read replica.",
  "[00:03:40] Tom Nakamura: I am provisioning the analytics replica, target end of next week.",
].join("\n");

const repository = new Repository(createMemoryDb());

beforeAll(async () => {
  await ingestTranscript({ filename: "architecture-review.txt", content: ARCHITECTURE, source: "sample" }, repository);
  await ingestTranscript({ filename: "postmortem.txt", content: POSTMORTEM, source: "sample" }, repository);
}, 30_000);

async function collect(question: string, meetingIds: string[] = []): Promise<{ events: AskEvent[]; answer: string }> {
  const events: AskEvent[] = [];
  let answer = "";
  for await (const event of ask({ question, history: [], meetingIds }, repository)) {
    events.push(event);
    if (event.type === "delta") answer += event.data as string;
  }
  return { events, answer };
}

describe("ingestion", () => {
  it("indexes both meetings with chunks and embeddings", () => {
    const meetings = repository.listMeetings();
    expect(meetings).toHaveLength(2);
    expect(repository.countChunks()).toBeGreaterThan(0);
    for (const meeting of meetings) expect(meeting.chunkCount).toBeGreaterThan(0);
  });

  it("orders meetings newest first", () => {
    expect(repository.listMeetings().map((meeting) => meeting.date)).toEqual(["2026-02-05", "2026-01-15"]);
  });

  it("deduplicates a re-uploaded transcript instead of indexing it twice", async () => {
    const before = repository.countChunks();
    const result = await ingestTranscript({ filename: "again.txt", content: ARCHITECTURE, source: "upload" }, repository);
    expect(result.reused).toBe(true);
    expect(repository.countChunks()).toBe(before);
    expect(repository.listMeetings()).toHaveLength(2);
  });

  it("rejects a file with no dialogue", async () => {
    await expect(ingestTranscript({ filename: "empty.txt", content: "\n\n", source: "upload" }, repository)).rejects.toThrow();
  });
});

describe("retrieval", () => {
  it("finds the storage decision and reports which retriever found it", async () => {
    const result = await retrieve(repository, "which database did we choose for the analytics store");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.some((source) => source.text.includes("Postgres"))).toBe(true);
    // Both retrievers should contribute on a query like this one.
    expect(result.denseCount).toBeGreaterThan(0);
    expect(result.lexicalCount).toBeGreaterThan(0);
  });

  it("matches an exact identifier through lexical search", async () => {
    const result = await retrieve(repository, "MI-412");
    expect(result.sources.some((source) => source.text.includes("MI-412"))).toBe(true);
  });

  it("honours the meeting scope", async () => {
    const [newest] = repository.listMeetings();
    const result = await retrieve(repository, "pgvector decision", { meetingIds: [newest!.id] });
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) expect(source.meetingId).toBe(newest!.id);
  });

  it("returns nothing for a query unrelated to the corpus", async () => {
    const result = await retrieve(repository, "zeppelin marmalade quantum bicycle");
    expect(result.sources).toHaveLength(0);
  });

  it("labels sources chronologically across meetings", async () => {
    const result = await retrieve(repository, "pgvector on the RDS instance decision");
    const dates = result.sources.map((source) => source.meetingDate ?? "");
    expect([...dates]).toEqual([...dates].sort());
  });

  it("respects the context token budget", async () => {
    const result = await retrieve(repository, "what did we decide", { contextTokenBudget: 400 });
    const total = result.sources.reduce((sum, source) => sum + source.tokenCount, 0);
    expect(total).toBeLessThanOrEqual(500);
  });
});

describe("ask", () => {
  it("streams metadata, then deltas, then a done event", async () => {
    const { events, answer } = await collect("what did we decide about the analytics store");
    expect(events[0]?.type).toBe("meta");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(answer.length).toBeGreaterThan(0);
  });

  it("only emits citations that resolve to a real source", async () => {
    const { events, answer } = await collect("which database did we choose");
    const meta = events[0]?.data as { sources: { label: string }[] };
    const labels = new Set(meta.sources.map((source) => source.label));
    for (const citation of extractCitations(answer)) expect(labels.has(citation)).toBe(true);
  });

  it("refuses without calling the model when nothing is relevant", async () => {
    const { events, answer } = await collect("zeppelin marmalade quantum bicycle");
    const meta = events[0]?.data as { route: string; sources: unknown[] };
    expect(meta.route).toBe("refused");
    expect(meta.sources).toHaveLength(0);
    expect(answer).toMatch(/could not find/i);

    const done = events.at(-1)?.data as { verdict: { flags: string[] }; usage: { completionTokens: number } };
    expect(done.verdict.flags).toContain("no-evidence");
  });

  it("answers a single small meeting from the whole transcript instead of retrieving", async () => {
    const meetings = repository.listMeetings();
    const postmortem = meetings.find((meeting) => meeting.date === "2026-02-05");
    const { events } = await collect("summarise this meeting", [postmortem!.id]);
    const meta = events[0]?.data as { route: string };
    expect(meta.route).toBe("whole-meeting");
  });

  it("records a trace with stage timings and usage for every question", async () => {
    const { events } = await collect("who reversed the pgvector decision");
    const done = events.at(-1)?.data as { traceId: string };
    const trace = repository.getTrace(done.traceId);
    expect(trace).not.toBeNull();
    expect(trace?.stages.length).toBeGreaterThan(0);
    expect(trace?.sources.length).toBeGreaterThan(0);
    expect(trace?.models.embedding).toBeTruthy();
  });

  it("reports an empty corpus differently from a failed search", async () => {
    const empty = new Repository(createMemoryDb());
    const events: AskEvent[] = [];
    for await (const event of ask({ question: "anything at all", history: [], meetingIds: [] }, empty)) events.push(event);
    const answer = events.filter((event) => event.type === "delta").map((event) => event.data).join("");
    expect(answer).toMatch(/no meetings indexed/i);
  });
});
