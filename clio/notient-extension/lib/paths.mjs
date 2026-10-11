import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, readFileSync, fstatSync, closeSync, constants } from 'node:fs';
import path from 'node:path';

export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
export const revision = bytes => createHash('sha256').update(bytes).digest('hex');
export const vaultId = root => revision(root).slice(0, 16);

export function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function notePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new Error('A vault-relative Markdown path is required.');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !/\.md$/i.test(relative)) {
    throw new Error('Hidden paths, traversal and non-Markdown files are not note paths.');
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not note paths: ${relative}`);
  }
  if (!contained(root, realpathSync(current))) throw new Error('Note resolves outside the vault.');
  return current;
}

export function readNote(root, relative) {
  const target = notePath(root, relative);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_NOTE_BYTES) throw new Error('Note must be a regular file no larger than 4 MiB.');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Note changed during read: ${relative}. Retry the call.`);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { bytes, text, revision: revision(bytes), stat: after };
  } finally {
    closeSync(fd);
  }
}
