import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, initializeGit, preflightGit, createGitAdapter, normalIndexEntries, gitDurability } from '../lib/git.mjs';
import { persistPlan, finishRecord, coordinatePlan } from '../lib/write.mjs';
import { writerFixture, put, testPlan } from './write-helpers.mjs';

export function baseline(f, files = ['One.md', 'Other.md']) {
  initializeGit(f.vault.path);
  for (const file of files) if (!readable(f, file)) put(f, file, `Baseline ${file}\n`);
  git(f.vault.path, ['add', '--', ...files]);
  git(f.vault.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture baseline']);
}

function readable(f, name) { try { readFileSync(path.join(f.vault.path, name)); return true; } catch { return false; } }

function planWithGit(f, options = {}) {
  const plan = testPlan(f, { files: [{ path: 'One.md', before: readFileSync(path.join(f.vault.path, 'One.md')), after: Buffer.from('Notient replacement\r\n'), mode: 0o644 }], ...options });
  plan.git = preflightGit(f.vault, plan.files);
  return plan;
}

test('private Git commits preserve unrelated staged entries byte for byte', t => {
  const f = writerFixture(t);
  baseline(f);
  put(f, 'Other.md', 'Unrelated staged content.\n');
  git(f.vault.path, ['add', '--', 'Other.md']);
  put(f, 'Loose.md', 'Unrelated untracked content.');
  const unrelated = normalIndexEntries(f.vault.path).entries.get('Other.md').bytes;
  const plan = planWithGit(f);
  const result = coordinatePlan(f.vault, f.directory, () => plan, { adapter: createGitAdapter(f.vault, f.directory) });
  assert.equal(result.record.state, 'committed');
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Other.md').bytes, unrelated);
  assert.equal(git(f.vault.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', result.record.git.commit]), 'One.md');
  assert.equal(git(f.vault.path, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', result.record.git.commit]), 'Notient <notient@localhost>|Notient <notient@localhost>');
  assert.equal(readFileSync(path.join(f.vault.path, 'Loose.md'), 'utf8'), 'Unrelated untracked content.');
});

test('Git preflight refuses affected dirt, special flags and detached HEAD', t => {
  const f = writerFixture(t);
  baseline(f);
  put(f, 'One.md', 'Authored uncommitted bytes.');
  assert.throws(() => planWithGit(f), error => ['DIRTY_TARGET', 'GIT_ENCODING_MISMATCH'].includes(error.code));
  git(f.vault.path, ['add', '--', 'One.md']);
  assert.throws(() => planWithGit(f), error => error.code === 'DIRTY_TARGET');
  git(f.vault.path, ['update-index', '--assume-unchanged', '--', 'Other.md']);
  assert.throws(() => preflightGit(f.vault, [{ path: 'Other.md', before: readFileSync(path.join(f.vault.path, 'Other.md')), after: Buffer.from('changed'), mode: 0o644 }]), error => error.code === 'DIRTY_TARGET');
  writeFileSync(path.join(f.vault.path, '.git/HEAD'), `${git(f.vault.path, ['rev-parse', 'HEAD'])}\n`);
  assert.throws(() => planWithGit(f), error => error.code === 'GIT_STATE_UNSUPPORTED');
});

test('unborn repositories publish only explicit ignored Notient targets', t => {
  const f = writerFixture(t);
  initializeGit(f.vault.path);
  put(f, '.gitignore', 'Notient/\n');
  put(f, 'Untracked.md', 'Operator baseline pending.');
  const plan = testPlan(f, { tool: 'capture', operation: 'capture', source: 'Notient/Inbox/New.md', files: [{ path: 'Notient/Inbox/New.md', before: null, after: Buffer.from('new capture'), mode: 0o600 }] });
  plan.git = preflightGit(f.vault, plan.files);
  const result = coordinatePlan(f.vault, f.directory, () => plan, { adapter: createGitAdapter(f.vault, f.directory) });
  assert.equal(git(f.vault.path, ['ls-tree', '-r', '--name-only', 'HEAD']), 'Notient/Inbox/New.md');
  assert.equal(git(f.vault.path, ['show', '-s', '--format=%P', result.record.git.commit]), '');
});

test('foreign index locks remain intact and recovery finishes a published ref', t => {
  const f = writerFixture(t);
  baseline(f);
  const plan = planWithGit(f);
  const filename = path.join(f.vault.path, '.git/index.lock');
  const started = performance.now();
  const result = coordinatePlan(f.vault, f.directory, () => plan, { adapter: createGitAdapter(f.vault, f.directory), barrier(name) { if (name === 'afterRef') writeFileSync(filename, 'foreign lock'); } });
  assert.equal(result.record.git.indexInstalled, false);
  assert.equal(result.record.indexState, 'pending');
  assert.ok(performance.now() - started < 2000);
  assert.equal(readFileSync(filename, 'utf8'), 'foreign lock');
  put(f, 'One.md', 'Human edit after published commit.');
  unlinkSync(filename);
  assert.equal(finishRecord(f.vault, f.directory, result.record, createGitAdapter(f.vault, f.directory)).result, 'already_committed');
  assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Human edit after published commit.');
});

test('HEAD compare-and-swap failure preserves applied bytes and refuses publication', t => {
  const f = writerFixture(t);
  baseline(f);
  const plan = planWithGit(f);
  const old = plan.git.baseHead;
  const record = persistPlan(f.vault, f.directory, plan);
  assert.throws(() => finishRecord(f.vault, f.directory, record, createGitAdapter(f.vault, f.directory), { barrier(name) {
    if (name === 'afterPublish') {
      const tree = git(f.vault.path, ['rev-parse', `${old}^{tree}`]);
      const oid = git(f.vault.path, ['commit-tree', tree, '-p', old], { input: 'external commit\n', env: { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' } });
      git(f.vault.path, ['update-ref', 'refs/heads/main', oid, old]);
    }
  } }), error => error.code === 'GIT_HEAD_CHANGED');
  assert.deepEqual(readFileSync(path.join(f.vault.path, 'One.md')), plan.files[0].after);
  assert.notEqual(git(f.vault.path, ['rev-parse', 'HEAD']), record.git.commit);
});

test('Git selection environment is isolated and older Git gets a durability warning', t => {
  const f = writerFixture(t);
  baseline(f);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/invalid/inherited/git';
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  assert.equal(preflightGit(f.vault, planWithGit(f).files).ref, 'refs/heads/main');
  assert.equal(gitDurability(f.vault.path, 'git version 2.35.9').fsync, false);
  assert.equal(gitDurability(f.vault.path, 'git version 2.36.0').fsync, true);
});

test('actual command status resumes a durable Git operation in a fresh process', t => {
  const f = writerFixture(t);
  baseline(f);
  const record = persistPlan(f.vault, f.directory, planWithGit(f));
  const filename = fileURLToPath(new URL('../tools/status.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [filename, '{}'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  const recovered = snapshot.recovered.find(item => item.operationId === record.id);
  assert.equal(recovered?.result, 'resumed_from_intent');
  assert.equal(recovered?.commit, git(f.vault.path, ['rev-parse', 'HEAD']));
});
