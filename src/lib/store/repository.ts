import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Chunk, Meeting, MeetingBrief, MeetingWithTurns, Trace, Turn } from "@/lib/types";
import { decodeVector, encodeVector, getDb, parseJsonColumn } from "./db";
import { config } from "@/lib/config";
import { contentTerms } from "@/lib/text";

/**
 * Data access. Every query lives here so the retrieval pipeline never writes SQL
 * and can be handed an in-memory database in tests.
 */

type Row = Record<string, unknown>;

export interface MeetingRecord extends Meeting {
  transcript: string;
  turns: Turn[];
  checksum: string;
}

function rowToMeeting(row: Row): MeetingRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    date: row.date === null || row.date === undefined ? null : String(row.date),
    source: String(row.source) as Meeting["source"],
    createdAt: String(row.created_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    participants: parseJsonColumn<string[]>(row.participants, []),
    turnCount: Number(row.turn_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    tokenCount: Number(row.token_count ?? 0),
    format: String(row.format ?? "unknown") as Meeting["format"],
    warnings: parseJsonColumn<string[]>(row.warnings, []),
    brief: parseJsonColumn<MeetingBrief | null>(row.brief, null),
    transcript: String(row.transcript ?? ""),
    turns: parseJsonColumn<Turn[]>(row.turns, []),
    checksum: String(row.checksum ?? ""),
  };
}

function rowToChunk(row: Row): Chunk {
  return {
    id: String(row.id),
    meetingId: String(row.meeting_id),
    ordinal: Number(row.ordinal),
    text: String(row.text),
    header: String(row.header),
    speakers: parseJsonColumn<string[]>(row.speakers, []),
    startMs: row.start_ms === null || row.start_ms === undefined ? null : Number(row.start_ms),
    endMs: row.end_ms === null || row.end_ms === undefined ? null : Number(row.end_ms),
    firstTurnIndex: Number(row.first_turn_index ?? 0),
    lastTurnIndex: Number(row.last_turn_index ?? 0),
    tokenCount: Number(row.token_count ?? 0),
  };
}

export function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export class Repository {
  private readonly db: DatabaseSync;

  // Written out rather than as a constructor parameter property so the CLI
  // scripts can run under Node's type-stripping, which rejects that syntax.
  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  findByChecksum(checksum: string): MeetingRecord | null {
    const row = this.db.prepare("SELECT * FROM meetings WHERE checksum = ?").get(checksum) as Row | undefined;
    return row ? rowToMeeting(row) : null;
  }

  listMeetings(): Meeting[] {
    const rows = this.db
      .prepare("SELECT * FROM meetings ORDER BY COALESCE(date, created_at) DESC, created_at DESC")
      .all() as Row[];
    return rows.map(rowToMeeting).map(({ transcript: _t, turns: _u, checksum: _c, ...meeting }) => meeting);
  }

  getMeeting(id: string): MeetingWithTurns | null {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const { transcript: _t, checksum: _c, ...rest } = rowToMeeting(row);
    return rest;
  }

  getTranscript(id: string): string | null {
    const row = this.db.prepare("SELECT transcript FROM meetings WHERE id = ?").get(id) as Row | undefined;
    return row ? String(row.transcript) : null;
  }

  /**
   * Writes a meeting, its chunks and its vectors in one transaction. A partially
   * ingested meeting is worse than no meeting: it would answer questions from
   * half a conversation without any sign that the rest is missing.
   */
  saveMeeting(meeting: MeetingRecord, chunks: Chunk[], vectors: number[][], embeddingModel: string): void {
    if (chunks.length !== vectors.length) {
      throw new Error(`chunk/vector length mismatch: ${chunks.length} vs ${vectors.length}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM meetings WHERE id = ? OR checksum = ?").run(meeting.id, meeting.checksum);
      this.db
        .prepare(
          `INSERT INTO meetings (id, title, date, source, created_at, duration_ms, participants, turn_count,
             chunk_count, token_count, format, warnings, brief, transcript, turns, checksum)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meeting.id,
          meeting.title,
          meeting.date,
          meeting.source,
          meeting.createdAt,
          meeting.durationMs,
          JSON.stringify(meeting.participants),
          meeting.turnCount,
          chunks.length,
          meeting.tokenCount,
          meeting.format,
          JSON.stringify(meeting.warnings),
          meeting.brief ? JSON.stringify(meeting.brief) : null,
          meeting.transcript,
          JSON.stringify(meeting.turns),
          meeting.checksum,
        );

      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (id, meeting_id, ordinal, text, header, speakers, start_ms, end_ms,
           first_turn_index, last_turn_index, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertVector = this.db.prepare("INSERT INTO embeddings (chunk_id, model, dim, vec) VALUES (?, ?, ?, ?)");

      for (const [index, chunk] of chunks.entries()) {
        insertChunk.run(
          chunk.id,
          chunk.meetingId,
          chunk.ordinal,
          chunk.text,
          chunk.header,
          JSON.stringify(chunk.speakers),
          chunk.startMs,
          chunk.endMs,
          chunk.firstTurnIndex,
          chunk.lastTurnIndex,
          chunk.tokenCount,
        );
        const vector = vectors[index] ?? [];
        insertVector.run(chunk.id, embeddingModel, vector.length, encodeVector(vector));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateBrief(meetingId: string, brief: MeetingBrief): void {
    this.db.prepare("UPDATE meetings SET brief = ? WHERE id = ?").run(JSON.stringify(brief), meetingId);
  }

  deleteMeeting(id: string): boolean {
    const result = this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  getChunk(id: string): Chunk | null {
    const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToChunk(row) : null;
  }

  getNeighbourChunks(meetingId: string, ordinals: number[]): Chunk[] {
    if (ordinals.length === 0) return [];
    const placeholders = ordinals.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE meeting_id = ? AND ordinal IN (${placeholders})`)
      .all(meetingId, ...ordinals) as Row[];
    return rows.map(rowToChunk);
  }

  meetingTitles(): Map<string, { title: string; date: string | null }> {
    const rows = this.db.prepare("SELECT id, title, date FROM meetings").all() as Row[];
    return new Map(
      rows.map((row) => [
        String(row.id),
        { title: String(row.title), date: row.date === null || row.date === undefined ? null : String(row.date) },
      ]),
    );
  }

  /**
   * Exact nearest neighbours by cosine similarity.
   *
   * Vectors are stored normalised, so the dot product *is* the cosine and the
   * inner loop is a single pass with no square roots. Scoped meetings are
   * filtered in SQL rather than after scoring, which is what keeps "ask this one
   * meeting" fast regardless of corpus size.
   *
   * `minScore` is not an optimisation: it is what allows the pipeline to conclude
   * that nothing relevant exists, since a top-k search otherwise always returns k
   * results no matter how unrelated they are.
   */
  denseSearch(query: number[], limit: number, meetingIds?: string[], minScore = 0): { chunk: Chunk; score: number }[] {
    const scoped = meetingIds && meetingIds.length > 0;
    const sql = scoped
      ? `SELECT c.*, e.vec AS vec FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.meeting_id IN (${meetingIds.map(() => "?").join(", ")})`
      : `SELECT c.*, e.vec AS vec FROM embeddings e JOIN chunks c ON c.id = e.chunk_id`;
    const rows = (scoped ? this.db.prepare(sql).all(...meetingIds) : this.db.prepare(sql).all()) as Row[];

    const queryVector = Float32Array.from(query);
    const scored: { chunk: Chunk; score: number }[] = [];
    for (const row of rows) {
      const vec = decodeVector(row.vec as Uint8Array);
      if (vec.length !== queryVector.length) continue; // index written by a different embedding model
      let dot = 0;
      for (let i = 0; i < vec.length; i += 1) dot += (vec[i] ?? 0) * (queryVector[i] ?? 0);
      if (dot < minScore) continue;
      scored.push({ chunk: rowToChunk(row), score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * BM25 over FTS5. Keeps the pipeline honest on the things dense retrieval is
   * bad at: proper nouns, ticket numbers, product names, exact quotes.
   */
  lexicalSearch(query: string, limit: number, meetingIds?: string[]): { chunk: Chunk; score: number }[] {
    const matchExpression = toMatchExpression(query);
    if (!matchExpression) return [];
    const scoped = meetingIds && meetingIds.length > 0;
    const sql = `SELECT c.*, bm25(chunks_fts) AS rank FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ?${scoped ? ` AND c.meeting_id IN (${meetingIds.map(() => "?").join(", ")})` : ""}
       ORDER BY rank LIMIT ?`;
    try {
      const params = scoped ? [matchExpression, ...meetingIds, limit] : [matchExpression, limit];
      const rows = this.db.prepare(sql).all(...params) as Row[];
      // bm25() returns negative numbers, better matches being more negative.
      return rows.map((row) => ({ chunk: rowToChunk(row), score: -Number(row.rank) }));
    } catch {
      // A syntactically invalid MATCH expression must degrade to dense-only
      // retrieval, never take down the request.
      return [];
    }
  }

  /**
   * How many chunks contain each term. Used to weight query terms by specificity
   * when deciding whether anything relevant was found at all.
   *
   * One FTS5 count per term. With a handful of terms and an indexed corpus this
   * costs well under a millisecond; a larger deployment would keep a term
   * statistics table instead of asking every time.
   */
  documentFrequencies(terms: string[]): Map<string, number> {
    const frequencies = new Map<string, number>();
    if (terms.length === 0) return frequencies;
    const statement = this.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?");
    for (const term of terms) {
      try {
        const row = statement.get(`"${term}"`) as Row | undefined;
        frequencies.set(term, Number(row?.n ?? 0));
      } catch {
        frequencies.set(term, 0);
      }
    }
    return frequencies;
  }

  countChunks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  saveTrace(trace: Trace): void {
    this.db
      .prepare("INSERT OR REPLACE INTO traces (id, created_at, payload) VALUES (?, ?, ?)")
      .run(trace.id, trace.createdAt, JSON.stringify(trace));
  }

  listTraces(limit = config.observability.traceListLimit): Trace[] {
    const rows = this.db.prepare("SELECT payload FROM traces ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows
      .map((row) => parseJsonColumn<Trace | null>(row.payload, null))
      .filter((trace): trace is Trace => trace !== null);
  }

  getTrace(id: string): Trace | null {
    const row = this.db.prepare("SELECT payload FROM traces WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJsonColumn<Trace | null>(row.payload, null) : null;
  }
}

/**
 * User text cannot go into a MATCH expression raw: FTS5 treats `-`, `"`, `*`,
 * `NEAR` and friends as operators, so a question like "what about the Q3 roadmap
 * (post-launch)?" is a syntax error. Every content term is quoted and OR-ed —
 * recall now, precision from fusion later.
 *
 * Stopwords are dropped rather than left to BM25's weighting. In a transcript
 * corpus, function words and fillers appear in nearly every chunk, so a query
 * whose only matches are "how", "much" and "does" returns a confident-looking
 * top-k of pure noise. Removing them is what lets the pipeline tell "no good
 * match" apart from "no match at all".
 */
export function toMatchExpression(query: string): string | null {
  const terms = contentTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}
