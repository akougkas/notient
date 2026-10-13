import { graphRule, wordCountVersion } from './index-schema.mjs';

export function parserVersions(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_parse_versions'").get()) return new Map();
  return new Map(db.prepare('SELECT * FROM note_parse_versions').all().map(row => [row.path, row]));
}

export function currentParser(row) {
  return row?.graph_rule === graphRule && row?.word_count_version === wordCountVersion;
}

export function recordParserVersion(db, name) {
  db.prepare('INSERT OR REPLACE INTO note_parse_versions VALUES (?, ?, ?)').run(name, graphRule, wordCountVersion);
}
