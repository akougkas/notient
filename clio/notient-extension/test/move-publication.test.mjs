import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeOperation, commandStatusSnapshot, buildWritePlan, persistPlan, finishRecord } from '../lib/write.mjs';
import { revision, WriteError } from '../lib/paths.mjs';
import { readRecord, readFileIntents, journalRoot } from '../lib/journal.mjs';
import { git, normalIndexEntries, createGitAdapter } from '../lib/git.mjs';
import { refreshIndex } from '../lib/index.mjs';
import { atomicJson } from '../lib/config.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

export function moveFixture(t) {
  const f = writerFixture(t);
  put(f, 'old/One.md', '\uFEFF# One\r\n[peer](../Peer.md) ![image](../media/a%20b.png) [[#^self]]\r\n');
  put(f, 'Peer.md', '# Peer\n'); put(f, 'media/a b.png', 'image');
  put(f, 'A.md', '[[One|Display]]\n'); put(f, 'B.md', '[label](old/One.md "Title")\n'); put(f, 'C.md', '![[One#^id]]\n');
  baseline(f, ['old/One.md', 'Peer.md', 'media/a b.png', 'A.md', 'B.md', 'C.md']);
  refreshIndex(f.vault, f.directory);
  return f;
}

export const moveInput = f => ({ vault: f.vault.id, requestId: 'move-publication-001', batch: 'move-task', authorization: { origin: 'operator', request: 'Move old/One.md to deeper/new/Two.md and repair all references.' }, operation: 'move', path: 'old/One.md', revision: revision(readFileSync(path.join(f.vault.path, 'old/One.md'))), destination: 'deeper/new/Two.md' });
export function reviewedMove(f, extra = {}, options = {}) {
  const input = { ...moveInput(f), ...extra };
  const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  return writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory, ...options });
}

test('real move publishes destination, sorted referrers, source removal and one log in one commit', t => {
  const f = moveFixture(t);
  put(f, 'Unrelated.md', 'Unrelated stage.\n'); git(f.vault.path, ['add', '--', 'Unrelated.md']);
  const unrelated = normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes;
  const input = moveInput(f);
  const order = [];
  const moved = reviewedMove(f, {}, { observe(event, record, file) { if (event === 'afterFilePublish') order.push(file.path); } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(order, ['deeper/new/Two.md', 'A.md', 'B.md', 'C.md', 'old/One.md', moved.log.path]);
  assert.equal(existsSync(path.join(f.vault.path, 'old/One.md')), false);
  assert.equal(readFileSync(path.join(f.vault.path, 'deeper/new/Two.md'), 'utf8'), '\uFEFF# One\r\n[peer](../../Peer.md) ![image](../../media/a%20b.png) [[#^self]]\r\n');
  assert.equal(readFileSync(path.join(f.vault.path, 'A.md'), 'utf8'), '[[Two|Display]]\n');
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes, unrelated);
  const record = readRecord(f.directory, f.vault, moved.operationId);
  assert.equal(record.destination, 'deeper/new/Two.md');
  assert.equal(record.intentSet.prepared, true);
  const intents = readFileIntents(f.directory, f.vault, record);
  assert.equal(intents.size, 6);
  assert.ok([...intents.values()].every(row => row.state === 'applied' && row.write_started_at_ms !== null));
  assert.deepEqual(git(f.vault.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', moved.commit.oid]).split('\n').sort(), [...order].sort());
  assert.equal(readFileSync(path.join(f.vault.path, moved.log.path), 'utf8').split('\n').filter(line => line.startsWith('- ')).length, 1);
  const retry = writeOperation('revise', { ...input, planHash: moved.planHash }, { directory: f.directory });
  assert.equal(retry.outcome, 'already_committed', JSON.stringify(retry));
  assert.equal(retry.commit.oid, moved.commit.oid);
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
});


test('partial move recovery resumes stamped destination and keeps the original OID and log once', t => {
  const f = moveFixture(t);
  const input = moveInput(f);
  const moved = reviewedMove(f, {}, { observe(event, record, file) { if (event === 'afterFilePublish' && file.path === 'A.md') throw new WriteError('INJECTED_STOP', 'Stop after one referrer.'); } });
  assert.equal(moved.ok, false);
  assert.equal(moved.partial, true);
  assert.equal(existsSync(path.join(f.vault.path, input.destination)), true);
  assert.equal(existsSync(path.join(f.vault.path, input.path)), true);
  const candidate = readRecord(f.directory, f.vault, moved.operationId).git.commit;
  const recovered = commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.equal(recovered.recovered[0].result, 'completed_partial_apply', JSON.stringify(recovered.recovered));
  assert.equal(recovered.recovered[0].commit, candidate);
  const retry = writeOperation('revise', { ...input, planHash: readRecord(f.directory, f.vault, moved.operationId).planHash }, { directory: f.directory });
  assert.equal(retry.commit.oid, candidate);
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
});

test('move recovery refuses unstamped after-bytes and torn destinations without deleting either', t => {
  for (const desired of [true, false]) {
    const f = moveFixture(t);
    const input = { ...moveInput(f), dryRun: false };
    const plan = buildWritePlan('revise', f.vault, f.directory, input);
    const record = persistPlan(f.vault, f.directory, plan);
    const destination = plan.files[0];
    const foreign = desired ? destination.after : destination.after.subarray(0, 9);
    put(f, input.destination, foreign);
    const result = finishRecord(f.vault, f.directory, record, createGitAdapter(f.vault, f.directory));
    assert.equal(result.result, 'conflict_preserved');
    assert.match(result.conflicts[0].reason, desired ? /UNSTAMPED_AFTER/ : /NEWER_EDIT/);
    assert.deepEqual(readFileSync(path.join(f.vault.path, input.destination)), foreign);
    assert.equal(readFileIntents(f.directory, f.vault, record).get(input.destination).write_started_at_ms, null);
    unlinkSync(path.join(f.vault.path, input.destination));
    assert.equal(finishRecord(f.vault, f.directory, record, createGitAdapter(f.vault, f.directory)).result, 'resumed_from_intent');
  }
});

test('move final source recheck preserves a concurrent source save and recovery waits for restoration', t => {
  const f = moveFixture(t);
  const source = readFileSync(path.join(f.vault.path, 'old/One.md'));
  const failed = reviewedMove(f, {}, { observe(event, record, file) { if (event === 'beforeRecheck' && file.path === record.source) put(f, file.path, 'Concurrent source save.'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'REVISION_CONFLICT');
  assert.equal(readFileSync(path.join(f.vault.path, 'old/One.md'), 'utf8'), 'Concurrent source save.');
  const status = commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.equal(status.recovered[0].result, 'conflict_preserved');
  put(f, 'old/One.md', source);
  assert.equal(commandStatusSnapshot(f.directory, { vault: f.vault.id }).recovered[0].result, 'completed_partial_apply');
});

test('move hash binds origin, request, inventory including attachments and unaffected note revisions', t => {
  for (const change of ['origin', 'request', 'attachment', 'dependency']) {
    const f = moveFixture(t);
    const input = moveInput(f);
    const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory });
    if (change === 'origin') input.authorization = { ...input.authorization, origin: 'clio' };
    if (change === 'request') input.authorization = { ...input.authorization, request: 'Different exact words.' };
    if (change === 'attachment') put(f, 'media/new.png', 'new');
    if (change === 'dependency') put(f, 'Peer.md', 'External dependency save.');
    const before = snapshot(f.vault.path);
    const result = writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory });
    assert.equal(result.error.code, 'PLAN_CHANGED', JSON.stringify(result));
    assert.equal(result.operationId, null);
    assert.deepEqual(snapshot(f.vault.path), before);
  }
});

test('move prepares all intents before first stamp and corrupt rows block recovery', t => {
  const f = moveFixture(t);
  const failed = reviewedMove(f, {}, { barrier(event, record) {
    if (event !== 'afterIntent') return;
    const rows = [...readFileIntents(f.directory, f.vault, record).values()];
    assert.equal(rows.length, record.files.length);
    assert.equal(rows.filter(row => row.write_started_at_ms !== null).length, 1);
    throw new WriteError('INJECTED_STOP', 'Stop before first publish.');
  } });
  assert.equal(failed.ok, false);
  const database = new DatabaseSync(path.join(journalRoot(f.directory, f.vault), 'intents.db'));
  database.prepare('DELETE FROM intents WHERE path=?').run('B.md'); database.close();
  const before = snapshot(f.vault.path);
  const status = commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.equal(status.recovered[0].result, 'JOURNAL_CORRUPT');
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('move refuses unattended origin and revoked recovery while own role permits the same origin', t => {
  const f = moveFixture(t);
  const unattended = { origin: 'unattended', request: 'Move the selected note.' };
  assert.equal(writeOperation('revise', { ...moveInput(f), authorization: unattended, dryRun: true }, { directory: f.directory }).error.code, 'UNATTENDED_REFUSED');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own' }] });
  const pending = reviewedMove(f, { authorization: unattended }, { barrier(event) { if (event === 'afterIntent') throw new WriteError('INJECTED_STOP', 'Stop before publish.'); } });
  assert.equal(pending.ok, false);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
  const before = snapshot(f.vault.path);
  assert.equal(commandStatusSnapshot(f.directory, { vault: f.vault.id }).recovered[0].result, 'RECOVERY_BLOCKED_AUTHORIZATION');
  assert.deepEqual(snapshot(f.vault.path), before);
});
