import { openIndex, unknownCoverageMessage } from './index.mjs';
import { listNotes } from './vault.mjs';
import { readNote, portableName } from './paths.mjs';
import { arithmeticVitals, maturities, connectivityTiers } from './vitals.mjs';
import { graphDegrees } from './vitals-index.mjs';
import { graphRule } from './index-schema.mjs';

export const unknownVitalsCoverage = () => ({ state: 'unknown', indexing: { state: 'unavailable', reason: 'structural_index_missing' }, message: unknownCoverageMessage });

export function structuralCoverage(db, vault) {
  const records = new Map(db.prepare('SELECT path,size,mtime,ctime FROM notes').all().map(row => [row.path, row]));
  const scan = listNotes(vault.path);
  let pending = 0;
  for (const entry of scan.notes) {
    const old = records.get(entry.path);
    if (!old || old.size !== entry.stat.size || old.mtime !== entry.stat.mtimeMs || old.ctime !== entry.stat.ctimeMs) pending++;
    records.delete(entry.path);
  }
  pending += records.size;
  const previous = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='structuralErrors'").get()?.value ?? '{}');
  const missingVitals = db.prepare('SELECT count(*) AS n FROM notes n LEFT JOIN note_vitals v ON n.path=v.path AND n.revision=v.revision WHERE v.path IS NULL').get().n;
  const skipped = Math.max(scan.skipped.length, previous.skipped ?? 0);
  const errors = previous.errors ?? 0;
  const graphIssues = Object.values(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='graphIssuePaths'").get()?.value ?? '{}')).reduce((count, value) => count + value, 0);
  const graphBackfill = db.prepare("SELECT value FROM meta WHERE key='graphRule'").get()?.value !== graphRule;
  const state = pending || skipped || errors || missingVitals || graphIssues || graphBackfill ? 'incomplete' : 'current';
  return { state, indexing: { state: 'ready', pending, skipped, errors, missingVitals, graphIssues, graphBackfill }, message: state === 'current' ? null : 'Structural metrics use a refresh snapshot; changed or skipped notes prevent complete graph coverage.' };
}

function valueFor(row, graph, db, now) {
  const chunkCoverage = row.word_count > 0 && db.prepare('SELECT 1 FROM chunks c JOIN blocks b ON b.id=c.block WHERE c.path=? AND b.kind=\'paragraph\' LIMIT 1').get(row.path) ? 1 : 0;
  return arithmeticVitals({ words: row.word_count, ...graph.get(row.path), chunkCoverage, lastUserEditMs: row.last_user_edit_ms, maturity: row.maturity }, now);
}

export function noteVitals(db, vault, name, liveRevision, now) {
  const computedAt = new Date(now).toISOString();
  if (!db) return { state: 'unknown', snapshotRevision: null, values: null, computedAt };
  const snapshotRevision = db.prepare('SELECT revision FROM notes WHERE path=?').get(name)?.revision ?? null;
  if (db.prepare('PRAGMA user_version').get().user_version < 2) return { state: 'unknown', snapshotRevision, values: null, computedAt };
  const row = db.prepare('SELECT * FROM note_vitals WHERE path=?').get(name);
  if (!row || row.revision !== liveRevision || snapshotRevision !== liveRevision) return { state: 'incomplete', snapshotRevision, values: null, computedAt };
  return { state: structuralCoverage(db, vault).state, snapshotRevision, values: valueFor(row, graphDegrees(db), db, now), computedAt };
}

export function readVitals(vault, directory, input = {}, { now = () => Date.now() } = {}) {
  const stamp = now();
  const computedAt = new Date(stamp).toISOString();
  const limit = input.limit ?? 20;
  const sort = input.sort ?? 'health';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !['health', 'freshness', 'words'].includes(sort) || input.maturity !== undefined && !maturities.includes(input.maturity) || input.connectivityTier !== undefined && !connectivityTiers.includes(input.connectivityTier)) throw new Error('Invalid vitals filters or bounds.');
  if (input.folder !== undefined) {
    if (typeof input.folder !== 'string' || !input.folder.length || input.folder.length > 4096) throw new Error('Folder must be a normalized vault-relative component prefix.');
    input.folder.split('/').forEach(portableName);
  }
  const db = openIndex(directory, vault);
  if (!db) return { ok: true, tool: 'vitals', vault: vault.id, notes: [], computedAt, indexGeneration: null, coverage: unknownVitalsCoverage(), remaining: 0 };
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA user_version').get().user_version < 2) return { ok: true, tool: 'vitals', vault: vault.id, notes: [], computedAt, indexGeneration: null, coverage: unknownVitalsCoverage(), remaining: db.prepare('SELECT count(*) AS n FROM notes').get().n };
    const coverage = structuralCoverage(db, vault);
    const graph = graphDegrees(db);
    const rows = db.prepare('SELECT v.* FROM note_vitals v JOIN notes n ON n.path=v.path AND n.revision=v.revision').all();
    const selected = rows.filter(row => input.folder === undefined || row.path.startsWith(`${input.folder}/`)).map(row => ({ path: row.path, revision: row.revision, vitals: valueFor(row, graph, db, stamp) })).filter(row => (!input.maturity || row.vitals.maturity === input.maturity) && (!input.connectivityTier || row.vitals.connectivityTier === input.connectivityTier));
    selected.sort((a, b) => (sort === 'words' ? b.vitals.words - a.vitals.words : a.vitals[sort] - b.vitals[sort]) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const notes = [];
    for (const row of selected.slice(0, limit)) {
      try { if (readNote(vault.path, row.path).revision === row.revision) { notes.push(row); continue; } } catch {}
      coverage.state = 'incomplete'; coverage.message = 'A selected note changed or disappeared after the structural snapshot; refresh before relying on graph absence.';
    }
    return { ok: true, tool: 'vitals', vault: vault.id, notes, computedAt, indexGeneration: Number(db.prepare("SELECT value FROM meta WHERE key='indexGeneration'").get()?.value ?? 0), coverage, remaining: selected.length - notes.length };
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
