import { mkdirSync, existsSync, lstatSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { indexPath } from './config.mjs';
import { refuse } from './paths.mjs';

export function withIndexWriter(vault, directory, action, { deadline = Infinity, now = () => performance.now() } = {}) {
  const allowance = () => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) refuse('INDEX_BUSY', 'The remaining index writer allowance is exhausted.', [], true);
    return Math.min(5000, remaining);
  };
  allowance();
  const root = path.dirname(indexPath(directory, vault));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = path.join(root, 'index-writer.db');
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(filename + suffix)) {
    const stat = lstatSync(filename + suffix);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse('UNSAFE_STATE', 'Index writer artifacts must be ordinary private files.');
  }
  const lock = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    lock.exec(`PRAGMA busy_timeout=${allowance()}; CREATE TABLE IF NOT EXISTS exclusion (id INTEGER PRIMARY KEY);`);
    lock.exec(`PRAGMA busy_timeout=${allowance()}; BEGIN IMMEDIATE;`);
    const result = action();
    if (result && typeof result.then === 'function') refuse('INDEX_LOCK_SCOPE', 'Index publication must complete synchronously without inference.');
    lock.exec('COMMIT'); return result;
  } catch (error) {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    if (error.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message)) refuse('INDEX_BUSY', 'The external index writer is busy.', [], true);
    throw error;
  } finally { lock.close(); }
}
