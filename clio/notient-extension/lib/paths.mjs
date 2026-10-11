import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, readFileSync, fstatSync, closeSync, constants, readdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
export const revision = bytes => createHash('sha256').update(bytes).digest('hex');
export const vaultId = root => revision(root).slice(0, 16);

export class WriteError extends Error {
  constructor(code, message, paths = [], retryable = false) {
    super(message);
    this.code = code;
    this.paths = paths;
    this.retryable = retryable;
  }
}

export function refuse(code, message, paths = [], retryable = false) { throw new WriteError(code, message, paths, retryable); }

export function validText(value, label = 'Text') {
  if (typeof value !== 'string' || value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) refuse('INVALID_INPUT', `${label} must be valid Unicode without NUL.`);
  return value;
}

export const portableFold = value => value.normalize('NFC').toLowerCase();

export function portableName(name) {
  validText(name, 'Path component');
  if (!name || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) refuse('INVALID_PATH', 'A portable, visible path component is required.', [name]);
}

export function writePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || !/\.md$/i.test(relative)) refuse('INVALID_PATH', 'A vault-relative Markdown path is required.', [String(relative)]);
  const parts = relative.split('/');
  parts.forEach(portableName);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) refuse('VAULT_CHANGED', 'The canonical registered vault root changed.');
  let current = root;
  let missing = false;
  for (const [i, part] of parts.entries()) {
    if (!missing) {
      const matches = readdirSync(current).filter(name => portableFold(name) === portableFold(part));
      if (matches.some(name => name !== part) || matches.length > 1) refuse('CASE_COLLISION', 'Path spelling collides with another vault entry.', [relative]);
    }
    current = path.join(current, part);
    if (missing) continue;
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; continue; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) refuse('UNSAFE_PATH', 'Writes require regular files and directories without symlinks or file hard links.', [relative]);
    if (!contained(root, realpathSync(current))) refuse('UNSAFE_PATH', 'The path resolves outside the vault.', [relative]);
  }
  return current;
}

export function currentFile(root, relative) {
  const filename = writePath(root, relative);
  let fd;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return { bytes: null, revision: null, stat: null, mode: 0o600 }; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_NOTE_BYTES) refuse('UNSAFE_PATH', 'A single-link regular file of at most 4 MiB is required.', [relative]);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const live = lstatSync(filename);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || live.dev !== before.dev || live.ino !== before.ino) refuse('REVISION_CONFLICT', 'The file changed during its read.', [relative], true);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { refuse('INVALID_UTF8', 'The note is not valid UTF-8.', [relative]); }
    if (bytes.includes(0)) refuse('INVALID_UTF8', 'The note contains NUL.', [relative]);
    return { bytes, revision: revision(bytes), stat: after, mode: after.mode & 0o777 };
  } finally { closeSync(fd); }
}

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
