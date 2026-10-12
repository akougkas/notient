import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord, readBlob, syncDirectory } from '../lib/journal.mjs';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson } from '../lib/config.mjs';
import { refreshIndex } from '../lib/index.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

const childFile = fileURLToPath(new URL('fault-child.mjs', import.meta.url));
const tools = fileURLToPath(new URL('../tools/', import.meta.url));
function fixture(t) { const f = writerFixture(t); baseline(f); refreshIndex(f.vault, f.directory); return f; }
const inputFor = f => ({ vault: f.vault.id, requestId: 'fault-revise-001', batch: 'fault-barrier', authorization: { origin: 'operator', request: 'Replace Baseline with Changed.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' });
const command = (f, name, input = {}) => {
  const result = spawnSync(process.execPath, [path.join(tools, `${name}.mjs`), JSON.stringify(input)], { encoding: 'utf8', timeout: 20000, env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory), AI_AGENT: 'test' } });
  return { ...result, value: JSON.parse(result.stdout) };
};

async function stopAt(t, f, barrier, input = inputFor(f), tool = 'revise') {
  const child = fork(childFile, [JSON.stringify({ tool, input, directory: f.directory, barrier })], { silent: true });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fault child did not reach ${barrier}: ${output}`)), 12000);
    child.once('message', message => { clearTimeout(timer); assert.equal(message.barrier, barrier); resolve(message); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fault child exited before its barrier: ${output}`)); });
  });
  return { child, exited, input };
}

test('SIGKILL at all three stage 2a barriers recovers once through fresh status processes', async t => {
  for (const barrier of ['afterIntent', 'afterPublish', 'afterRef']) {
    const f = fixture(t);
    const before = readFileSync(path.join(f.vault.path, 'One.md'));
    const baseHead = git(f.vault.path, ['rev-parse', 'HEAD']);
    const staged = normalIndexEntries(f.vault.path).entries.get('Other.md').bytes;
    const stopped = await stopAt(t, f, barrier);
    assert.deepEqual(readFileSync(path.join(f.vault.path, 'One.md')), barrier === 'afterIntent' ? before : Buffer.from('Changed One.md\n'));
    const pending = readRecord(f.directory, f.vault, stopped.input.requestId);
    if (barrier === 'afterRef') assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), pending.git.commit);
    else assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), baseHead);
    stopped.child.kill('SIGKILL');
    assert.equal((await stopped.exited).signal, 'SIGKILL');
    const first = command(f, 'status');
    assert.equal(first.status, 0, first.stderr);
    const recovered = first.value.recovered.find(result => result.operationId === stopped.input.requestId);
    assert.equal(recovered?.result, { afterIntent: 'resumed_from_intent', afterPublish: 'committed_after_apply', afterRef: 'already_committed' }[barrier]);
    const oid = git(f.vault.path, ['rev-parse', 'HEAD']);
    assert.equal(recovered?.commit, oid);
    const second = command(f, 'status');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.value.vaults[0].journal.pendingCount, 0);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
    const record = readRecord(f.directory, f.vault, stopped.input.requestId);
    assert.equal(readFileSync(path.join(f.vault.path, record.log.path), 'utf8').split('\n').filter(line => line.startsWith('- ')).length, 1);
    assert.equal(command(f, 'revise', stopped.input).value.commit.oid, oid);
    assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Other.md').bytes, staged);
    assert.ok(!existsSync(path.join(f.vault.path, record.files[0].temp)));
  }
});

test('SIGKILL recovery preserves third-party bytes until the original state is restored', async t => {
  const f = fixture(t);
  const stopped = await stopAt(t, f, 'afterPublish');
  stopped.child.kill('SIGKILL'); await stopped.exited;
  put(f, 'One.md', 'Third-party saved after the kill.\n');
  const before = snapshot(f.vault.path);
  const first = command(f, 'status');
  assert.equal(first.value.recovered[0].result, 'conflict_preserved');
  assert.equal(first.value.vaults[0].journal.pendingCount, 1);
  assert.equal(command(f, 'status').value.recovered[0].result, 'conflict_preserved');
  assert.deepEqual(snapshot(f.vault.path), before);
  put(f, 'One.md', 'Baseline One.md\n');
  const resumed = command(f, 'status');
  assert.equal(resumed.value.recovered[0].result, 'completed_partial_apply');
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
});

test('a live writer reports busy and a killed writer releases its SQLite lock', async t => {
  const f = fixture(t);
  const stopped = await stopAt(t, f, 'afterIntent');
  const before = snapshot(f.vault.path);
  const status = command(f, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.value.vaults[0].journal.busy, true);
  assert.equal(status.value.recovered[0].result, 'WRITER_BUSY');
  const competing = command(f, 'capture', { vault: f.vault.id, batch: 'competing', authorization: { origin: 'operator', request: 'Capture while busy.' }, name: 'Competing', content: 'Must not be written.' });
  assert.equal(competing.status, 1);
  assert.equal(competing.value.error.code, 'WRITER_BUSY');
  assert.deepEqual(snapshot(f.vault.path), before);
  stopped.child.kill('SIGKILL'); await stopped.exited;
  assert.equal(command(f, 'status').value.recovered[0].result, 'resumed_from_intent');
});

test('revoking write access prevents recovery of an already durable intent', async t => {
  const f = fixture(t);
  const stopped = await stopAt(t, f, 'afterIntent');
  stopped.child.kill('SIGKILL'); await stopped.exited;
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
  const before = snapshot(f.vault.path);
  const blocked = command(f, 'status');
  assert.equal(blocked.value.recovered[0].result, 'RECOVERY_BLOCKED_AUTHORIZATION');
  assert.deepEqual(snapshot(f.vault.path), before);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
  assert.equal(command(f, 'status').value.recovered[0].result, 'resumed_from_intent');
});

test('undo backlinks recover after ref publication without another inverse commit', async t => {
  const f = fixture(t);
  const original = writeOperation('revise', inputFor(f), { directory: f.directory });
  const undo = { vault: f.vault.id, requestId: 'fault-undo-001', batch: 'fault-undo', authorization: { origin: 'operator', request: 'Undo the original operation.' }, opId: original.operationId };
  const stopped = await stopAt(t, f, 'afterRef', undo, 'undo');
  stopped.child.kill('SIGKILL'); await stopped.exited;
  assert.equal(readRecord(f.directory, f.vault, original.operationId).undoneBy, null);
  assert.equal(command(f, 'status').value.recovered[0].result, 'already_committed');
  assert.equal(readRecord(f.directory, f.vault, original.operationId).undoneBy, undo.requestId);
  command(f, 'status');
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '3');
  assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Baseline One.md\n');
});

test('observed save races are preserved and the recheck-to-rename gap remains explicit', t => {
  for (const phase of ['beforeRecheck', 'afterFilePublish', 'afterRecheck']) {
    const f = fixture(t);
    let saved = false;
    const result = writeOperation('revise', inputFor(f), { directory: f.directory, observe(name, record, file) {
      if (name === phase && file.role === 'note' && !saved) { saved = true; put(f, file.path, `Human save at ${phase}.\n`); }
    } });
    if (phase === 'afterRecheck') {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Changed One.md\n');
      assert.ok(result.warnings.some(warning => warning.code === 'QUIESCENT_FILES_REQUIRED'));
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'REVISION_CONFLICT');
      assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), `Human save at ${phase}.\n`);
      assert.equal(command(f, 'status').value.recovered[0].result, 'conflict_preserved');
    }
  }
});

test('unsupported directory fsync is reported while file fsync and Git publication proceed', t => {
  const f = fixture(t);
  const result = writeOperation('revise', inputFor(f), { directory: f.directory, sync: () => false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.warnings.some(warning => warning.code === 'DIRECTORY_SYNC_UNAVAILABLE'));
  assert.equal(readRecord(f.directory, f.vault, result.operationId).durability, 'directory-sync-unavailable');
});

test('an exclusive capture killed before publication recovers its frozen name and complete bytes', async t => {
  const f = fixture(t);
  const input = { vault: f.vault.id, requestId: 'native-capture-kill', batch: 'native-capture', authorization: { origin: 'operator', request: 'Capture exact Unicode bytes.' }, name: 'Native capture', content: '\uFEFF# Café 🧠\r\nComplete captured bytes.' };
  const stopped = await stopAt(t, f, 'afterIntent', input, 'capture');
  const intent = readRecord(f.directory, f.vault, input.requestId);
  const capturedPath = intent.capture.path;
  assert.match(capturedPath, /^Notient\/Inbox\/\d{4}-\d{2}-\d{2}-Native capture\.md$/);
  assert.equal(existsSync(path.join(f.vault.path, capturedPath)), false);
  stopped.child.kill('SIGKILL'); await stopped.exited;
  const resumed = command(f, 'status');
  assert.equal(resumed.value.recovered[0].result, 'resumed_from_intent');
  assert.deepEqual(readFileSync(path.join(f.vault.path, capturedPath)), readBlob(f.directory, f.vault, intent.id, intent.files[0].after));
  assert.match(readFileSync(path.join(f.vault.path, capturedPath), 'utf8'), /created_by: "operator"/);
  const retry = command(f, 'capture', input);
  assert.equal(retry.value.outcome, 'already_committed');
  assert.equal(retry.value.commit.oid, resumed.value.recovered[0].commit);
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
});

test('an unapplied intent invalidated by a later HEAD aborts without pending recovery', async t => {
  const f = fixture(t);
  const base = git(f.vault.path, ['rev-parse', 'HEAD']);
  const stopped = await stopAt(t, f, 'afterIntent');
  stopped.child.kill('SIGKILL'); await stopped.exited;
  const tree = git(f.vault.path, ['rev-parse', `${base}^{tree}`]);
  const external = git(f.vault.path, ['commit-tree', tree, '-p', base], { input: 'operator advanced HEAD\n', env: { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' } });
  git(f.vault.path, ['update-ref', 'refs/heads/main', external, base]);
  const result = command(f, 'status');
  assert.equal(result.value.recovered[0].result, 'aborted_unapplied');
  assert.equal(result.value.recovered[0].commit, null);
  assert.equal(result.value.vaults[0].journal.pendingCount, 0);
  assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Baseline One.md\n');
  assert.equal(command(f, 'revise', stopped.input).value.error.code, 'OPERATION_ABORTED');
});

test('error records are saved before the writer lock is released', t => {
  const f = fixture(t);
  let raised = false;
  let checked = false;
  let protectedSave = true;
  const result = writeOperation('revise', inputFor(f), { directory: f.directory,
    observe(name) { if (name === 'beforeRecheck') { raised = true; throw Object.assign(new Error('injected write refusal'), { code: 'INJECTED_FAILURE' }); } },
    sync(directory) {
      if (raised) {
        checked = true;
        const db = new DatabaseSync(path.join(f.directory, 'journal', f.vault.id, 'writer.db'));
        try { db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE'); protectedSave = false; }
        catch (error) { if (!/database is locked/.test(error.message)) throw error; }
        finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
      }
      return syncDirectory(directory);
    },
  });
  assert.equal(result.error.code, 'INJECTED_FAILURE');
  assert.equal(checked, true);
  assert.equal(protectedSave, true);
});
