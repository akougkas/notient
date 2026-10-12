import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { refuse, revision } from './paths.mjs';
import { durableFile, operationDirectory, readBlob, syncDirectory } from './journal.mjs';

export function git(root, args, { input, env = {}, raw = false, fsync = false, timeout = 15000 } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const options = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0'];
  if (fsync) options.push('-c', 'core.fsync=committed');
  const output = execFileSync('git', [...options, '-C', root, ...args], {
    input, env: { ...inherited, ...env }, encoding: raw ? undefined : 'utf8', timeout,
    maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return raw ? output : output.trim();
}

export function gitDurability(root, version = git(root, ['version'])) {
  const match = /git version (\d+)\.(\d+)/.exec(version);
  return { version, fsync: Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 36)) };
}

export function normalIndexEntries(root, call = git) {
  const filename = path.join(root, '.git/index');
  if (!existsSync(filename)) return { bytes: null, entries: new Map() };
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) refuse('GIT_INDEX_UNSUPPORTED', 'The Git index must be an ordinary file.');
  const bytes = readFileSync(filename);
  let format;
  try { format = call(root, ['rev-parse', '--show-object-format']); } catch (error) { if (error.code === 'GIT_TIMEOUT') throw error; format = 'sha1'; }
  const oidBytes = format === 'sha256' ? 32 : 20;
  const algorithm = format === 'sha256' ? 'sha256' : 'sha1';
  if (bytes.length < 12 + oidBytes || bytes.subarray(0, 4).toString() !== 'DIRC' || ![2, 3, 4].includes(bytes.readUInt32BE(4)) || !createHash(algorithm).update(bytes.subarray(0, -oidBytes)).digest().equals(bytes.subarray(-oidBytes))) refuse('GIT_INDEX_UNSUPPORTED', 'The Git index format or checksum is invalid.');
  const version = bytes.readUInt32BE(4);
  const entries = new Map();
  let offset = 12;
  let previousName = Buffer.alloc(0);
  for (let i = 0; i < bytes.readUInt32BE(8); i++) {
    const start = offset;
    const mode = bytes.readUInt32BE(offset + 24);
    const oid = bytes.subarray(offset + 40, offset + 40 + oidBytes).toString('hex');
    const flags = bytes.readUInt16BE(offset + 40 + oidBytes);
    offset += 42 + oidBytes;
    let extended = 0;
    if (flags & 0x4000) { extended = bytes.readUInt16BE(offset); offset += 2; }
    let strip = 0;
    if (version === 4) {
      let value = bytes[offset++]; strip = value & 0x7f;
      while (value & 0x80) { value = bytes[offset++]; strip = ((strip + 1) << 7) + (value & 0x7f); }
    }
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= bytes.length - oidBytes) refuse('GIT_INDEX_UNSUPPORTED', 'The Git index pathname is invalid.');
    const suffix = bytes.subarray(offset, end);
    const nameBytes = version === 4 ? Buffer.concat([previousName.subarray(0, previousName.length - strip), suffix]) : suffix;
    const name = nameBytes.toString('utf8');
    previousName = nameBytes;
    offset = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
    const stage = (flags >> 12) & 3;
    if (stage !== 0 || mode === 0o040000) refuse('GIT_INDEX_UNSUPPORTED', 'Unmerged and sparse indexes are unsupported.');
    entries.set(name, { mode: mode.toString(8), oid, flags, extended, bytes: bytes.subarray(start, offset) });
  }
  while (offset < bytes.length - oidBytes) {
    const signature = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32BE(offset + 4);
    if (!['TREE', 'REUC', 'UNTR', 'EOIE', 'IEOT'].includes(signature) || offset + 8 + size > bytes.length - oidBytes) refuse('GIT_INDEX_UNSUPPORTED', `Unsupported Git index extension: ${signature}.`);
    offset += 8 + size;
  }
  return { bytes, entries };
}

export function gitState(root, call = git) {
  const directory = path.join(root, '.git');
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) refuse('GIT_VAULT_REQUIRED', 'The vault must have its own ordinary .git directory.');
  if (call(root, ['rev-parse', '--show-toplevel']) !== root || call(root, ['rev-parse', '--is-bare-repository']) !== 'false' || call(root, ['rev-parse', '--git-common-dir']) !== '.git') refuse('GIT_VAULT_REQUIRED', 'Bare repositories and shared worktrees are unsupported.');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) if (existsSync(path.join(directory, name))) refuse('GIT_STATE_UNSUPPORTED', 'Finish the active Git operation before writing.');
  let ref;
  try { ref = call(root, ['symbolic-ref', '--quiet', 'HEAD']); } catch (error) { if (error.code === 'GIT_TIMEOUT') throw error; refuse('GIT_STATE_UNSUPPORTED', 'A symbolic local branch is required.'); }
  if (!ref.startsWith('refs/heads/')) refuse('GIT_STATE_UNSUPPORTED', 'A local branch is required.');
  let baseHead = null;
  try { baseHead = call(root, ['rev-parse', '--verify', 'HEAD']); } catch (error) { if (![1, 128].includes(error.status)) throw error; }
  let split = '';
  try { split = call(root, ['rev-parse', '--shared-index-path']); } catch (error) { if (error.code === 'GIT_TIMEOUT') throw error; }
  if (split) refuse('GIT_INDEX_UNSUPPORTED', 'Split indexes are unsupported.');
  return { ref, baseHead, index: normalIndexEntries(root, call), durability: gitDurability(root, call(root, ['version'])) };
}

function treeEntry(root, head, name, call = git) {
  if (!head) return null;
  const line = call(root, ['ls-tree', '-z', head, '--', name], { raw: true }).toString('utf8').replace(/\0$/, '');
  if (!line) return null;
  const match = /^(\d+) blob ([a-f0-9]+)\t/.exec(line);
  if (!match) refuse('GIT_TARGET_UNSUPPORTED', 'Affected paths must be ordinary Git blobs.', [name]);
  return { mode: match[1], oid: match[2] };
}

export function preflightGit(vault, files) {
  const state = gitState(vault.path);
  for (const file of files) {
    const entry = state.index.entries.get(file.path);
    const head = treeEntry(vault.path, state.baseHead, file.path);
    const attributes = git(vault.path, ['check-attr', '-z', 'filter', 'working-tree-encoding', '--', file.path], { raw: true }).toString('utf8').split('\0');
    for (let i = 0; i + 2 < attributes.length; i += 3) if (!['unspecified', 'unset'].includes(attributes[i + 2])) refuse('GIT_ENCODING_MISMATCH', 'Affected paths cannot use Git filters or working-tree encodings.', [file.path]);
    if (entry && ((entry.flags & 0x8000) || (entry.extended & 0x4000))) refuse('DIRTY_TARGET', 'Affected paths cannot be assume-unchanged or skip-worktree.', [file.path]);
    if (file.before === null) {
      if (entry || head) refuse('DIRTY_TARGET', 'A new path is already tracked or staged.', [file.path]);
      continue;
    }
    if (!head || !entry || head.oid !== entry.oid || head.mode !== entry.mode) refuse('DIRTY_TARGET', 'Affected existing paths must match HEAD and the stage-zero index.', [file.path]);
    const blob = git(vault.path, ['cat-file', 'blob', head.oid], { raw: true });
    if (!blob.equals(file.before)) refuse('GIT_ENCODING_MISMATCH', 'Working bytes differ from the raw committed Git blob.', [file.path]);
    const mode = file.mode & 0o111 ? '100755' : '100644';
    if (mode !== head.mode) refuse('DIRTY_TARGET', 'Affected file mode differs from its Git baseline.', [file.path]);
  }
  return state;
}

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createGitAdapter(vault, directory) {
  const root = vault.path;
  const durability = gitDurability(root);
  let operationId = null;
  let usedMs = 0;
  let depth = 0;
  let phaseStarted = 0;
  function run(record, args, options = {}) {
    const remaining = 60000 - usedMs - (depth ? performance.now() - phaseStarted : 0);
    if (remaining <= 0) refuse('GIT_TIMEOUT', 'The Git phase exceeded 60 seconds.', [], true);
    try { return git(root, args, { fsync: durability.fsync, timeout: Math.max(1, Math.min(15000, Math.floor(remaining))), ...options }); }
    catch (error) {
      if (error.code === 'ETIMEDOUT' || error.signal) refuse('GIT_TIMEOUT', 'A Git subprocess exceeded its deadline.', [], true);
      throw error;
    }
  }
  function object(record, hash, write = false) { return run(record, ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin'], { input: readBlob(directory, vault, record.id, hash) }); }
  function matches(entry, record, file, hash) {
    if (hash === null) return !entry;
    return entry?.oid === object(record, hash) && entry.mode === (file.mode & 0o111 ? '100755' : '100644') && !(entry.flags & 0x8000) && !(entry.extended & 0x4000);
  }
  function verify(record) {
    const raw = run(record, ['cat-file', '-p', record.git.commit]);
    const tree = /^tree ([a-f0-9]+)$/m.exec(raw)?.[1];
    const parents = [...raw.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
    if (tree !== record.git.tree || parents.length !== (record.git.baseHead ? 1 : 0) || (record.git.baseHead && parents[0] !== record.git.baseHead) || !raw.split('\n').includes(`Notient-Operation: ${record.id}`)) refuse('JOURNAL_CORRUPT', 'The recorded Git commit identity, tree, parent or operation trailer differs.');
    const changed = run(record, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', record.git.commit], { raw: true }).toString('utf8').split('\0').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(record.files.map(file => file.path).sort())) refuse('JOURNAL_CORRUPT', 'The Git commit delta differs from the recorded path set.');
    for (const file of record.files) {
      const call = (target, args, options) => run(record, args, options);
      const before = treeEntry(root, record.git.baseHead, file.path, call);
      if (file.before === null ? before !== null : before?.oid !== object(record, file.before) || before.mode !== (file.mode & 0o111 ? '100755' : '100644')) refuse('JOURNAL_CORRUPT', 'A commit parent blob differs from the recorded before bytes.', [file.path]);
      const after = treeEntry(root, record.git.tree, file.path, call);
      if (file.after === null ? after !== null : after?.oid !== object(record, file.after) || after.mode !== (file.mode & 0o111 ? '100755' : '100644')) refuse('JOURNAL_CORRUPT', 'A commit blob differs from its recorded after bytes.', [file.path]);
    }
  }
  const adapter = {
    durability,
    recognize(record) {
      if (!record.git.commit) return false;
      const state = gitState(root, (target, args, options) => run(record, args, options));
      verify(record);
      try { run(record, ['merge-base', '--is-ancestor', record.git.commit, record.git.ref]); return true; }
      catch (error) { if (error.status === 1 || error.status === 128) return false; throw error; }
    },
    checkBase(record) {
      const state = gitState(root, (target, args, options) => run(record, args, options));
      if (state.ref !== record.git.ref || state.baseHead !== record.git.baseHead) refuse('GIT_HEAD_CHANGED', 'HEAD differs from the frozen operation base.', [], true);
      for (const file of record.files) if (!matches(state.index.entries.get(file.path), record, file, file.before) && !matches(state.index.entries.get(file.path), record, file, file.after)) refuse('DIRTY_TARGET', 'An affected staged entry differs from both recorded states.', [file.path]);
    },
    prepare(record) {
      this.checkBase(record);
      const root = operationDirectory(directory, vault, record.id);
      const filename = path.join(root, 'commit-index');
      const env = { GIT_INDEX_FILE: filename };
      const normal = normalIndexEntries(vault.path, (target, args, options) => run(record, args, options)).bytes;
      if (normal && !existsSync(path.join(root, 'git-index.before'))) durableFile(path.join(root, 'git-index.before'), normal);
      record.git.indexBeforeHash = normal ? revision(normal) : null;
      run(record, ['read-tree', ...(record.git.baseHead ? [record.git.baseHead] : ['--empty'])], { env });
      for (const file of record.files) {
        if (file.after === null) run(record, ['update-index', '--force-remove', '--', file.path], { env });
        else run(record, ['update-index', '--add', '--cacheinfo', file.mode & 0o111 ? '100755' : '100644', object(record, file.after, true), file.path], { env });
      }
      record.git.tree = run(record, ['write-tree'], { env });
      const subject = `notient(${record.operation}): ${JSON.stringify(record.source ?? record.files.find(file => file.role === 'note')?.path)}`;
      const message = `${subject}\n\nNotient-Operation: ${record.id}\nNotient-Vault: ${record.vaultId}\nNotient-Batch: ${record.batch}\nNotient-Origin: ${record.authorization.origin}\nNotient-Request: ${JSON.stringify(record.authorization.request)}\nNotient-Destination: ${JSON.stringify(record.operation === 'move' ? record.destination : null)}\nNotient-Reverts: ${JSON.stringify(record.undo.commits)}\n`;
      const identity = { GIT_AUTHOR_NAME: 'Notient', GIT_AUTHOR_EMAIL: 'notient@localhost', GIT_COMMITTER_NAME: 'Notient', GIT_COMMITTER_EMAIL: 'notient@localhost', GIT_AUTHOR_DATE: record.createdAt, GIT_COMMITTER_DATE: record.createdAt };
      record.git.commit = run(record, ['commit-tree', record.git.tree, ...(record.git.baseHead ? ['-p', record.git.baseHead] : [])], { env: identity, input: message });
      chmodPrivate(filename);
      const fd = openSync(filename, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (!syncDirectory(root)) record.durability = 'directory-sync-unavailable';
      verify(record);
    },
    publish(record) {
      this.checkBase(record);
      try { run(record, ['update-ref', record.git.ref, record.git.commit, record.git.baseHead ?? '0'.repeat(record.git.commit.length)]); }
      catch (error) { if (this.recognize(record)) return; refuse('GIT_HEAD_CHANGED', `Git refused the expected-old-OID ref publication: ${error.message}`, [], true); }
      if (!this.recognize(record)) refuse('GIT_PUBLICATION_UNCERTAIN', 'The candidate commit was not verified as published.', [], true);
    },
    reconcileIndex(record, { barrier = () => {} } = {}) {
      const state = gitState(root, (target, args, options) => run(record, args, options));
      if (state.ref !== record.git.ref) refuse('COMMITTED_INDEX_CONFLICT', 'The branch changed before index reconciliation.');
      for (const file of record.files) if (!matches(state.index.entries.get(file.path), record, file, file.before) && !matches(state.index.entries.get(file.path), record, file, file.after)) refuse('COMMITTED_INDEX_CONFLICT', 'An affected entry changed independently after publication.', [file.path]);
      let until = null;
      for (const file of record.files) {
        const live = normalIndexEntries(root, (target, args, options) => run(record, args, options)).entries.get(file.path);
        if (matches(live, record, file, file.after)) continue;
        if (!matches(live, record, file, file.before)) refuse('COMMITTED_INDEX_CONFLICT', 'An affected stage-zero entry changed before its repair.', [file.path]);
        const oid = file.after === null ? null : object(record, file.after);
        for (let attempt = 0; ; attempt++) {
          const retryEntry = normalIndexEntries(root, (target, args, options) => run(record, args, options)).entries.get(file.path);
          if (matches(retryEntry, record, file, file.after)) break;
          if (!matches(retryEntry, record, file, file.before)) refuse('COMMITTED_INDEX_CONFLICT', 'An affected stage-zero entry changed while waiting for its repair.', [file.path]);
          try {
            run(record, file.after === null ? ['update-index', '--force-remove', '--', file.path] : ['update-index', '--add', '--cacheinfo', file.mode & 0o111 ? '100755' : '100644', oid, file.path]);
            break;
          } catch (error) {
            const locked = /index\.lock.*(?:exists|File exists)|Unable to create .*index\.lock/is.test(error.stderr?.toString() ?? error.message);
            if (!locked) throw error;
            until ??= performance.now() + 2000;
            if (attempt >= 3 || performance.now() + [100, 250, 500][attempt] >= until) return false;
            barrier('indexRetry', record, file, { attempt });
            wait([100, 250, 500][attempt]);
          }
        }
        barrier('duringIndex', record, file);
      }
      const current = normalIndexEntries(root, (target, args, options) => run(record, args, options));
      for (const file of record.files) if (!matches(current.entries.get(file.path), record, file, file.after)) refuse('COMMITTED_INDEX_CONFLICT', 'A planned stage-zero entry failed verification.', [file.path]);
      record.git.indexAfterHash = current.bytes ? revision(current.bytes) : null;
      const filename = path.join(root, '.git/index');
      if (existsSync(filename)) { const fd = openSync(filename, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
      if (!syncDirectory(path.join(root, '.git'))) record.durability = 'directory-sync-unavailable';
      return true;
    },
    verify,
    consume(id, milliseconds) { operationId = id; usedMs = milliseconds; },
  };
  for (const name of ['recognize', 'checkBase', 'prepare', 'publish', 'reconcileIndex', 'verify']) {
    const method = adapter[name];
    adapter[name] = function (record, ...args) {
      const outer = depth === 0;
      if (outer) {
        if (operationId !== record.id) { operationId = record.id; usedMs = 0; }
        phaseStarted = performance.now();
      }
      depth++;
      try { return method.call(this, record, ...args); }
      finally {
        depth--;
        if (outer) { const elapsed = performance.now() - phaseStarted; usedMs += elapsed; record.timings.gitMs += elapsed; }
      }
    };
  }
  return adapter;
}

function chmodPrivate(filename) {
  chmodSync(filename, 0o600);
  const fd = openSync(filename, 'r');
  try { process.getuid && lstatSync(filename).uid !== process.getuid() && refuse('UNSAFE_STATE', 'Private Git index ownership differs.'); }
  finally { closeSync(fd); }
}

export function initializeGit(root) {
  const gitPath = path.join(root, '.git');
  if (existsSync(gitPath)) {
    if (!lstatSync(gitPath).isDirectory() || lstatSync(gitPath).isSymbolicLink()) throw new Error('The vault must have its own .git directory.');
    if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('Git root differs from the vault.');
    return false;
  }
  git(root, ['init', '-q', '-b', 'main']);
  return true;
}

export function lastCommit(root) {
  if (!existsSync(path.join(root, '.git'))) return null;
  try {
    const [hash, time, ...subject] = git(root, ['log', '-1', '--format=%H%n%cI%n%s']).split('\n');
    return { hash, time, subject: subject.join('\n') };
  } catch {
    return null;
  }
}
