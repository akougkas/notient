import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { indexPath } from './config.mjs';
import { listNotes } from './vault.mjs';
import { readNote, revision, currentFile } from './paths.mjs';
import { readBlob } from './journal.mjs';
import { parseMarkdown, resolveLink, sourceRange } from './markdown.mjs';
import { lastCommit } from './git.mjs';
import { provenanceWorkspace } from './capture.mjs';
import { migrateIndex, indexVersion, graphRule, wordCountVersion } from './index-schema.mjs';
import { proseMetrics } from './vitals.mjs';
import { storedVitals, installVitals } from './vitals-index.mjs';
import { tokenizeMove, inventoryIndex, resolveMoveTarget } from './move.mjs';
import { relationSpans } from './relate.mjs';
import { withIndexWriter } from './index-lock.mjs';

export const unknownCoverageMessage = 'Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes.';

export function probeFts5() {
  let db;
  try {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE temp.x USING fts5(a)');
    return true;
  } catch {
    return false;
  } finally { db?.close(); }
}

export function unavailableFts5Coverage() {
  return { state: 'unknown', indexing: { state: 'unavailable', reason: 'fts5_unavailable' }, message: unknownCoverageMessage };
}

export function openIndex(directory, vault, writable = false, { immutable = false, deadline = Infinity, now = () => performance.now() } = {}) {
  const filename = indexPath(directory, vault);
  if (!writable && !existsSync(filename)) return null;
  if (writable) mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (immutable && writable) throw new Error('Immutable index reads cannot be writable.');
  const db = new DatabaseSync(immutable ? `${pathToFileURL(filename).href}?immutable=1` : filename, { readOnly: !writable });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(5000, Math.floor(deadline - now())))}; PRAGMA foreign_keys = ON;`);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, indexVersion].includes(version)) throw new Error('Unsupported index version.');
    if (version === 0 && !writable) throw new Error('Index is incomplete. Run refresh.');
    if (writable) {
      chmodSync(filename, 0o600);
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          path TEXT PRIMARY KEY, revision TEXT NOT NULL, size INTEGER NOT NULL,
          mtime REAL NOT NULL, ctime REAL NOT NULL, aliases TEXT NOT NULL, outline TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blocks (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          kind TEXT NOT NULL, heading TEXT NOT NULL, source TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          block INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
          heading TEXT NOT NULL, source TEXT NOT NULL, passage TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(passage, tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE IF NOT EXISTS links (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
          payload TEXT NOT NULL, target_path TEXT, resolution TEXT NOT NULL, candidates TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
        CREATE INDEX IF NOT EXISTS links_path ON links(path);
        CREATE INDEX IF NOT EXISTS blocks_path ON blocks(path);
        CREATE INDEX IF NOT EXISTS chunks_block ON chunks(block);
        CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
        CREATE TABLE IF NOT EXISTS tags (
          path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(path, tag)
        );
        CREATE TABLE IF NOT EXISTS note_workspaces (
          path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE, workspace TEXT
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS own_revisions (path TEXT NOT NULL, revision TEXT, operation TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(path, operation));
        CREATE TABLE IF NOT EXISTS served (
          id INTEGER PRIMARY KEY, call_id TEXT NOT NULL, at TEXT NOT NULL,
          path TEXT NOT NULL, revision TEXT NOT NULL, source TEXT NOT NULL,
          passage TEXT NOT NULL, passage_hash TEXT NOT NULL
        );
      `);
      if (version === 0) db.exec('PRAGMA user_version = 1');
      migrateIndex(db);
      if (db.prepare("SELECT value FROM meta WHERE key='workspaceRule'").get()?.value !== 'property-v1') {
        db.exec("BEGIN IMMEDIATE; DELETE FROM note_workspaces; INSERT OR REPLACE INTO meta VALUES ('workspaceRule','property-v1'); COMMIT");
      }
    } else db.exec('PRAGMA query_only = ON;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function deleteNote(db, name) {
  db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)').run(name);
  db.prepare('DELETE FROM notes WHERE path = ?').run(name);
}

function sameStat(record, stat) {
  return record.size === stat.size && record.mtime === stat.mtimeMs && record.ctime === stat.ctimeMs;
}

function snapshotLinks(bytes, parsed) {
  const tokenized = tokenizeMove(bytes, { visibility: true });
  const text = bytes.toString('utf8');
  const typed = relationSpans(bytes);
  const wiki = tokenized.tokens.filter(token => token.kind === 'wiki' && !token.unsafe).map(token => ({ kind: 'wiki', target: token.yamlQuote === "'" ? token.target.replaceAll("''", "'") : token.target, fragment: token.fragment ? token.fragment.slice(1) : null, alias: token.alias, embed: token.embed, source: sourceRange(text, text.lastIndexOf('[[', token.start), token.finish), ...(typed.find(span => span.start <= token.start && span.end >= token.finish) ? { relation: typed.find(span => span.start <= token.start && span.end >= token.finish).relation } : {}) }));
  return { links: [...parsed.links.filter(link => link.kind !== 'wiki'), ...wiki], metrics: proseMetrics(bytes, parsed, tokenized), issues: tokenized.issues.length + tokenized.tokens.filter(token => token.unsafe).length };
}

function resolveSnapshotLink(link, source, notes, index) {
  if (link.kind !== 'wiki') return resolveLink(link, source, notes);
  const result = resolveMoveTarget({ kind: 'wiki', target: link.target, fragment: link.fragment ? `#${link.fragment}` : '' }, source, index);
  return { resolution: result.state === 'missing' ? 'unresolved' : result.state, candidates: result.candidates };
}

export function refreshIndex(vault, directory, options = {}) {
  return withIndexWriter(vault, directory, () => refreshLocked(vault, directory, options));
}

function refreshLocked(vault, directory, { force = false, now = () => Date.now(), maxChanged = Infinity, budgetMs = Infinity, promotionEpoch, promotionLimit = Infinity } = {}) {
  const started = performance.now();
  const db = openIndex(directory, vault, true);
  const computedAt = now();
  let changed = 0;
  let unchanged = 0;
  let deleted = 0;
  let hashed = 0;
  const errors = [];
  let remaining = 0; let cursor = null;
  try {
    if (promotionEpoch) {
      const cached = db.prepare('SELECT value FROM meta WHERE key=?').get(`gardenTick.${promotionEpoch}`);
      if (cached) return JSON.parse(cached.value);
    }
    const scan = listNotes(vault.path);
    db.exec('BEGIN IMMEDIATE');
    const priorVitals = storedVitals(db);
    const metrics = new Map();
    const graphIssues = new Map(Object.entries(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='graphIssuePaths'").get()?.value ?? '{}')));
    const rebuildGraph = db.prepare("SELECT value FROM meta WHERE key='graphRule'").get()?.value !== graphRule || db.prepare("SELECT value FROM meta WHERE key='wordCountVersion'").get()?.value !== wordCountVersion;
    const rebuild = db.prepare("SELECT value FROM meta WHERE key='vitalsInitialized'").get()?.value !== '1';
    const previous = new Map(db.prepare('SELECT n.*, w.path AS workspaceIndexed FROM notes n LEFT JOIN note_workspaces w ON w.path=n.path').all().map(row => [row.path, row]));
    const present = new Set(scan.notes.map(note => note.path));
    for (const oldPath of previous.keys()) {
      if (!present.has(oldPath)) { deleteNote(db, oldPath); graphIssues.delete(oldPath); deleted++; }
    }
    for (const entry of scan.notes) {
      const old = previous.get(entry.path);
      if (!force && !rebuildGraph && old?.workspaceIndexed && priorVitals.get(entry.path)?.revision === old.revision && sameStat(old, entry.stat)) { unchanged++; continue; }
      if (hashed >= maxChanged || performance.now() - started >= budgetMs) { remaining++; continue; }
      let content;
      let parsed;
      let structural;
      try {
        content = readNote(vault.path, entry.path);
        hashed++;
        cursor = entry.path;
        if (old?.revision === content.revision && !rebuildGraph) {
          if (priorVitals.get(entry.path)?.revision !== content.revision) {
            const structural = snapshotLinks(content.bytes, parseMarkdown(content.text, entry.path));
            metrics.set(entry.path, structural.metrics);
            if (structural.issues) graphIssues.set(entry.path, structural.issues); else graphIssues.delete(entry.path);
          }
          db.prepare('UPDATE notes SET size = ?, mtime = ?, ctime = ? WHERE path = ?').run(content.stat.size, content.stat.mtimeMs, content.stat.ctimeMs, entry.path);
          db.prepare('INSERT OR REPLACE INTO note_workspaces VALUES (?, ?)').run(entry.path, provenanceWorkspace(content.bytes));
          unchanged++;
          continue;
        }
        parsed = parseMarkdown(content.text, entry.path);
        structural = snapshotLinks(content.bytes, parsed);
        metrics.set(entry.path, structural.metrics);
        if (structural.issues) graphIssues.set(entry.path, structural.issues); else graphIssues.delete(entry.path);
      } catch (error) {
        deleteNote(db, entry.path);
        graphIssues.delete(entry.path);
        errors.push({ path: entry.path, reason: error.message });
        continue;
      }
      deleteNote(db, entry.path);
      db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)').run(entry.path, content.revision, content.stat.size, content.stat.mtimeMs, content.stat.ctimeMs, JSON.stringify(parsed.aliases), JSON.stringify(parsed.outline));
      db.prepare('INSERT INTO note_workspaces VALUES (?, ?)').run(entry.path, provenanceWorkspace(content.bytes));
      const blockIds = parsed.blocks.map(block => db.prepare('INSERT INTO blocks(path, kind, heading, source) VALUES (?, ?, ?, ?)').run(entry.path, block.kind, JSON.stringify(block.headingPath), JSON.stringify(block.source)).lastInsertRowid);
      for (const chunk of parsed.chunks) {
        const id = db.prepare('INSERT INTO chunks(path, block, heading, source, passage) VALUES (?, ?, ?, ?, ?)').run(entry.path, blockIds[chunk.block], JSON.stringify(chunk.headingPath), JSON.stringify(chunk.source), chunk.passage).lastInsertRowid;
        db.prepare('INSERT INTO chunks_fts(rowid, passage) VALUES (?, ?)').run(id, chunk.passage);
      }
      for (const link of structural.links) db.prepare('INSERT INTO links(path, payload, resolution, candidates) VALUES (?, ?, ?, ?)').run(entry.path, JSON.stringify(link), 'unresolved', '[]');
      for (const tag of parsed.tags) db.prepare('INSERT INTO tags VALUES (?, ?)').run(entry.path, tag);
      if (old?.revision === content.revision) unchanged++; else changed++;
    }
    if (rebuildGraph || changed || deleted || errors.length) {
      const notes = db.prepare('SELECT path, aliases FROM notes').all().map(row => ({ ...row, aliases: JSON.parse(row.aliases) }));
      const index = inventoryIndex(notes.map(note => note.path), notes);
      for (const row of db.prepare('SELECT id, path, payload FROM links').all()) {
        const resolved = resolveSnapshotLink(JSON.parse(row.payload), row.path, notes, index);
        db.prepare('UPDATE links SET target_path = ?, resolution = ?, candidates = ? WHERE id = ?').run(resolved.resolution === 'resolved' ? resolved.candidates[0] : null, resolved.resolution, JSON.stringify(resolved.candidates), row.id);
      }
    }
    const completedAt = new Date().toISOString();
    const promoted = installVitals(db, vault, directory, priorVitals, metrics, computedAt, { advance: true, rebuild, promotionEpoch, promotionLimit });
    if (promotionEpoch) db.prepare("INSERT OR REPLACE INTO meta VALUES ('gardenScan',?)").run(JSON.stringify({ runId: promotionEpoch, cursor, remaining }));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('indexGeneration', ?)").run(String(Number(db.prepare("SELECT value FROM meta WHERE key='indexGeneration'").get()?.value ?? 0) + 1));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('structuralErrors', ?)").run(JSON.stringify({ skipped: scan.skipped.length, errors: errors.length }));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('graphIssuePaths', ?)").run(JSON.stringify(Object.fromEntries(graphIssues)));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('graphRule', ?)").run(graphRule);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('wordCountVersion', ?)").run(wordCountVersion);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshedAt', ?)").run(completedAt);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('lastCommit', ?)").run(JSON.stringify(lastCommit(vault.path)));
    const visited = promotionEpoch ? JSON.parse(db.prepare("SELECT value FROM meta WHERE key='gardenPromotions'").get().value).paths.length : 0;
    const vitalsRemaining = promotionEpoch ? db.prepare('SELECT count(*) AS n FROM notes').get().n - JSON.parse(db.prepare("SELECT value FROM meta WHERE key='gardenVitalsCycle'").get().value).length : 0;
    const result = { vault: vault.id, scanned: scan.notes.length, changed, unchanged, deleted, hashed, skipped: scan.skipped.slice(0, 100), skippedCount: scan.skipped.length, errors: errors.slice(0, 100), errorCount: errors.length, completedAt, ...(promotionEpoch ? { cursor, remaining, promoted, vitalsVisited: visited, vitalsRemaining } : {}), durationMs: Math.round((performance.now() - started) * 100) / 100 };
    if (promotionEpoch) db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(`gardenTick.${promotionEpoch}`, JSON.stringify(result));
    db.exec('COMMIT'); return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

export function indexSummary(vault, directory, checkFiles = true) {
  const db = openIndex(directory, vault);
  if (!db) return { state: 'missing', notes: 0, chunks: 0, refreshedAt: null, freshness: 'never indexed' };
  try {
    const counts = {};
    for (const table of ['notes', 'blocks', 'chunks', 'links', 'tags', 'served']) counts[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    const refreshedAt = db.prepare("SELECT value FROM meta WHERE key = 'refreshedAt'").get()?.value ?? null;
    const editAgeFallbackPaths = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='editAgeFallbackPaths'").get()?.value ?? '[]');
    const attribution = { editAgeFallbackCount: editAgeFallbackPaths.length, editAgeFallbackPaths: editAgeFallbackPaths.slice(0, 100) };
    if (!checkFiles) return { state: 'ready', ...counts, refreshedAt, ...attribution, freshness: 'last refresh only; files not scanned' };
    const records = new Map(db.prepare('SELECT * FROM notes').all().map(row => [row.path, row]));
    const scan = listNotes(vault.path);
    let pending = 0;
    for (const note of scan.notes) {
      if (!records.has(note.path) || !sameStat(records.get(note.path), note.stat)) pending++;
      records.delete(note.path);
    }
    pending += records.size;
    return { state: 'ready', ...counts, refreshedAt, ...attribution, pending, skippedCount: scan.skipped.length, freshness: pending ? 'changed since refresh' : 'current by file metadata' };
  } finally { db.close(); }
}

export function repairCommittedIndex(vault, directory, record) {
  if (!existsSync(indexPath(directory, vault)) || !probeFts5()) return false;
  return withIndexWriter(vault, directory, () => repairLocked(vault, directory, record));
}

function repairLocked(vault, directory, record) {
  const db = openIndex(directory, vault, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    const priorVitals = storedVitals(db);
    const metrics = new Map();
    const graphIssues = new Map(Object.entries(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='graphIssuePaths'").get()?.value ?? '{}')));
    for (const file of record.files) {
      db.prepare('INSERT OR REPLACE INTO own_revisions VALUES (?, ?, ?, ?)').run(file.path, file.after, record.id, record.createdAt);
      const current = currentFile(vault.path, file.path);
      if (current.revision !== file.after) continue;
      deleteNote(db, file.path);
      if (file.after === null) { graphIssues.delete(file.path); continue; }
      const bytes = readBlob(directory, vault, record.id, file.after);
      const parsed = parseMarkdown(bytes.toString('utf8'), file.path);
      const structural = snapshotLinks(bytes, parsed);
      metrics.set(file.path, structural.metrics);
      if (structural.issues) graphIssues.set(file.path, structural.issues); else graphIssues.delete(file.path);
      db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)').run(file.path, file.after, current.stat.size, current.stat.mtimeMs, current.stat.ctimeMs, JSON.stringify(parsed.aliases), JSON.stringify(parsed.outline));
      db.prepare('INSERT INTO note_workspaces VALUES (?, ?)').run(file.path, provenanceWorkspace(bytes));
      const blocks = parsed.blocks.map(block => db.prepare('INSERT INTO blocks(path, kind, heading, source) VALUES (?, ?, ?, ?)').run(file.path, block.kind, JSON.stringify(block.headingPath), JSON.stringify(block.source)).lastInsertRowid);
      for (const chunk of parsed.chunks) {
        const id = db.prepare('INSERT INTO chunks(path, block, heading, source, passage) VALUES (?, ?, ?, ?, ?)').run(file.path, blocks[chunk.block], JSON.stringify(chunk.headingPath), JSON.stringify(chunk.source), chunk.passage).lastInsertRowid;
        db.prepare('INSERT INTO chunks_fts(rowid, passage) VALUES (?, ?)').run(id, chunk.passage);
      }
      for (const link of structural.links) db.prepare('INSERT INTO links(path, payload, resolution, candidates) VALUES (?, ?, ?, ?)').run(file.path, JSON.stringify(link), 'unresolved', '[]');
      for (const tag of parsed.tags) db.prepare('INSERT INTO tags VALUES (?, ?)').run(file.path, tag);
    }
    const notes = db.prepare('SELECT path, aliases FROM notes').all().map(note => ({ path: note.path, aliases: JSON.parse(note.aliases) }));
    const index = inventoryIndex(notes.map(note => note.path), notes);
    const update = db.prepare('UPDATE links SET target_path = ?, resolution = ?, candidates = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, path, payload FROM links').all()) {
      const resolved = resolveSnapshotLink(JSON.parse(row.payload), row.path, notes, index);
      update.run(resolved.resolution === 'resolved' ? resolved.candidates[0] : null, resolved.resolution, JSON.stringify(resolved.candidates), row.id);
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('lastCommit', ?)").run(JSON.stringify(lastCommit(vault.path)));
    installVitals(db, vault, directory, priorVitals, metrics, Date.now(), { record });
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('graphIssuePaths', ?)").run(JSON.stringify(Object.fromEntries(graphIssues)));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('indexGeneration', ?)").run(String(Number(db.prepare("SELECT value FROM meta WHERE key='indexGeneration'").get()?.value ?? 0) + 1));
    db.exec('COMMIT');
    return true;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export function searchIndex(vault, directory, { query, limit = 10, sourcePath, workspace }) {
  const started = performance.now();
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Search limit must be between 1 and 20.');
  if (typeof query !== 'string' || query.length > 4000) throw new Error('Search query must contain at most 4000 characters.');
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.length || workspace.length > 255)) throw new Error('Workspace must contain between 1 and 255 characters.');
  const allTerms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const terms = allTerms.slice(0, 32);
  if (!terms.length) throw new Error('Search query must include a word or number.');
  const callId = randomUUID();
  if (!probeFts5()) {
    return {
      vault: vault.id, callId, query, terms, termsTruncated: allTerms.length > terms.length,
      excludedSource: sourcePath ?? null, hits: [], stalePaths: [], refreshRequired: false,
      candidateLimitReached: false, fts5: false, nodeVersion: process.version,
      coverage: unavailableFts5Coverage(), durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }
  if (!existsSync(indexPath(directory, vault))) throw new Error('Index is missing. Run refresh for this vault first.');
  const db = openIndex(directory, vault, true);
  try {
    if (workspace !== undefined && db.prepare('SELECT count(*) AS count FROM notes n LEFT JOIN note_workspaces w ON w.path=n.path WHERE w.path IS NULL').get().count) refreshIndex(vault, directory);
    const match = terms.map(term => `"${term}"`).join(' OR ');
    const hits = [];
    const stale = new Set();
    const files = new Map();
    let examined = 0;
    const rows = db.prepare(`SELECT c.*, n.revision, bm25(chunks_fts) AS score
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.path = c.path JOIN blocks b ON b.id = c.block
      WHERE chunks_fts MATCH ? AND b.kind != 'heading' AND c.path NOT GLOB 'Notient/Plans/*' AND c.path NOT GLOB 'Notient/Digest/*' AND (? IS NULL OR c.path != ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM note_workspaces w WHERE w.path=n.path AND w.workspace=?))
      ORDER BY score, c.path, c.id LIMIT 1000`).iterate(match, sourcePath ?? null, sourcePath ?? null, workspace ?? null, workspace ?? null);
    for (const row of rows) {
      examined++;
      if (!files.has(row.path)) {
        try { files.set(row.path, readNote(vault.path, row.path)); } catch { files.set(row.path, null); }
      }
      const current = files.get(row.path);
      const source = JSON.parse(row.source);
      if (!current || current.revision !== row.revision || current.bytes.subarray(source.startByte, source.endByte).toString('utf8') !== row.passage) {
        stale.add(row.path);
        continue;
      }
      hits.push({ path: row.path, revision: row.revision, headingPath: JSON.parse(row.heading), source, passage: row.passage, score: row.score, evidence: 'vault text; unverified', memory: vault.role === 'own' ? 'unverified memory' : null });
      if (hits.length === limit) break;
    }
    db.exec('BEGIN IMMEDIATE');
    for (const hit of hits) db.prepare('INSERT INTO served(call_id, at, path, revision, source, passage, passage_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(callId, new Date().toISOString(), hit.path, hit.revision, JSON.stringify(hit.source), hit.passage, revision(hit.passage));
    db.exec('DELETE FROM served WHERE id NOT IN (SELECT id FROM served ORDER BY id DESC LIMIT 1000); COMMIT;');
    return { vault: vault.id, callId, query, terms, termsTruncated: allTerms.length > terms.length, excludedSource: sourcePath ?? null, hits, stalePaths: [...stale], refreshRequired: stale.size > 0, candidateLimitReached: examined === 1000 && hits.length < limit, durationMs: Math.round((performance.now() - started) * 100) / 100 };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
