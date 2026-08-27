import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";

/**
 * Storage: one SQLite file holding meetings, chunks, embeddings, the full-text
 * index and query traces.
 *
 * Why not a dedicated vector database? At the scale this app is built for —
 * hundreds of meetings, tens of thousands of chunks — an exact scan over
 * Float32 blobs takes single-digit milliseconds and returns exact neighbours
 * rather than approximate ones. Adding Postgres/pgvector, Qdrant or Pinecone
 * would buy nothing except a service to run, and would cost the reviewer a
 * `docker compose up` before they can see anything. The cost of being wrong is
 * bounded: `VectorIndex` is an interface with one implementation, and the
 * README spells out when and how to swap it.
 *
 * SQLite also gives BM25 for free through FTS5, which is what makes hybrid
 * retrieval possible without a second system.
 */

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  duration_ms   INTEGER,
  participants  TEXT NOT NULL DEFAULT '[]',
  turn_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  token_count   INTEGER NOT NULL DEFAULT 0,
  format        TEXT NOT NULL DEFAULT 'unknown',
  warnings      TEXT NOT NULL DEFAULT '[]',
  brief         TEXT,
  transcript    TEXT NOT NULL,
  turns         TEXT NOT NULL DEFAULT '[]',
  -- Content hash: re-uploading the same file replaces it instead of duplicating
  -- every chunk, which would otherwise poison retrieval with exact duplicates.
  checksum      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS chunks (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  text              TEXT NOT NULL,
  header            TEXT NOT NULL,
  speakers          TEXT NOT NULL DEFAULT '[]',
  start_ms          INTEGER,
  end_ms            INTEGER,
  first_turn_index  INTEGER NOT NULL DEFAULT 0,
  last_turn_index   INTEGER NOT NULL DEFAULT 0,
  token_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id, ordinal);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id  TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);
`;

/**
 * FTS5 external-content tables do not update themselves. Triggers keep the index
 * in step with `chunks` so there is no code path that can forget to reindex.
 */
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

// Next.js reloads modules on every edit in dev; without this the process would
// accumulate open database handles until it runs out of file descriptors.
const globalForDb = globalThis as unknown as { __meetingDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalForDb.__meetingDb) return globalForDb.__meetingDb;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  initialise(db);
  globalForDb.__meetingDb = db;
  return db;
}

/** In-memory database for tests: same schema, no file, no cleanup. */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initialise(db);
  return db;
}

function initialise(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(TRIGGERS);
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
}

/** Float32 keeps the file half the size of Float64 with no measurable recall change. */
export function encodeVector(vector: number[]): Uint8Array {
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // The blob is copied because SQLite may reuse the underlying buffer.
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
