import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "./schema";

export const SCHEMA_VERSION = 1;

export const INITIAL_SCHEMA = `
-- Core metadata
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  title TEXT,
  health_score REAL,
  para_type TEXT,
  word_count INTEGER
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_path TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_path, tag),
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

CREATE TABLE IF NOT EXISTS note_meta (
  note_path TEXT NOT NULL,
  key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  PRIMARY KEY (note_path, key),
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

-- Chunks (model-agnostic)
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL,
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_chunk_id TEXT,
  heading_path TEXT, -- JSON array
  text TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

-- Embeddings (model-scoped)
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector BLOB NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

-- Actions
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  workflow_id TEXT,
  type TEXT NOT NULL,
  risk TEXT NOT NULL,
  note_path TEXT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  undone_at INTEGER,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  undo_payload TEXT NOT NULL,
  changed_paths TEXT NOT NULL
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  note_path TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  thinking TEXT,
  created_at INTEGER NOT NULL,
  attachments TEXT,
  status TEXT,
  reasoning_summary TEXT,
  action_ref TEXT
);

-- Intelligence
CREATE TABLE IF NOT EXISTS intelligence (
  note_path TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intelligence_topic ON intelligence(topic);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime);
CREATE INDEX IF NOT EXISTS idx_notes_health ON notes(health_score);
CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_key);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_note ON messages(note_path);
`;

export async function migrateToLatest(db: Kysely<Database>) {
  // For now, we just run the initial schema.
  // In the future, we can add version tracking and incremental migrations.

  // sql.js prepare() expects single statements, so split and execute individually
  const statements = INITIAL_SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}
