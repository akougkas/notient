import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { readRecord } from '../lib/journal.mjs';
import { moveFixture, moveInput, reviewedMove } from './move-publication.test.mjs';
import { put } from './write-helpers.mjs';

test('R1 index retry preserves a newly staged third value and skips an installed after-entry', t => {
  for (const value of ['third', 'after']) {
    const f = moveFixture(t);
    const lock = path.join(f.vault.path, '.git/index.lock');
    let expectedEntry;
    let retries = 0;
    const result = reviewedMove(f, {}, { barrier(name, record, file) {
      if (name === 'afterRef') writeFileSync(lock, 'foreign fixture lock');
      if (name !== 'indexRetry') return;
      retries++;
      unlinkSync(lock);
      if (value === 'third') put(f, file.path, 'Operator staged a third value while releasing the lock.');
      git(f.vault.path, ['add', '--', file.path]);
      expectedEntry = normalIndexEntries(f.vault.path).entries.get(file.path).bytes;
    } });
    assert.equal(retries, 1);
    assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('deeper/new/Two.md').bytes, expectedEntry);
    if (value === 'third') {
      assert.ok(result.warnings.some(warning => warning.code === 'COMMITTED_INDEX_CONFLICT'));
      assert.equal(result.commit.oid, git(f.vault.path, ['rev-parse', 'HEAD']));
      assert.equal(readFileSync(path.join(f.vault.path, 'deeper/new/Two.md'), 'utf8'), 'Operator staged a third value while releasing the lock.');
    } else assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('R3 published index-pending work is committed, blocks new writes and supports undo after repair', t => {
  const f = moveFixture(t);
  const lock = path.join(f.vault.path, '.git/index.lock');
  const result = reviewedMove(f, {}, { barrier(name) { if (name === 'afterRef') writeFileSync(lock, 'foreign lock'); } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.indexState, 'pending');
  assert.equal(result.derivedIndexState, 'updated');
  const record = readRecord(f.directory, f.vault, result.operationId);
  assert.equal(record.state, 'committed');
  const blocked = writeOperation('capture', { vault: f.vault.id, requestId: 'index-blocked-capture', batch: 'index-blocked', authorization: { origin: 'operator', request: 'Capture while normal index repair is pending.' }, name: 'Blocked', content: 'Must not be published.' }, { directory: f.directory });
  assert.equal(blocked.error.code, 'RECOVERY_REQUIRED');
  assert.equal(blocked.operationId, null);
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
  const status = commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.ok(status.vaults[0].journal.remaining.includes(result.operationId));
  assert.equal(status.recovered[0].vault, f.vault.id);
  assert.ok(status.recovered[0].elapsedMs >= 0);
  assert.equal(status.vaults[0].journal.operations[0].requestId, result.requestId);
  unlinkSync(lock);
  const input = { vault: f.vault.id, requestId: 'pending-move-inverse', batch: 'inverse-pending', authorization: { origin: 'operator', request: 'Undo the committed move after index repair.' }, opId: result.operationId };
  commandStatusSnapshot(f.directory, { vault: f.vault.id });
  const preview = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const inverse = writeOperation('undo', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(inverse.ok, true, JSON.stringify(inverse));
  assert.equal(inverse.commit.parent, result.commit.oid);
  assert.equal(inverse.indexState, 'updated');
  assert.equal(inverse.derivedIndexState, 'updated');
});

test('review hash binds vault identity and operation while attribution stays outside it', t => {
  const f = moveFixture(t);
  const input = moveInput(f);
  const preview = raw => writeOperation('revise', { ...input, ...raw, dryRun: true }, { directory: f.directory });
  const original = preview({});
  for (const extra of [{ batch: 'another-batch' }, { authorization: { origin: 'clio', request: 'Different attribution words.' } }]) {
    const changed = preview(extra);
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.planHash, original.planHash);
  }
  const g = moveFixture(t);
  const other = writeOperation('revise', { ...moveInput(g), dryRun: true }, { directory: g.directory });
  assert.notEqual(other.planHash, original.planHash);
  const { destination, ...base } = input;
  const replacement = writeOperation('revise', { ...base, operation: 'replace', oldText: '# One', newText: '# One', dryRun: true }, { directory: f.directory });
  const metadata = writeOperation('revise', { ...base, operation: 'frontmatter', unset: ['absent'], dryRun: true }, { directory: f.directory });
  assert.equal(replacement.outcome, 'noop', JSON.stringify(replacement));
  assert.equal(metadata.outcome, 'noop', JSON.stringify(metadata));
  assert.notEqual(replacement.planHash, metadata.planHash);
});
