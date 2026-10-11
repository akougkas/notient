import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../lib/config.mjs';
import { currentFile, revision } from '../lib/paths.mjs';
import { readRecord, readBlob, operationDirectory, withWriterLock } from '../lib/journal.mjs';
import { persistPlan, finishRecord, freshAuthority, coordinatePlan } from '../lib/write.mjs';
import { writerFixture, put, snapshot, testPlan, memoryGit } from './write-helpers.mjs';

test('journal durably preserves exact immutable blobs and rejects corruption', t => {
  const f = writerFixture(t);
  const plan = testPlan(f);
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
    plan.files.forEach((file, i) => put(f, file.path, state === 'after' || (state === 'mixed' && i === 0) ? file.after : file.before));
    const record = persistPlan(f.vault, f.directory, plan);
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
  put(f, 'One.md', 'Third-party bytes.');
  const record = persistPlan(f.vault, f.directory, plan);
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
  const record = persistPlan(f.vault, f.directory, testPlan(f));
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
  assert.throws(() => freshAuthority(f.vault, f.directory, record), error => error.code === 'RECOVERY_BLOCKED_AUTHORIZATION');
  put(f, 'One.md', 'original');
  assert.throws(() => currentFile(f.vault.path, 'one.md'), error => error.code === 'CASE_COLLISION');
  symlinkSync(path.join(f.vault.path, 'One.md'), path.join(f.vault.path, 'Link.md'));
  assert.throws(() => currentFile(f.vault.path, 'Link.md'), error => error.code === 'UNSAFE_PATH');
  for (const name of ['../One.md', 'CON.md', 'Bad. /One.md', '.hidden.md']) assert.throws(() => currentFile(f.vault.path, name));
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
