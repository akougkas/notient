import { lstatSync } from 'node:fs';
import { indexPath } from './config.mjs';
import { openIndex } from './index.mjs';
import { refuse } from './paths.mjs';

function stamp(filename) {
  try { const stat = lstatSync(filename); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function withPlanningIndex(vault, directory, action) {
  const filename = indexPath(directory, vault); const before = [stamp(filename), stamp(filename + '-wal')];
  if (!before[0] || before[1]?.[2]) refuse('CANDIDATE_STALE', 'The index is absent or has uncheckpointed publication; retry after refresh finishes.', [], true);
  const db = openIndex(directory, vault, false, { immutable: true });
  try {
    const result = action(db);
    if (JSON.stringify(before) !== JSON.stringify([stamp(filename), stamp(filename + '-wal')])) refuse('CANDIDATE_STALE', 'The index changed during receipt planning; retry with fresh candidates.', [], true);
    return result;
  } finally { db?.close(); }
}
