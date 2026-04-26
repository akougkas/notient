export const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    sha TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    maturity TEXT NOT NULL DEFAULT 'raw',
    health REAL NOT NULL DEFAULT 0,
    freshness REAL NOT NULL DEFAULT 1,
    indexed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  "CREATE INDEX IF NOT EXISTS notes_updated_at ON notes(updated_at);",
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    sha TEXT NOT NULL,
    UNIQUE(note_path, ord)
  );`,
  "CREATE INDEX IF NOT EXISTS chunks_note_path ON chunks(note_path);",
  `CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    note_path TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL
  );`,
  "CREATE INDEX IF NOT EXISTS graph_nodes_type ON graph_nodes(type);",
  "CREATE INDEX IF NOT EXISTS graph_nodes_note_path ON graph_nodes(note_path);",
  `CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    agent TEXT NOT NULL,
    evidence TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`,
  "CREATE INDEX IF NOT EXISTS graph_edges_source ON graph_edges(source_id);",
  "CREATE INDEX IF NOT EXISTS graph_edges_target ON graph_edges(target_id);",
  "CREATE INDEX IF NOT EXISTS graph_edges_type ON graph_edges(type);",
  "CREATE INDEX IF NOT EXISTS graph_edges_approved ON graph_edges(approved);",
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    before TEXT,
    after TEXT,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );`,
];
