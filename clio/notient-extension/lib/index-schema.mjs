export const indexVersion = 2;
export const wordCountVersion = 'unicode-prose-v7';
export const graphRule = 'typed-wiki-v3';

export function migrateIndex(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === indexVersion) return;
  if (version !== 1) throw new Error('Unsupported index version.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_spaces (
        space_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
        response_model TEXT, dim INTEGER NOT NULL CHECK(dim BETWEEN 1 AND 8192),
        pack_file TEXT, pack_slots INTEGER NOT NULL DEFAULT 0 CHECK(pack_slots >= 0),
        generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
        corpus_generation INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vec_meta (
        space_id TEXT NOT NULL REFERENCES vector_spaces(space_id) ON DELETE CASCADE,
        chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        path TEXT NOT NULL, revision TEXT NOT NULL, text_hash TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK(slot >= 0), scale REAL NOT NULL CHECK(scale > 0),
        model TEXT NOT NULL, dim INTEGER NOT NULL CHECK(dim BETWEEN 1 AND 8192),
        PRIMARY KEY(space_id, chunk_id), UNIQUE(space_id, slot)
      );
      CREATE TABLE IF NOT EXISTS candidate_sets (
        id TEXT PRIMARY KEY, vault TEXT NOT NULL, source TEXT NOT NULL, revision TEXT NOT NULL,
        space_id TEXT NOT NULL, index_generation INTEGER NOT NULL, inventory_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS note_vitals (
        path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
        revision TEXT NOT NULL, word_count INTEGER NOT NULL CHECK(word_count >= 0),
        last_user_edit_ms REAL NOT NULL, maturity TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR REPLACE INTO meta VALUES ('schemaVersion', '2');
      INSERT OR IGNORE INTO meta VALUES ('preprocessingVersion', '1');
      PRAGMA user_version = 2;
    `);
    db.prepare("INSERT OR IGNORE INTO meta VALUES ('wordCountVersion', ?)").run(wordCountVersion);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
