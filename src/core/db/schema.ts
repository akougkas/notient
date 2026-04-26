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

export const SCHEMA_V2 = [
  // staging_edges: agent proposals before user approval. Promoted to graph_edges
  // by ApprovalService. Rejected rows are deleted.
  `CREATE TABLE IF NOT EXISTS staging_edges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    agent TEXT NOT NULL,
    evidence TEXT NOT NULL,
    rationale TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decision TEXT
  );`,
  "CREATE INDEX IF NOT EXISTS staging_edges_agent ON staging_edges(agent);",
  "CREATE INDEX IF NOT EXISTS staging_edges_decided ON staging_edges(decided_at);",
  "CREATE INDEX IF NOT EXISTS staging_edges_source ON staging_edges(source_id);",
  // staging_nodes: claim/concept/question proposals that don't yet have a home in
  // the live graph. Synthesizer + Contradiction Hunter use this for proposed
  // synthesis-note shells before the user accepts.
  `CREATE TABLE IF NOT EXISTS staging_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    note_path TEXT,
    payload TEXT,
    agent TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decision TEXT
  );`,
  "CREATE INDEX IF NOT EXISTS staging_nodes_agent ON staging_nodes(agent);",
  // agent_runs: provenance / status footer / debug trail.
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    trigger TEXT NOT NULL,
    note_path TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    error TEXT,
    proposals_count INTEGER NOT NULL DEFAULT 0
  );`,
  "CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at);",
  "CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent);",
];
