import { existsSync, lstatSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { indexPath, selectVault } from './config.mjs';
import { ensureDirectories, durableFile } from './journal.mjs';
import { refuse } from './paths.mjs';

export const gardenLimits = Object.freeze({ items: 3, operations: 3, proposals: 3, plans: 1, digests: 1, workMs: 600000, finalizeMs: 120000, leaseMs: 3000000, capacity: 10000 });
export const gardenPath = (directory, vault) => path.join(path.dirname(indexPath(directory, vault)), 'garden.db');

export function openGarden(directory, vault, writable = false) {
  const filename = gardenPath(directory, vault);
  if (!existsSync(filename)) {
    if (!writable) return null;
    ensureDirectories(path.dirname(filename));
    try { durableFile(filename, Buffer.alloc(0)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(filename + suffix)) {
    const stat = lstatSync(filename + suffix);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse('UNSAFE_STATE', 'Garden state must use ordinary private files.');
    if (!writable && suffix === '-wal' && stat.size) refuse('GARDEN_BUSY', 'Garden state has an uncheckpointed writer.', [], true);
  }
  const db = new DatabaseSync(writable ? filename : `${pathToFileURL(filename).href}?immutable=1`, { readOnly: !writable });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (writable) {
      chmodSync(filename, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS queue (key TEXT PRIMARY KEY,path TEXT NOT NULL,revision TEXT NOT NULL,processedRevision TEXT,kind TEXT NOT NULL,policyVersion TEXT NOT NULL,enqueuedAt TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,leaseToken TEXT,leaseUntil INTEGER,runId TEXT,lastError TEXT,resultJson TEXT);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,vault TEXT NOT NULL,startedAt TEXT NOT NULL,deadline INTEGER NOT NULL,leaseUntil INTEGER NOT NULL,state TEXT NOT NULL,batch TEXT NOT NULL,request TEXT NOT NULL,inputDigest TEXT NOT NULL,limits TEXT NOT NULL,counters TEXT NOT NULL,deterministicJson TEXT,resultJson TEXT);
        CREATE TABLE IF NOT EXISTS actions (runId TEXT NOT NULL,slot INTEGER NOT NULL,requestId TEXT NOT NULL UNIQUE,inputDigest TEXT NOT NULL,state TEXT NOT NULL,operationId TEXT,PRIMARY KEY(runId,slot));
        CREATE TABLE IF NOT EXISTS owned (path TEXT PRIMARY KEY,lastWrittenRevision TEXT);
        CREATE TABLE IF NOT EXISTS plan_actions (proposalId TEXT PRIMARY KEY,planRevision TEXT NOT NULL,requestId TEXT NOT NULL,inputDigest TEXT NOT NULL,operationId TEXT,state TEXT NOT NULL);`);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function gardenTransaction(directory, vault, action) {
  const db = openGarden(directory, vault, true);
  try {
    db.exec('BEGIN IMMEDIATE'); const current = selectVault(vault.id, directory);
    if (current.path !== vault.path || current.readOnly) refuse('READ_ONLY_VAULT', 'Current registration must permit garden state changes.');
    const result = action(db); db.exec('COMMIT'); return result;
  }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export function queueCounts(db) {
  const counts = { queued: 0, leased: 0, complete: 0, skipped: 0, poison: 0 };
  for (const row of db.prepare('SELECT state,count(*) AS n FROM queue GROUP BY state').all()) counts[row.state] = row.n;
  return counts;
}

export function gardenRun(db, id) {
  const run = db?.prepare('SELECT * FROM runs WHERE id=?').get(id);
  if (!run) refuse('GARDEN_RUN_MISSING', 'Begin this garden run before submitting work.');
  return run;
}

export function liveGardenRun(db, id, now, finalizing = false) {
  const run = gardenRun(db, id);
  if (run.state !== 'active' || run.leaseUntil <= now || now > run.deadline + (finalizing ? gardenLimits.finalizeMs : 0)) refuse('GARDEN_RUN_EXPIRED', 'The run is no longer authorized to start this work.', [], true);
  return run;
}
