import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord, readFileIntents } from '../lib/journal.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { atomicJson } from '../lib/config.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { moveFixture, moveInput, reviewedMove } from './move-publication.test.mjs';

const childFile = fileURLToPath(new URL('fault-child.mjs', import.meta.url));
const tools = fileURLToPath(new URL('../tools/', import.meta.url));
const command = (f, name, input = {}) => {
  const result = spawnSync(process.execPath, [path.join(tools, `${name}.mjs`), JSON.stringify(input)], { encoding: 'utf8', timeout: 20000, env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory), AI_AGENT: 'test' } });
  assert.ok(result.stdout, result.stderr);
  return { ...result, value: JSON.parse(result.stdout) };
};

async function killAt(t, f, tool, input, barrier, targetPath) {
  const child = fork(childFile, [JSON.stringify({ tool, input, directory: f.directory, barrier, path: targetPath })], { silent: true });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Barrier ${barrier} ${targetPath ?? ''} not reached: ${output}`)); }, 15000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Child exited before ${barrier}: ${output}`)); });
  });
  assert.equal(message.barrier, barrier);
  if (targetPath) assert.equal(message.path, targetPath);
  child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
  return message;
}

const observedHash = (f, name) => existsSync(path.join(f.vault.path, name)) ? revision(readFileSync(path.join(f.vault.path, name))) : null;
const undoInput = f => ({ vault: f.vault.id, requestId: 'fault-batch-undo', batch: 'fault-inverse', targetBatch: 'move-task', authorization: { origin: 'operator', request: 'Undo the complete moved-note batch.' } });

for (const tool of ['revise', 'undo']) test(`SIGKILL recovers ${tool === 'revise' ? 'move' : 'batch undo'} at every publication, index and cleanup barrier`, async t => {
  const log = `Notient/Log/${new Date().toISOString().slice(0, 7)}.md`;
  const fileOrder = tool === 'revise' ? ['deeper/new/Two.md', 'A.md', 'B.md', 'C.md', 'old/One.md', log] : ['old/One.md', 'A.md', 'B.md', 'C.md', 'deeper/new/Two.md', log];
  const cases = [
    ['afterCandidate', null, 'resumed_from_intent'],
    ['afterIntent', null, 'resumed_from_intent'],
    ...fileOrder.map((name, ordinal) => ['afterMovePath', name, ordinal === fileOrder.length - 1 ? 'committed_after_apply' : 'completed_partial_apply']),
    ['afterAllAfterBytes', null, 'committed_after_apply'],
    ['afterRef', null, 'already_committed'],
    ...fileOrder.map(name => ['duringIndex', name, 'already_committed']),
    ['afterCommitted', null, 'already_committed'],
  ];
  for (const [barrier, targetPath, expected] of cases) {
    await t.test(`${barrier}${targetPath ? ` ${targetPath}` : ''}`, async t => {
      const f = moveFixture(t);
      if (tool === 'undo') reviewedMove(f);
      put(f, 'Unrelated.md', 'Unrelated staged entry 🧠.'); git(f.vault.path, ['add', '--', 'Unrelated.md']);
      const unrelated = normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes;
      const raw = tool === 'revise' ? moveInput(f) : undoInput(f);
      const preview = writeOperation(tool, { ...raw, dryRun: true }, { directory: f.directory });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const input = { ...raw, planHash: preview.planHash };
      const message = await killAt(t, f, tool, input, barrier, targetPath);
      const pending = readRecord(f.directory, f.vault, message.operationId);
      const candidate = pending.git.commit;
      assert.equal(candidate, message.commit);
      const rows = readFileIntents(f.directory, f.vault, pending);
      assert.equal(rows.size, pending.files.length);
      for (const file of pending.files) {
        const actual = observedHash(f, file.path);
        assert.ok(actual === file.before || actual === file.after, `${barrier}: ${file.path}`);
        if (actual === file.after) assert.notEqual(rows.get(file.path).write_started_at_ms, null);
      }
      atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
      const beforeBlocked = snapshot(f.vault.path);
      const blocked = command(f, 'status');
      assert.equal(blocked.value.recovered.find(result => result.operationId === pending.id)?.result, 'RECOVERY_BLOCKED_AUTHORIZATION');
      assert.deepEqual(snapshot(f.vault.path), beforeBlocked);
      atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
      const first = command(f, 'status');
      assert.equal(first.status, 0, first.stderr);
      const recovered = first.value.recovered.find(result => result.operationId === pending.id);
      assert.equal(recovered?.result, expected, JSON.stringify(first.value.recovered));
      assert.equal(recovered.commit, candidate);
      assert.ok(Number.isFinite(recovered.elapsedMs) && recovered.elapsedMs >= 0);
      const second = command(f, 'status');
      assert.equal(second.value.vaults[0].journal.pendingCount, 0, JSON.stringify(second.value));
      for (const file of pending.files) {
        assert.equal(observedHash(f, file.path), file.after);
        if (file.temp) assert.equal(existsSync(path.join(f.vault.path, file.temp)), false);
      }
      assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), tool === 'revise' ? '2' : '3');
      assert.equal(command(f, tool, input).value.commit.oid, candidate);
      assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes, unrelated);
      const lines = readFileSync(path.join(f.vault.path, log), 'utf8').split('\n').filter(line => line.startsWith('- '));
      assert.equal(lines.length, tool === 'revise' ? 1 : 2);
      if (tool === 'undo') for (const id of pending.undo.targets) assert.equal(readRecord(f.directory, f.vault, id).undoneBy, pending.id);
    });
  }
});

for (const tool of ['revise', 'undo']) test(`torn O_EXCL ${tool === 'revise' ? 'move destination' : 'inverse source'} stays conflicted until restored to absence`, async t => {
  const f = moveFixture(t);
  if (tool === 'undo') reviewedMove(f);
  const raw = tool === 'revise' ? moveInput(f) : undoInput(f);
  const preview = writeOperation(tool, { ...raw, dryRun: true }, { directory: f.directory });
  const input = { ...raw, planHash: preview.planHash };
  const targetPath = tool === 'revise' ? 'deeper/new/Two.md' : 'old/One.md';
  const message = await killAt(t, f, tool, input, 'duringCreate', targetPath);
  const pending = readRecord(f.directory, f.vault, message.operationId);
  const file = pending.files.find(file => file.path === targetPath);
  const torn = readFileSync(path.join(f.vault.path, targetPath));
  assert.notEqual(revision(torn), file.after);
  assert.notEqual(readFileIntents(f.directory, f.vault, pending).get(targetPath).write_started_at_ms, null);
  const before = snapshot(f.vault.path);
  assert.equal(command(f, 'status').value.recovered.find(result => result.operationId === pending.id).result, 'conflict_preserved');
  assert.equal(command(f, 'status').value.recovered.find(result => result.operationId === pending.id).result, 'conflict_preserved');
  assert.deepEqual(snapshot(f.vault.path), before);
  put(f, targetPath, Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00]));
  assert.equal(command(f, 'status').value.recovered.find(result => result.operationId === pending.id).result, 'conflict_preserved');
  assert.deepEqual(readFileSync(path.join(f.vault.path, targetPath)), Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00]));
  unlinkSync(path.join(f.vault.path, targetPath));
  assert.equal(command(f, 'status').value.recovered.find(result => result.operationId === pending.id).result, 'resumed_from_intent');
  assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), pending.git.commit);
});

test('published move and inverse preserve subsequent human saves during index and cleanup recovery', async t => {
  for (const [tool, barrier] of [['revise', 'duringIndex'], ['undo', 'afterCommitted']]) {
    const f = moveFixture(t);
    if (tool === 'undo') reviewedMove(f);
    const raw = tool === 'revise' ? moveInput(f) : undoInput(f);
    const preview = writeOperation(tool, { ...raw, dryRun: true }, { directory: f.directory });
    const message = await killAt(t, f, tool, { ...raw, planHash: preview.planHash }, barrier);
    const livePath = tool === 'revise' ? 'deeper/new/Two.md' : 'old/One.md';
    put(f, livePath, 'Human saved after the published ref.\n');
    const first = command(f, 'status');
    assert.equal(first.value.recovered.find(result => result.operationId === message.operationId).result, 'already_committed');
    command(f, 'status');
    assert.equal(readFileSync(path.join(f.vault.path, livePath), 'utf8'), 'Human saved after the published ref.\n');
    assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), message.commit);
  }
});

test('multi-path index repair preserves a same-path entry changed after an earlier repair', t => {
  const f = moveFixture(t);
  let staged = false;
  const moved = reviewedMove(f, {}, { barrier(name, record) {
    if (name !== 'duringIndex' || staged) return;
    staged = true; put(f, 'B.md', 'Operator staging during repair.'); git(f.vault.path, ['add', '--', 'B.md']);
  } });
  assert.equal(moved.ok, false);
  assert.equal(moved.error.code, 'COMMITTED_INDEX_CONFLICT');
  assert.equal(moved.commit, git(f.vault.path, ['rev-parse', 'HEAD']));
  const operatorEntry = normalIndexEntries(f.vault.path).entries.get('B.md').bytes;
  commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('B.md').bytes, operatorEntry);
});
