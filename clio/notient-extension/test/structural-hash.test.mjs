import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writerFixture } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { revision } from '../lib/paths.mjs';
import { writeOperation } from '../lib/write.mjs';
import { git } from '../lib/git.mjs';

const first = { origin: 'clio', request: 'First attribution.' };
const second = { origin: 'operator', request: 'Changed attribution only.' };
function fixture(t) {
  const f = writerFixture(t); baseline(f);
  const move = { requestId: 'hash-move-attribution', batch: 'hash-first', authorization: first, operation: 'move', path: 'One.md', destination: 'new/Two.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))) };
  return { ...f, move };
}

test('S6 move attribution and batch changes preserve the structural hash and publish new attribution', t => {
  const f = fixture(t);
  const preview = writeOperation('revise', { ...f.move, dryRun: true }, { directory: f.directory });
  const changed = { ...f.move, batch: 'hash-second', authorization: second };
  const repeated = writeOperation('revise', { ...changed, dryRun: true }, { directory: f.directory });
  assert.equal(repeated.planHash, preview.planHash);
  const result = writeOperation('revise', { ...changed, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(git(f.vault.path, ['show', '-s', '--format=%B', result.commit.oid]), /Notient-Batch: hash-second\nNotient-Origin: operator/);
});

test('S6 batch inverse attribution changes preserve its reviewed structural hash', t => {
  const f = fixture(t);
  const preview = writeOperation('revise', { ...f.move, dryRun: true }, { directory: f.directory });
  const moved = writeOperation('revise', { ...f.move, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const inverse = { requestId: 'hash-batch-attribution', batch: 'inverse-first', targetBatch: f.move.batch, authorization: first };
  const before = writeOperation('undo', { ...inverse, dryRun: true }, { directory: f.directory });
  const changed = { ...inverse, batch: 'inverse-second', authorization: second };
  const after = writeOperation('undo', { ...changed, dryRun: true }, { directory: f.directory });
  assert.equal(after.planHash, before.planHash);
  const result = writeOperation('undo', { ...changed, planHash: before.planHash }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(git(f.vault.path, ['show', '-s', '--format=%B', result.commit.oid]), /Notient-Batch: inverse-second\nNotient-Origin: operator/);
});
