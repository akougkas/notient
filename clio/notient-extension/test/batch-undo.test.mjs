import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { simulateUndo } from '../lib/undo.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord } from '../lib/journal.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { moveFixture, moveInput, reviewedMove } from './move-publication.test.mjs';

const authorization = { origin: 'operator', request: 'Undo the selected batch and preserve its audit history.' };
const batchInput = (f, extra = {}) => ({ vault: f.vault.id, requestId: 'batch-undo-001', batch: 'inverse-task', targetBatch: 'move-task', authorization, ...extra });
const body = (f, name) => readFileSync(path.join(f.vault.path, name));
function reviewedUndo(f, input) {
  const preview = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const result = writeOperation('undo', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function replace(f, name, oldText, newText, requestId, batch = 'move-task') {
  const result = writeOperation('revise', { vault: f.vault.id, requestId, batch, authorization, operation: 'replace', path: name, revision: revision(body(f, name)), oldText, newText }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}

test('reverse simulation traverses absent intermediate move paths without disk reads', () => {
  const original = Buffer.from('original'); const edited = Buffer.from('edited');
  const records = [
    { files: [{ path: 'old.md', before: edited, after: null, mode: 0o600 }, { path: 'new.md', before: null, after: edited, mode: 0o600 }] },
    { files: [{ path: 'old.md', before: original, after: edited, mode: 0o600 }] },
    { files: [{ path: 'old.md', before: null, after: original, mode: 0o600 }] },
  ];
  const files = simulateUndo(records, new Map([['old.md', { bytes: null, mode: 0o600 }], ['new.md', { bytes: edited, mode: 0o600 }]]));
  assert.deepEqual(files, [{ path: 'new.md', role: 'note', before: edited, after: null, mode: 0o600 }]);
});

test('batch capture, replace and move restores exact originals in one inverse commit', t => {
  const f = moveFixture(t);
  const before = new Map(['old/One.md', 'A.md', 'B.md', 'C.md'].map(name => [name, body(f, name)]));
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'batch-capture-001', batch: 'move-task', authorization, name: 'Batch capture', content: '# Captured\r\nBody bytes.\r\n' }, { directory: f.directory });
  assert.equal(capture.ok, true, JSON.stringify(capture));
  const replacement = replace(f, 'old/One.md', '# One', '# Edited', 'batch-replace-001');
  const moved = reviewedMove(f);
  put(f, 'Human.md', 'Interleaved operator content.'); git(f.vault.path, ['add', '--', 'Human.md']);
  git(f.vault.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'operator interleaving']);
  const parent = git(f.vault.path, ['rev-parse', 'HEAD']);
  put(f, 'Unrelated.md', 'Unrelated staged Unicode 🧠.'); git(f.vault.path, ['add', '--', 'Unrelated.md']);
  const staged = normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes;
  const input = batchInput(f);
  assert.equal(writeOperation('undo', input, { directory: f.directory }).error.code, 'PLAN_HASH_REQUIRED');
  const unchanged = snapshot(f.temporary);
  const preview = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(snapshot(f.temporary), unchanged);
  const undone = writeOperation('undo', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(undone.undo.operationIds, [moved.operationId, replacement.operationId, capture.operationId]);
  assert.deepEqual(undone.undo.commits, [moved.commit.oid, replacement.commit.oid, capture.commit.oid]);
  assert.equal(undone.commit.parent, parent);
  for (const [name, bytes] of before) assert.deepEqual(body(f, name), bytes);
  assert.equal(existsSync(path.join(f.vault.path, moved.changes[0].path)), false);
  assert.equal(existsSync(path.join(f.vault.path, capture.changes[0].path)), false);
  assert.equal(body(f, 'Human.md').toString(), 'Interleaved operator content.');
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Unrelated.md').bytes, staged);
  for (const id of undone.undo.operationIds) assert.equal(readRecord(f.directory, f.vault, id).undoneBy, undone.operationId);
  assert.ok(git(f.vault.path, ['show', '-s', '--format=%B', undone.commit.oid]).includes(`Notient-Reverts: ${JSON.stringify(undone.undo.commits)}`));
  const lines = body(f, undone.log.path).toString().split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines.at(-1).slice(2)).undo, undone.undo.operationIds);
  assert.equal(writeOperation('undo', input, { directory: f.directory }).commit.oid, undone.commit.oid);
  const again = writeOperation('undo', { ...input, requestId: 'batch-undo-repeat' }, { directory: f.directory });
  assert.equal(again.outcome, 'noop', JSON.stringify(again));
  assert.deepEqual(again.undo.operationIds, [undone.operationId]);
});

test('batch undo follows a capture through replace and move and deletes only its final live path', t => {
  const f = moveFixture(t);
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'chain-capture-001', batch: 'capture-chain', authorization, name: 'Chain', content: '# Original\n' }, { directory: f.directory });
  assert.equal(capture.ok, true);
  const name = capture.changes[0].path;
  replace(f, name, 'Original', 'Changed', 'chain-replace-001', 'capture-chain');
  const move = { vault: f.vault.id, requestId: 'chain-move-001', batch: 'capture-chain', authorization, operation: 'move', path: name, revision: revision(body(f, name)), destination: 'Filed/Chain.md' };
  const preview = writeOperation('revise', { ...move, dryRun: true }, { directory: f.directory });
  const moved = writeOperation('revise', { ...move, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const inverse = reviewedUndo(f, batchInput(f, { targetBatch: 'capture-chain' }));
  assert.equal(existsSync(path.join(f.vault.path, name)), false);
  assert.equal(existsSync(path.join(f.vault.path, 'Filed/Chain.md')), false);
  assert.equal(inverse.changes.filter(file => !file.path.startsWith('Notient/Log/')).length, 1);
});

test('single move undo requires its preview hash and preserves exact rewritten referrer bytes', t => {
  const f = moveFixture(t);
  const before = new Map(['old/One.md', 'A.md', 'B.md', 'C.md'].map(name => [name, body(f, name)]));
  const moved = reviewedMove(f);
  const input = { vault: f.vault.id, requestId: 'single-move-undo', batch: 'inverse-task', authorization, opId: moved.operationId };
  assert.equal(writeOperation('undo', input, { directory: f.directory }).error.code, 'PLAN_HASH_REQUIRED');
  reviewedUndo(f, input);
  for (const [name, bytes] of before) assert.deepEqual(body(f, name), bytes);
});

test('batch undo refuses later active overlaps, even when a later operation restores matching bytes', t => {
  const f = moveFixture(t);
  reviewedMove(f);
  replace(f, 'A.md', 'Display', 'Intermediate', 'later-overlap-001', 'other-task');
  replace(f, 'A.md', 'Intermediate', 'Display', 'later-overlap-002', 'other-task');
  const before = snapshot(f.temporary);
  const result = writeOperation('undo', { ...batchInput(f), dryRun: true }, { directory: f.directory });
  assert.equal(result.error.code, 'UNDO_LATER_WRITE');
  assert.deepEqual(snapshot(f.temporary), before);
});

test('move inverse refuses edited referrers, occupied old paths and new incoming or rebound references', t => {
  for (const [name, bytes, code] of [
    ['B.md', 'Human edited the referrer.', 'UNDO_CONFLICT'],
    ['old/One.md', 'Occupied original path.', 'UNDO_CONFLICT'],
    ['New.md', '[[Two|new incoming]]', 'UNDO_REFERENCE_CONFLICT'],
    ['New.md', '[[One|formerly missing]]', 'UNDO_REFERENCE_CONFLICT'],
  ]) {
    const f = moveFixture(t); reviewedMove(f); put(f, name, bytes);
    const before = snapshot(f.temporary);
    const result = writeOperation('undo', { ...batchInput(f), dryRun: true }, { directory: f.directory });
    assert.equal(result.error.code, code, JSON.stringify(result));
    assert.deepEqual(snapshot(f.temporary), before);
  }
});

test('certified single-operation inverse pairs permit frontmatter, replace, capture undo in reverse order', t => {
  const f = moveFixture(t);
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'reverse-capture-001', batch: 'reverse-task', authorization, name: 'Reverse', content: '# Original\n' }, { directory: f.directory });
  assert.equal(capture.ok, true);
  const name = capture.changes[0].path;
  const replacement = replace(f, name, 'Original', 'Changed', 'reverse-replace-001', 'reverse-task');
  const metadata = writeOperation('revise', { vault: f.vault.id, requestId: 'reverse-metadata-001', batch: 'reverse-task', authorization, operation: 'frontmatter', path: name, revision: revision(body(f, name)), set: [{ key: 'title', valueJson: '"Metadata"' }] }, { directory: f.directory });
  assert.equal(metadata.ok, true, JSON.stringify(metadata));
  for (const [ordinal, original] of [metadata, replacement, capture].entries()) reviewedUndo(f, { vault: f.vault.id, requestId: `reverse-undo-${ordinal}`, batch: 'reverse-inverses', authorization, opId: original.operationId });
  assert.equal(existsSync(path.join(f.vault.path, name)), false);
  const repeated = writeOperation('undo', { ...batchInput(f), targetBatch: 'reverse-task', dryRun: true }, { directory: f.directory });
  assert.equal(repeated.outcome, 'noop', JSON.stringify(repeated));
  assert.equal(repeated.undo.operationIds.length, 3);
});

test('batch undo handles partially undone selections and ignores certified unrelated later pairs', t => {
  const f = moveFixture(t);
  const first = replace(f, 'Peer.md', 'Peer', 'Changed', 'partial-first-001', 'partial-task');
  const second = replace(f, 'C.md', '^id', '^block', 'partial-second-001', 'partial-task');
  reviewedUndo(f, { vault: f.vault.id, requestId: 'partial-single-undo', batch: 'partial-inverses', authorization, opId: second.operationId });
  const inverse = reviewedUndo(f, batchInput(f, { targetBatch: 'partial-task' }));
  assert.deepEqual(inverse.undo.operationIds, [first.operationId]);
  assert.equal(body(f, 'Peer.md').toString(), '# Peer\n');
});

test('batch undo CLI enforces exactly one selector and unattended move prohibition', t => {
  const f = moveFixture(t);
  const moved = reviewedMove(f);
  const input = batchInput(f, { dryRun: true });
  const filename = fileURLToPath(new URL('../tools/undo.mjs', import.meta.url));
  const run = value => spawnSync(process.execPath, [filename, JSON.stringify(value)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(run(input).status, 0);
  assert.equal(run({ ...input, opId: moved.operationId }).status, 1);
  assert.equal(run({ ...input, targetBatch: undefined }).status, 1);
  const refused = writeOperation('undo', { ...input, authorization: { origin: 'unattended', request: 'Undo this move.' } }, { directory: f.directory });
  assert.equal(refused.error.code, 'UNATTENDED_REFUSED');
  assert.equal(writeOperation('undo', { ...input, targetBatch: 'unknown-task' }, { directory: f.directory }).error.code, 'OPERATION_NOT_FOUND');
});

test('S5 unattended batch undo ignores a previously cancelled outside move', t => {
  const f = moveFixture(t);
  const capture = writeOperation('capture', { requestId: 'selection-capture', batch: 'selection', authorization, name: 'Selection', content: 'Captured evidence for selection.\n' }, { directory: f.directory });
  assert.equal(capture.ok, true, JSON.stringify(capture));
  const input = { requestId: 'selection-move', batch: 'selection', authorization, operation: 'move', path: capture.capture.path, destination: 'Outside.md', revision: capture.capture.revision };
  const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const moved = writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  reviewedUndo(f, { requestId: 'selection-cancel-move', batch: 'cancel-move', authorization, opId: moved.operationId });
  const inverse = { requestId: 'selection-close-batch', batch: 'close-selection', authorization: { origin: 'unattended', request: 'Undo the remaining managed capture.' }, targetBatch: 'selection' };
  const remaining = writeOperation('undo', { ...inverse, dryRun: true }, { directory: f.directory });
  assert.equal(remaining.ok, true, JSON.stringify(remaining));
  assert.deepEqual(remaining.undo.operationIds, [capture.operationId]);
  const closed = writeOperation('undo', { ...inverse, planHash: remaining.planHash }, { directory: f.directory });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(existsSync(path.join(f.vault.path, capture.capture.path)), false);
  const again = writeOperation('undo', { ...inverse, requestId: 'selection-closed-again', dryRun: true }, { directory: f.directory });
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.outcome, 'noop');
});

test('S7 a zero-delta active batch commits its audit and closes originals before an earlier undo', t => {
  const f = moveFixture(t);
  put(f, 'Staged.md', 'Unrelated staged bytes.\n'); git(f.vault.path, ['add', '--', 'Staged.md']);
  const initial = body(f, 'old/One.md');
  const earlier = replace(f, 'old/One.md', '# One', '# Earlier', 'zero-earlier-op', 'earlier-task');
  const stable = body(f, 'old/One.md');
  const first = replace(f, 'old/One.md', '# Earlier', '# Temporary', 'zero-first-op', 'zero-task');
  const second = replace(f, 'old/One.md', '# Temporary', '# Earlier', 'zero-second-op', 'zero-task');
  const staged = normalIndexEntries(f.vault.path).entries.get('Staged.md').bytes;
  const input = { requestId: 'zero-inverse-op', batch: 'zero-inverse', authorization, targetBatch: 'zero-task' };
  const preview = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.outcome, 'preview');
  assert.equal(preview.changes.length, 1); assert.match(preview.changes[0].path, /^Notient\/Log\/\d{4}-\d{2}\.md$/);
  const inverse = reviewedUndo(f, input);
  assert.deepEqual(body(f, 'old/One.md'), stable);
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Staged.md').bytes, staged);
  assert.deepEqual(git(f.vault.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', inverse.commit.oid]).split('\n'), [inverse.log.path]);
  for (const original of [first, second]) assert.equal(readRecord(f.directory, f.vault, original.operationId).undoneBy, inverse.operationId);
  assert.deepEqual(inverse.undo.operationIds, [second.operationId, first.operationId]);
  assert.equal(body(f, inverse.log.path).toString().split('\n').filter(line => line.startsWith('- ')).length, 4);
  const count = git(f.vault.path, ['rev-list', '--count', 'HEAD']);
  assert.equal(writeOperation('undo', { ...input, planHash: preview.planHash }, { directory: f.directory }).commit.oid, inverse.commit.oid);
  const again = writeOperation('undo', { ...input, requestId: 'zero-inverse-again', dryRun: true }, { directory: f.directory });
  assert.equal(again.outcome, 'noop'); assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), count);
  const undoneEarlier = writeOperation('undo', { requestId: 'zero-undo-earlier', batch: 'earlier-inverse', authorization, opId: earlier.operationId }, { directory: f.directory });
  assert.equal(undoneEarlier.ok, true, JSON.stringify(undoneEarlier)); assert.deepEqual(body(f, 'old/One.md'), initial);
});

test('S7 audit-only inverse recovery closes originals once after intent or ref publication', t => {
  for (const barrier of ['afterIntent', 'afterRef']) {
    const f = moveFixture(t);
    const first = replace(f, 'Peer.md', 'Peer', 'Temporary', 'zero-recover-first', 'zero-recover-task');
    const second = replace(f, 'Peer.md', 'Temporary', 'Peer', 'zero-recover-second', 'zero-recover-task');
    const input = { requestId: 'zero-recover-inverse', batch: 'zero-recover-inverse', authorization, targetBatch: 'zero-recover-task' };
    const preview = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory });
    const stopped = writeOperation('undo', { ...input, planHash: preview.planHash }, { directory: f.directory, barrier(name) { if (name === barrier) throw Object.assign(new Error('Stop audit-only inverse.'), { code: 'INJECTED_STOP' }); } });
    assert.equal(stopped.error.code, 'INJECTED_STOP', JSON.stringify(stopped));
    const recovered = commandStatusSnapshot(f.directory).recovered[0];
    assert.equal(recovered.result, barrier === 'afterRef' ? 'already_committed' : 'resumed_from_intent');
    for (const original of [first, second]) assert.equal(readRecord(f.directory, f.vault, original.operationId).undoneBy, input.requestId);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '4');
    commandStatusSnapshot(f.directory);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '4');
  }
});
