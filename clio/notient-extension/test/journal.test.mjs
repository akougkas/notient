import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../lib/config.mjs';
import { currentFile, revision } from '../lib/paths.mjs';
import { readRecord, readBlob, operationDirectory, withWriterLock, claimFileIntent, readFileIntents } from '../lib/journal.mjs';
import { persistPlan, finishRecord, freshAuthority, coordinatePlan, reconcileFile } from '../lib/write.mjs';
import { writerFixture, put, snapshot, testPlan, memoryGit } from './write-helpers.mjs';

test('journal durably preserves exact immutable blobs and rejects corruption', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  const record = persistPlan(f.vault, f.directory, plan);
  assert.deepEqual(readBlob(f.directory, f.vault, record.id, record.files[0].before), plan.files[0].before);
  assert.deepEqual(readRecord(f.directory, f.vault, record.id), record);
  writeFileSync(path.join(operationDirectory(f.directory, f.vault, record.id), 'blobs', record.files[0].after), 'tampered');
  assert.throws(() => readRecord(f.directory, f.vault, record.id), error => error.code === 'JOURNAL_CORRUPT');
});

test('recovery completes before, after and mixed states exactly once', t => {
  for (const state of ['before', 'after', 'mixed']) {
    const f = writerFixture(t);
    const plan = testPlan(f, { files: [
      { path: 'One.md', before: Buffer.from('old one\r\n'), after: Buffer.from('new one\r\n'), mode: 0o600 },
      { path: 'Two.md', before: Buffer.from('old two'), after: Buffer.from('new two'), mode: 0o600 },
    ] });
    plan.files.forEach(file => put(f, file.path, file.before));
    const record = persistPlan(f.vault, f.directory, plan);
    for (const [i, file] of record.files.entries()) if (state === 'after' || state === 'mixed' && i === 0) {
      claimFileIntent(f.directory, f.vault, record, file);
      put(f, file.path, plan.files[i].after);
    }
    const adapter = memoryGit();
    const result = finishRecord(f.vault, f.directory, record, adapter);
    assert.equal(result.result, state === 'before' ? 'resumed_from_intent' : state === 'after' ? 'committed_after_apply' : 'completed_partial_apply');
    for (const file of plan.files) assert.deepEqual(readFileSync(path.join(f.vault.path, file.path)), file.after);
    put(f, 'One.md', 'Later human edit.');
    assert.equal(finishRecord(f.vault, f.directory, record, adapter).result, 'already_committed');
    assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Later human edit.');
  }
});

test('recovery preserves third-party bytes and resumes only after restoration', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  const record = persistPlan(f.vault, f.directory, plan);
  put(f, 'One.md', 'Third-party bytes.');
  const before = snapshot(f.vault.path);
  const adapter = memoryGit();
  assert.equal(finishRecord(f.vault, f.directory, record, adapter).result, 'conflict_preserved');
  assert.deepEqual(snapshot(f.vault.path), before);
  assert.equal(readRecord(f.directory, f.vault, record.id).state, 'conflicted');
  put(f, 'One.md', plan.files[0].before);
  assert.equal(finishRecord(f.vault, f.directory, record, adapter).result, 'resumed_from_intent');
});

test('creates use exclusive publication and torn files remain conflicts', t => {
  const f = writerFixture(t);
  const plan = testPlan(f, { files: [{ path: 'Notient/Inbox/New.md', before: null, after: Buffer.from('complete bytes'), mode: 0o600 }] });
  const record = persistPlan(f.vault, f.directory, plan);
  put(f, 'Notient/Inbox/New.md', 'complete');
  assert.equal(finishRecord(f.vault, f.directory, record, memoryGit()).result, 'conflict_preserved');
  unlinkSync(path.join(f.vault.path, 'Notient/Inbox/New.md'));
  assert.equal(finishRecord(f.vault, f.directory, record, memoryGit()).result, 'resumed_from_intent');
  assert.equal(currentFile(f.vault.path, 'Notient/Inbox/New.md').mode, 0o600);
});

test('writer lock releases after handler failure', t => {
  const f = writerFixture(t);
  assert.throws(() => withWriterLock(f.directory, f.vault, () => { throw new Error('stop'); }), /stop/);
  assert.equal(withWriterLock(f.directory, f.vault, () => 'released'), 'released');
});

test('revoked authorization blocks recovery and path aliases are refused', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  const record = persistPlan(f.vault, f.directory, plan);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
  assert.throws(() => freshAuthority(f.vault, f.directory, record), error => error.code === 'RECOVERY_BLOCKED_AUTHORIZATION');
  put(f, 'One.md', 'original');
  assert.throws(() => currentFile(f.vault.path, 'one.md'), error => error.code === 'CASE_COLLISION');
  symlinkSync(path.join(f.vault.path, 'One.md'), path.join(f.vault.path, 'Link.md'));
  assert.throws(() => currentFile(f.vault.path, 'Link.md'), error => error.code === 'UNSAFE_PATH');
  for (const name of ['../One.md', 'CON.md', 'Bad. /One.md', '.hidden.md']) assert.throws(() => currentFile(f.vault.path, name));
});

for (const [id, current, before, after, stamp, state, code, claim] of [
  ['R01', 'before', 'before', 'after', null, 'before', null, true],
  ['R02', 'before', 'before', 'after', 123, 'before', null, false],
  ['R03', 'after', 'before', 'after', null, 'conflict', 'UNSTAMPED_AFTER', false],
  ['R04', 'after', 'before', 'after', 123, 'after', null, false],
  ['R05', 'third', 'before', 'after', null, 'conflict', 'NEWER_EDIT', false],
  ['R06', 'third', 'before', 'after', 123, 'conflict', 'NEWER_EDIT', false],
  ['R07', 'same', 'same', 'same', null, 'unchanged', null, false],
  ['R08', 'same', 'same', 'same', 123, 'unchanged', null, false],
]) test(`four-input reconcile ${id}`, () => assert.deepEqual(reconcileFile(current, before, after, stamp), { state, code, claim }));

test('R2 unstamped replacement after-bytes stay conflicted and cannot acquire a retroactive claim', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  const record = persistPlan(f.vault, f.directory, plan);
  put(f, 'One.md', plan.files[0].after);
  const before = snapshot(f.vault.path);
  const result = finishRecord(f.vault, f.directory, record, memoryGit());
  assert.equal(result.result, 'conflict_preserved');
  assert.match(result.conflicts[0].reason, /^UNSTAMPED_AFTER/);
  assert.equal(readFileIntents(f.directory, f.vault, record).get('One.md').write_started_at_ms, null);
  assert.deepEqual(snapshot(f.vault.path), before);
  put(f, 'One.md', plan.files[0].before);
  assert.equal(finishRecord(f.vault, f.directory, record, memoryGit()).result, 'resumed_from_intent');
});

test('shared coordinator freezes plans and records directory fsync degradation', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  const result = coordinatePlan(f.vault, f.directory, () => plan, { adapter: memoryGit(), sync: () => false });
  assert.equal(result.record.state, 'committed');
  assert.equal(result.record.durability, 'directory-sync-unavailable');
  assert.equal(result.record.files[0].after, revision(plan.files[0].after));
});

test('state symlinks and foreign temporary siblings are refused before intent', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
  put(f, 'One.md', plan.files[0].before);
  put(f, `.notient-${plan.id}-0.tmp`, plan.files[0].after);
  const before = snapshot(f.vault.path);
  assert.throws(() => persistPlan(f.vault, f.directory, plan), error => error.code === 'TEMP_CONFLICT');
  assert.deepEqual(snapshot(f.vault.path), before);
  const stateLink = path.join(f.temporary, 'linked-state');
  symlinkSync(f.directory, stateLink);
  assert.throws(() => withWriterLock(stateLink, f.vault, () => 'must not run'), error => error.code === 'UNSAFE_STATE');
});
