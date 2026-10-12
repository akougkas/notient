import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { revision } from '../lib/paths.mjs';
import { writeOperation, buildWritePlan } from '../lib/write.mjs';
import { git } from '../lib/git.mjs';
import { planMove, scanMoveVault, guardInverseReferences } from '../lib/move.mjs';

const authorization = { origin: 'operator', request: 'Move the note and preserve history.' };
function fixture(t) {
  const f = writerFixture(t); put(f, 'Notient/Log/2000-01.md', '# Earlier history\n'); baseline(f);
  const input = { vault: f.vault.id, requestId: 'historical-move', batch: 'history', authorization, operation: 'move', path: 'One.md', destination: 'new/Two.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))) };
  return { ...f, input };
}

test('S2 move and inverse read every Markdown log including the current audit month', t => {
  const f = fixture(t); put(f, 'Notient/Log/2000-02.md', '# Other history\n');
  const plan = planMove(scanMoveVault(f.vault.path), 'One.md', 'new/Two.md');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.reads.filter(read => read.path.startsWith('Notient/Log/')).map(read => read.path), ['Notient/Log/2000-01.md', 'Notient/Log/2000-02.md']);
  const preview = writeOperation('revise', { ...f.input, dryRun: true }, { directory: f.directory });
  const moved = writeOperation('revise', { ...f.input, planHash: preview.planHash }, { directory: f.directory });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const input = { requestId: 'historical-inverse', batch: 'inverse-history', authorization, opId: moved.operationId, dryRun: true };
  const inverse = buildWritePlan('undo', f.vault, f.directory, input);
  assert.ok(inverse.reads.some(read => read.path === moved.log.path));
  assert.ok(inverse.reads.some(read => read.path === 'Notient/Log/2000-01.md'));
});

test('S2 a historical live reference is an AUDIT_LINK_BLOCKER for both directions', t => {
  const f = fixture(t); put(f, 'Notient/Log/2000-01.md', '[[One]]\n');
  const before = snapshot(f.vault.path);
  const plan = planMove(scanMoveVault(f.vault.path), 'One.md', 'new/Two.md');
  assert.equal(plan.blockers[0].code, 'AUDIT_LINK_BLOCKER'); assert.deepEqual(plan.files, []);
  const inverse = guardInverseReferences(scanMoveVault(f.vault.path), [{ path: 'One.md', before: readFileSync(path.join(f.vault.path, 'One.md')), after: null }]);
  assert.equal(inverse.blockers[0].code, 'AUDIT_LINK_BLOCKER');
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('S2 a historical edit after intent blocks publication of a move or its inverse', t => {
  for (const undo of [false, true]) {
    const f = fixture(t);
    const preview = writeOperation('revise', { ...f.input, dryRun: true }, { directory: f.directory });
    let input = { ...f.input, planHash: preview.planHash };
    if (undo) {
      const moved = writeOperation('revise', input, { directory: f.directory }); assert.equal(moved.ok, true, JSON.stringify(moved));
      input = { requestId: 'historical-undo-race', batch: 'history-inverse', authorization, opId: moved.operationId };
      input.planHash = writeOperation('undo', { ...input, dryRun: true }, { directory: f.directory }).planHash;
    }
    const head = git(f.vault.path, ['rev-parse', 'HEAD']);
    const result = writeOperation(undo ? 'undo' : 'revise', input, { directory: f.directory, barrier(name) {
      if (name === 'afterIntent') put(f, 'Notient/Log/2000-01.md', undo ? '[[Two]]\n' : '[[One]]\n');
    } });
    assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, 'DEPENDENCY_CHANGED');
    assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), head);
    assert.equal(readFileSync(path.join(f.vault.path, 'Notient/Log/2000-01.md'), 'utf8'), undo ? '[[Two]]\n' : '[[One]]\n');
  }
});
