import { existsSync, readdirSync, readFileSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { contained, revision, refuse, WriteError, vaultId, portableName } from './paths.mjs';

export const requestIdPattern = /^[A-Za-z0-9._-]{8,64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const states = ['intent', 'applied', 'committed', 'conflicted', 'aborted'];

export function journalRoot(directory, vault) {
  if (vault.id !== vaultId(vault.path)) refuse('JOURNAL_CORRUPT', 'The journal vault identity is invalid.');
  const root = path.resolve(directory, 'journal', vault.id);
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (contained(vault.path, root) || contained(vault.path, realpathSync(ancestor))) refuse('UNSAFE_STATE', 'The journal must be outside the vault.');
  return root;
}

export function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); return true; }
  catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) return false;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function ensureDirectories(directory, sync = syncDirectory) {
  const missing = [];
  let ancestor = directory;
  while (!existsSync(ancestor)) { missing.unshift(ancestor); ancestor = path.dirname(ancestor); }
  if (!lstatSync(ancestor).isDirectory() || lstatSync(ancestor).isSymbolicLink()) refuse('UNSAFE_STATE', 'State directories cannot be symbolic links.');
  for (const name of missing) { mkdirSync(name, { mode: 0o700 }); sync(name); sync(path.dirname(name)); }
}

export function durableFile(filename, bytes, { exclusive = true, mode = 0o600, sync = syncDirectory } = {}) {
  const fd = openSync(filename, (exclusive ? 'wx' : 'w'), mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  sync(path.dirname(filename));
}

export function operationDirectory(directory, vault, id) {
  if (!requestIdPattern.test(id)) refuse('INVALID_INPUT', 'requestId must be 8 to 64 characters from A-Z, a-z, 0-9, dot, underscore or hyphen.');
  return path.join(journalRoot(directory, vault), 'ops', id);
}

export function validateRecord(record, vault) {
  const required = ['version', 'id', 'vaultId', 'vaultPath', 'tool', 'operation', 'requestDigest', 'batch', 'authorization', 'createdAt', 'updatedAt', 'state', 'planHash', 'source', 'destination', 'reads', 'inventoryHash', 'files', 'applyOrder', 'createdDirectories', 'git', 'log', 'undo', 'undoneBy', 'indexState', 'durability', 'conflicts', 'timings', 'error'];
  if (!record || required.some(key => !Object.hasOwn(record, key)) || record.version !== 1 || !requestIdPattern.test(record.id) || record.vaultId !== vault.id || record.vaultPath !== vault.path || !states.includes(record.state) || !hashPattern.test(record.requestDigest) || !hashPattern.test(record.planHash) || !Array.isArray(record.files) || record.files.length > 101) refuse('JOURNAL_CORRUPT', 'The operation record has an invalid schema.');
  if (!['capture', 'revise', 'undo'].includes(record.tool) || !['capture', 'replace', 'frontmatter', 'undo'].includes(record.operation) || !['operator', 'clio', 'unattended'].includes(record.authorization?.origin) || typeof record.authorization.request !== 'string' || !record.authorization.request.trim()) refuse('JOURNAL_CORRUPT', 'The recorded authority or operation is invalid.');
  if (!Array.isArray(record.applyOrder) || new Set(record.applyOrder).size !== record.files.length || record.files.some(file => !record.applyOrder.includes(file.path))) refuse('JOURNAL_CORRUPT', 'The recorded publication order is invalid.');
  const seen = new Set();
  for (const file of record.files) {
    if (typeof file.path !== 'string' || seen.has(file.path) || !['note', 'log'].includes(file.role) || !['create', 'replace', 'delete'].includes(file.action) || ![file.before, file.after].every(hash => hash === null || hashPattern.test(hash)) || !Number.isInteger(file.mode) || !['pending', 'applied'].includes(file.progress)) refuse('JOURNAL_CORRUPT', 'A recorded file is invalid.');
    if ((file.action === 'create' && file.before !== null) || (file.action === 'delete' && file.after !== null) || (file.action === 'replace' && (file.before === null || file.after === null))) refuse('JOURNAL_CORRUPT', 'A recorded action has inconsistent revisions.');
    if (file.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || path.isAbsolute(file.path) || file.path.includes('\\') || !/\.md$/i.test(file.path)) refuse('JOURNAL_CORRUPT', 'A recorded path is unsafe.');
    if (file.temp !== null && file.temp !== `${path.posix.dirname(file.path)}/.notient-${record.id}-${record.files.indexOf(file)}.tmp`.replace(/^\.\//, '')) refuse('JOURNAL_CORRUPT', 'A recorded temporary path is invalid.');
    seen.add(file.path);
  }
  if (!record.git || !Array.isArray(record.undo?.targets) || !Array.isArray(record.conflicts) || !['pending', 'updated'].includes(record.indexState)) refuse('JOURNAL_CORRUPT', 'The operation metadata is invalid.');
  return record;
}

export function readRecord(directory, vault, id, verifyBlobs = true) {
  const root = operationDirectory(directory, vault, id);
  const filename = path.join(root, 'record.json');
  try {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink() || lstatSync(filename).size > 8 * 1024 * 1024) refuse('JOURNAL_CORRUPT', 'The record is not a bounded regular file.');
    const record = validateRecord(JSON.parse(readFileSync(filename, 'utf8')), vault);
    if (record.id !== id) refuse('JOURNAL_CORRUPT', 'The record ID differs from its directory.');
    if (verifyBlobs) {
      let size = 0;
      for (const hash of new Set(record.files.flatMap(file => [file.before, file.after]).filter(Boolean))) { size += readBlob(directory, vault, id, hash).length; }
      if (size > 64 * 1024 * 1024) refuse('JOURNAL_CORRUPT', 'Operation blobs exceed 64 MiB.');
    }
    return record;
  } catch (error) { if (error instanceof WriteError) throw error; refuse('JOURNAL_CORRUPT', `The journal cannot be read: ${error.message}`); }
}

export function readBlob(directory, vault, id, hash) {
  if (!hashPattern.test(hash)) refuse('JOURNAL_CORRUPT', 'A journal blob hash is invalid.');
  const filename = path.join(operationDirectory(directory, vault, id), 'blobs', hash);
  try {
    for (const name of [journalRoot(directory, vault), path.join(journalRoot(directory, vault), 'ops'), operationDirectory(directory, vault, id), path.dirname(filename)]) {
      if (lstatSync(name).isSymbolicLink() || !lstatSync(name).isDirectory()) refuse('JOURNAL_CORRUPT', 'Journal blob directories must be ordinary directories.');
    }
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) refuse('JOURNAL_CORRUPT', 'A journal blob is unsafe.');
    const bytes = readFileSync(filename);
    if (revision(bytes) !== hash) refuse('JOURNAL_CORRUPT', 'A journal blob does not match its hash.');
    return bytes;
  } catch (error) { if (error instanceof WriteError) throw error; refuse('JOURNAL_CORRUPT', `A journal blob is missing or unreadable: ${error.message}`); }
}

export function saveRecord(directory, vault, record, sync = syncDirectory) {
  validateRecord(record, vault);
  const root = operationDirectory(directory, vault, record.id);
  ensureDirectories(root, sync);
  record.updatedAt = new Date().toISOString();
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > 8 * 1024 * 1024) refuse('JOURNAL_LIMIT', 'The operation record exceeds 8 MiB.');
  const temp = path.join(root, `record.${randomUUID()}.tmp`);
  durableFile(temp, bytes, { sync });
  renameSync(temp, path.join(root, 'record.json'));
  sync(root);
}

export function persistIntent(directory, vault, record, blobs, sync = syncDirectory) {
  const root = operationDirectory(directory, vault, record.id);
  if (existsSync(path.join(root, 'record.json'))) refuse('REQUEST_ID_REUSED', 'An operation already uses this request ID.');
  ensureDirectories(path.join(root, 'blobs'), sync);
  let total = 0;
  for (const [hash, bytes] of blobs) {
    total += bytes.length;
    if (revision(bytes) !== hash || total > 64 * 1024 * 1024) refuse('JOURNAL_LIMIT', 'The operation blobs are invalid or exceed 64 MiB.');
    const filename = path.join(root, 'blobs', hash);
    if (!existsSync(filename)) durableFile(filename, bytes, { sync });
    else if (!readBlob(directory, vault, record.id, hash).equals(bytes)) refuse('JOURNAL_CORRUPT', 'An existing immutable blob differs.');
  }
  saveRecord(directory, vault, record, sync);
}

export function listRecords(directory, vault, verifyBlobs = true) {
  const root = path.join(journalRoot(directory, vault), 'ops');
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) refuse('JOURNAL_CORRUPT', 'The operation directory is a symbolic link.');
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => readRecord(directory, vault, entry.name, verifyBlobs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function withWriterLock(directory, vault, handler, { create = true } = {}) {
  const root = journalRoot(directory, vault);
  const filename = path.join(root, 'writer.db');
  if (!create && !existsSync(filename)) return handler(0);
  ensureDirectories(root);
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  const started = performance.now();
  try {
    db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK (id = 1));');
    db.exec('BEGIN IMMEDIATE');
    return handler(performance.now() - started);
  } catch (error) {
    if (error.errcode === 5 || /database is locked|database is busy/i.test(error.message)) refuse('WRITER_BUSY', 'Another Notient writer holds the vault lock.', [], true);
    throw error;
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}

export function journalStatus(directory, id) {
  const root = path.join(directory, 'journal', id);
  if (!existsSync(root)) return { pending: [], pendingCount: 0, operations: [], recoveryResults: [], recoveryAvailable: true, busy: false };
  const pending = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filename = path.join(root, entry.name);
    if (lstatSync(filename).size > 1024 * 1024) throw new Error('Journal entry exceeds 1 MiB.');
    const item = JSON.parse(readFileSync(filename, 'utf8'));
    if (!['committed', 'reverted', 'aborted'].includes(item.state)) pending.push({ id: item.id ?? entry.name, state: item.state ?? 'unknown' });
  }
  const operations = [];
  const ops = path.join(root, 'ops');
  if (existsSync(ops)) {
    for (const entry of readdirSync(ops, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filename = path.join(ops, entry.name, 'record.json');
      if (!existsSync(filename) || lstatSync(filename).isSymbolicLink() || lstatSync(filename).size > 8 * 1024 * 1024) refuse('JOURNAL_CORRUPT', 'The operation projection is unreadable.');
      const item = JSON.parse(readFileSync(filename, 'utf8'));
      if (item.version !== 1) refuse('JOURNAL_CORRUPT', 'Unknown operation version.');
      operations.push({ id: item.id, batch: item.batch, state: item.state, commit: item.git?.commit ?? null, undoneBy: item.undoneBy, createdAt: item.createdAt, indexState: item.indexState });
      if (!['committed', 'aborted'].includes(item.state) || item.indexState === 'pending') pending.push({ id: item.id, state: item.state });
    }
  }
  return { pending: pending.slice(0, 100), pendingCount: pending.length, operations: operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50), recoveryResults: [], recoveryAvailable: true, busy: false };
}

export function spoolCount(directory) {
  const root = path.join(directory, 'spool');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()).length : 0;
}
