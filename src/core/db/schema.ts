/**
 * SQLite schema for Notient - 5-table structure
 * Source of truth: .planning/PHASE-GALAXY.md
 */

export const SCHEMA_SQL = `
-- Table 1: Notes metadata
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  hash TEXT,
  indexed_at INTEGER,
  last_enhanced INTEGER
);

-- Table 2: Chunks (hierarchical semantic)
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT REFERENCES notes(path) ON DELETE CASCADE,
  content TEXT,
  chunk_type TEXT,
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT
);

-- Table 3: Embeddings
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT,
  vector BLOB,
  created_at INTEGER,
  PRIMARY KEY (chunk_id, model)
);

-- Table 4: Actions (undo - last 50)
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  note_path TEXT,
  action_type TEXT,
  before_state TEXT,
  after_state TEXT,
  applied_at INTEGER,
  undone INTEGER DEFAULT 0
);

-- Table 5: Intelligence cache
CREATE TABLE IF NOT EXISTS intelligence (
  note_path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
  analysis TEXT,
  suggestions TEXT,
  health_score INTEGER,
  summary TEXT,
  version INTEGER,
  analyzed_at INTEGER
);

-- Prune trigger: Keep only 50 most recent actions
CREATE TRIGGER IF NOT EXISTS prune_actions AFTER INSERT ON actions
BEGIN
  DELETE FROM actions WHERE id NOT IN (
    SELECT id FROM actions ORDER BY applied_at DESC LIMIT 50
  );
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks(note_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);
CREATE INDEX IF NOT EXISTS idx_actions_note_path ON actions(note_path);
CREATE INDEX IF NOT EXISTS idx_actions_applied_at ON actions(applied_at);
`;
