import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord } from '../lib/journal.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { refreshIndex } from '../lib/index.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

function fixture(t) { const f = writerFixture(t); baseline(f); refreshIndex(f.vault, f.directory); return f; }
const authorization = { origin: 'operator', request: 'Undo the one recorded operation.' };
const inputFor = (f, opId, extra = {}) => ({ vault: f.vault.id, batch: 'single-undo', authorization, opId, ...extra });
function replace(f, oldText, newText, requestId) { return writeOperation('revise', { vault: f.vault.id, batch: 'replace-chain', authorization: { origin: 'operator', request: 'Replace the named phrase.' }, requestId, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText, newText }, { directory: f.directory }); }

test('T3 single and batch undo preserve an unstaged executable-bit change on replaced or captured notes', t => {
  for (const capture of [false, true]) for (const batch of [false, true]) {
    const f = fixture(t);
    const original = capture ? writeOperation('capture', { name: 'Mode', content: 'Capture mode baseline.\n', batch: 'mode-target', authorization }, { directory: f.directory }) : replace(f, 'Baseline', 'Changed', 'mode-replace-original');
    assert.equal(original.ok, true, JSON.stringify(original));
    const name = capture ? original.capture.path : 'One.md';
    chmodSync(path.join(f.vault.path, name), 0o755);
    const before = snapshot(f.vault.path);
    const input = { requestId: 'mode-inverse-refusal', batch: 'mode-inverse', authorization, dryRun: true, ...(batch ? { targetBatch: original.batch } : { opId: original.operationId }) };
    const refused = writeOperation('undo', input, { directory: f.directory });
    assert.equal(refused.ok, false, JSON.stringify(refused)); assert.equal(refused.error.code, 'DIRTY_TARGET'); assert.equal(refused.operationId, null);
    assert.deepEqual(snapshot(f.vault.path), before); assert.ok(statSync(path.join(f.vault.path, name)).mode & 0o111);
    assert.equal(readRecord(f.directory, f.vault, original.operationId).undoneBy, null);
  }
});

test('single-operation undo restores exact note buffers and retains the original log prefix', t => {
  for (const bytes of ['# LF\nOriginal\n', '\uFEFF---\r\ntitle: Original\r\n...\r\n# Body\nOriginal', '# CRLF\r\nOriginal\r\n']) {
    const f = writerFixture(t);
    put(f, 'One.md', bytes);
    baseline(f);
    refreshIndex(f.vault, f.directory);
    const changed = replace(f, 'Original', 'Changed', 'replace-before-undo');
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const logBefore = readFileSync(path.join(f.vault.path, changed.log.path));
    const inverse = writeOperation('undo', inputFor(f, changed.operationId), { directory: f.directory });
    assert.equal(inverse.ok, true, JSON.stringify(inverse));
    assert.deepEqual(readFileSync(path.join(f.vault.path, 'One.md')), Buffer.from(bytes));
    assert.deepEqual(readFileSync(path.join(f.vault.path, changed.log.path)).subarray(0, logBefore.length), logBefore);
    assert.equal(readRecord(f.directory, f.vault, changed.operationId).undoneBy, inverse.operationId);
    assert.deepEqual(inverse.undo.commits, [changed.commit.oid]);
    assert.ok(git(f.vault.path, ['show', '-s', '--format=%B', inverse.commit.oid]).includes(`Notient-Reverts: ["${changed.commit.oid}"]`));
    const retry = writeOperation('undo', inputFor(f, changed.operationId, { requestId: inverse.requestId }), { directory: f.directory });
    assert.equal(retry.outcome, 'already_committed');
    assert.equal(retry.commit.oid, inverse.commit.oid);
    const repeated = writeOperation('undo', inputFor(f, changed.operationId), { directory: f.directory });
    assert.equal(repeated.outcome, 'noop', JSON.stringify(repeated));
    assert.deepEqual(repeated.undo.operationIds, [inverse.operationId]);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '3');
    assert.equal(writeOperation('undo', inputFor(f, inverse.operationId), { directory: f.directory }).error.code, 'UNDO_OF_UNDO');
  }
});

test('undo of a capture requires review and removes only its captured file', t => {
  const f = fixture(t);
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'capture-for-undo-001', batch: 'capture-undo', authorization, name: 'Captured', content: '# Captured\nExact bytes.' }, { directory: f.directory });
  assert.equal(capture.ok, true, JSON.stringify(capture));
  const undoInput = inputFor(f, capture.operationId, { requestId: 'undo-capture-001' });
  assert.equal(writeOperation('undo', undoInput, { directory: f.directory }).error.code, 'PLAN_HASH_REQUIRED');
  const before = snapshot(f.temporary);
  const preview = writeOperation('undo', { ...undoInput, dryRun: true }, { directory: f.directory });
  assert.equal(preview.outcome, 'preview', JSON.stringify(preview));
  assert.equal(preview.changes[0].action, 'delete');
  assert.deepEqual(snapshot(f.temporary), before);
  const inverse = writeOperation('undo', { ...undoInput, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(inverse.ok, true, JSON.stringify(inverse));
  assert.equal(existsSync(path.join(f.vault.path, capture.changes[0].path)), false);
  assert.equal(readFileSync(path.join(f.vault.path, 'One.md'), 'utf8'), 'Baseline One.md\n');
  const lines = readFileSync(path.join(f.vault.path, capture.log.path), 'utf8').split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1].slice(2)).undo, [capture.operationId]);
});

test('single undo preserves interleaved operator commits and unrelated staged index bytes', t => {
  const f = fixture(t);
  const changed = replace(f, 'Baseline', 'Notient', 'undo-interleave-001');
  put(f, 'Human.md', 'Interleaved operator commit.\n');
  git(f.vault.path, ['add', '--', 'Human.md']);
  git(f.vault.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'operator interleaving']);
  const operatorHead = git(f.vault.path, ['rev-parse', 'HEAD']);
  put(f, 'Other.md', 'Unrelated staged content.\n');
  git(f.vault.path, ['add', '--', 'Other.md']);
  const unrelated = normalIndexEntries(f.vault.path).entries.get('Other.md').bytes;
  const inverse = writeOperation('undo', inputFor(f, changed.operationId), { directory: f.directory });
  assert.equal(inverse.ok, true, JSON.stringify(inverse));
  assert.equal(inverse.commit.parent, operatorHead);
  assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Other.md').bytes, unrelated);
  assert.equal(git(f.vault.path, ['show', 'HEAD:Human.md']), 'Interleaved operator commit.');
});

test('undo preserves later edits and refuses later overlapping Notient writes even if bytes match', t => {
  const f = fixture(t);
  const original = replace(f, 'Baseline', 'Original result', 'overlap-first-001');
  put(f, 'One.md', 'Human changed bytes.');
  const before = snapshot(f.temporary);
  assert.equal(writeOperation('undo', inputFor(f, original.operationId), { directory: f.directory }).error.code, 'UNDO_CONFLICT');
  assert.deepEqual(snapshot(f.temporary), before);
  put(f, 'One.md', 'Original result One.md\n');
  assert.equal(replace(f, 'Original result', 'Intermediate', 'overlap-second-001').ok, true);
  assert.equal(replace(f, 'Intermediate', 'Original result', 'overlap-third-001').ok, true);
  assert.equal(writeOperation('undo', inputFor(f, original.operationId), { directory: f.directory }).error.code, 'UNDO_LATER_WRITE');
});

test('capture deletion refuses new incoming links and unknown operation IDs', t => {
  const f = fixture(t);
  const capture = writeOperation('capture', { vault: f.vault.id, batch: 'linked-capture', authorization, name: 'Referenced', content: '# Referenced\n' }, { directory: f.directory });
  put(f, 'New referrer.md', `[[${capture.changes[0].path.replace(/\.md$/, '')}]] now has a live incoming link.\n`);
  const before = snapshot(f.temporary);
  const result = writeOperation('undo', inputFor(f, capture.operationId, { dryRun: true }), { directory: f.directory });
  assert.equal(result.error.code, 'UNDO_REFERENCE_CONFLICT');
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(writeOperation('undo', inputFor(f, 'unknown-op-001'), { directory: f.directory }).error.code, 'OPERATION_NOT_FOUND');
});

test('undo enforces unattended boundaries and CLI excludes batch undo', t => {
  const f = fixture(t);
  const changed = replace(f, 'Baseline', 'Changed', 'unattended-target-001');
  const refused = writeOperation('undo', inputFor(f, changed.operationId, { authorization: { origin: 'unattended', request: 'Undo outside Notient.' } }), { directory: f.directory });
  assert.equal(refused.error.code, 'UNATTENDED_REFUSED');
  const filename = fileURLToPath(new URL('../tools/undo.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [filename, JSON.stringify({ ...inputFor(f, changed.operationId), targetBatch: 'replace-chain' })], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_INPUT');
});

test('undo refuses rewritten history even when an old undone marker remains', t => {
  const f = fixture(t);
  const before = git(f.vault.path, ['rev-parse', 'HEAD']);
  const original = replace(f, 'Baseline', 'Changed', 'history-original-001');
  const inverse = writeOperation('undo', inputFor(f, original.operationId), { directory: f.directory });
  assert.equal(inverse.ok, true, JSON.stringify(inverse));
  git(f.vault.path, ['update-ref', 'refs/heads/main', before, inverse.commit.oid]);
  const refused = writeOperation('undo', inputFor(f, original.operationId), { directory: f.directory });
  assert.equal(refused.error.code, 'UNDO_HISTORY_CHANGED');
});
