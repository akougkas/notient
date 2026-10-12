import { closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitState } from './git.mjs';
import { syncDirectory } from './journal.mjs';

export function createBaseline(root) {
  const before = gitState(root);
  const lockPath = path.join(root, '.git/index.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Baseline refuses an existing Git index lock.'); throw error; }
  let temporary;
  let published = null;
  let installed = false;
  try {
    temporary = mkdtempSync(path.join(root, '.git/notient-baseline-'));
    const filename = path.join(temporary, 'index');
    const options = { env: { GIT_INDEX_FILE: filename }, fsync: before.durability.fsync };
    git(root, ['read-tree', ...(before.baseHead ? [before.baseHead] : ['--empty'])], options);
    git(root, ['-c', 'core.filemode=true', 'add', '--all', '--', '.'], { ...options, timeout: 120000 });
    const entries = git(root, ['ls-files', '--stage', '-z'], { ...options, raw: true }).toString('utf8').split('\0').filter(Boolean);
    const algorithm = git(root, ['rev-parse', '--show-object-format']);
    let sameIndex = entries.length === before.index.entries.size;
    for (const entry of entries) {
      const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
      if (!match || !['100644', '100755', '120000'].includes(match[1])) throw new Error('Baseline requires ordinary files or symbolic links, without nested Git repositories.');
      const [, mode, oid, name] = match;
      const target = path.join(root, name);
      const stat = lstatSync(target);
      const bytes = stat.isSymbolicLink() ? readlinkSync(target, { encoding: 'buffer' }) : readFileSync(target);
      const rawOid = createHash(algorithm).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
      const liveMode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
      if (rawOid !== oid || liveMode !== mode) throw new Error(`Baseline refuses transformed or concurrently changed bytes at ${JSON.stringify(name)}. Keep files quiescent and remove Git content transforms before retrying.`);
      const previous = before.index.entries.get(name);
      sameIndex &&= previous?.oid === oid && previous.mode === mode && !(previous.flags & 0x8000) && !(previous.extended & 0x4000);
    }
    const tree = git(root, ['write-tree'], options);
    const current = gitState(root);
    if (current.ref !== before.ref || current.baseHead !== before.baseHead || !(current.index.bytes === before.index.bytes || current.index.bytes?.equals(before.index.bytes))) throw new Error('Git changed while preparing the baseline; no commit was published.');
    const unchanged = before.baseHead && tree === git(root, ['rev-parse', `${before.baseHead}^{tree}`]);
    if (unchanged && sameIndex) return { created: false, oid: before.baseHead, parent: git(root, ['log', '-1', '--format=%P']).split(' ')[0] || null };
    writeFileSync(lock, readFileSync(filename));
    fsyncSync(lock);
    let oid = before.baseHead;
    if (!unchanged) {
      const identity = { GIT_AUTHOR_NAME: 'Notient', GIT_AUTHOR_EMAIL: 'notient@localhost', GIT_COMMITTER_NAME: 'Notient', GIT_COMMITTER_EMAIL: 'notient@localhost' };
      oid = git(root, ['commit-tree', tree, ...(before.baseHead ? ['-p', before.baseHead] : [])], { env: identity, input: 'Notient baseline\n', fsync: before.durability.fsync });
      git(root, ['update-ref', '-m', 'Notient baseline', before.ref, oid, before.baseHead ?? '0'.repeat(oid.length)], { fsync: before.durability.fsync });
      published = oid;
    }
    closeSync(lock);
    lock = undefined;
    renameSync(lockPath, path.join(root, '.git/index'));
    installed = true;
    syncDirectory(path.join(root, '.git'));
    return { created: !unchanged, oid, parent: unchanged ? git(root, ['log', '-1', '--format=%P']).split(' ')[0] || null : before.baseHead };
  } catch (error) {
    if (published && !installed) throw new Error(`Baseline commit ${published} was published; index reconciliation remains at ${lockPath}. ${error.message}`);
    throw error;
  } finally {
    if (lock !== undefined) closeSync(lock);
    if (!published && existsSync(lockPath)) rmSync(lockPath);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
