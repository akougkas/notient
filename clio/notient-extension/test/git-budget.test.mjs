import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writerFixture, snapshot, testPlan } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { git, preflightGit, createGitAdapter } from '../lib/git.mjs';
import { writeOperation, coordinatePlan } from '../lib/write.mjs';
import { operationDirectory } from '../lib/journal.mjs';
import { revision } from '../lib/paths.mjs';

test('T5 preflight stops successful subprocesses at one aggregate Git deadline', t => {
  const f = writerFixture(t); baseline(f); let elapsed = 0; let calls = 0;
  const files = [{ path: 'One.md', before: readFileSync(path.join(f.vault.path, 'One.md')), after: Buffer.from('After\n'), mode: 0o644 }];
  assert.throws(() => preflightGit(f.vault, files, { now: () => elapsed, call(root, args, options) { calls++; const result = git(root, args, options); elapsed += 20000; return result; } }), error => error.code === 'GIT_TIMEOUT');
  assert.equal(calls, 3);
});

test('T5 an exhausted planning allowance refuses before persisting any operation intent', t => {
  const f = writerFixture(t); baseline(f);
  const plan = testPlan(f, { id: 'exhausted-before-intent', files: [{ path: 'One.md', before: readFileSync(path.join(f.vault.path, 'One.md')), after: Buffer.from('After\n'), mode: 0o644 }] });
  plan.git = preflightGit(f.vault, plan.files); plan.timings = { gitMs: 60001 };
  const before = snapshot(f.vault.path);
  assert.throws(() => coordinatePlan(f.vault, f.directory, () => plan, { adapter: createGitAdapter(f.vault, f.directory) }), error => error.code === 'GIT_TIMEOUT');
  assert.equal(existsSync(path.join(operationDirectory(f.directory, f.vault, plan.id), 'record.json')), false);
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('T5 every original in batch undo consumes the same remaining verification allowance', t => {
  const f = writerFixture(t); baseline(f);
  const authorization = { origin: 'operator', request: 'Replace both fixture notes.' };
  for (const name of ['One.md', 'Other.md']) {
    const result = writeOperation('revise', { requestId: `budget-original-${name}`, batch: 'budget-originals', authorization, operation: 'replace', path: name, revision: revision(readFileSync(path.join(f.vault.path, name))), oldText: 'Baseline', newText: 'Changed' }, { directory: f.directory });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const before = snapshot(f.temporary); let elapsed = 0; let calls = 0;
  const result = writeOperation('undo', { requestId: 'budget-undo-preview', batch: 'budget-inverse', authorization, targetBatch: 'budget-originals', dryRun: true }, { directory: f.directory, gitClock: () => elapsed, gitCall(root, args, options) { calls++; const result = git(root, args, options); elapsed += 2000; return result; } });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, 'GIT_TIMEOUT'); assert.equal(result.operationId, null);
  assert.equal(calls, 30); assert.deepEqual(snapshot(f.temporary), before);
});

test('T5 a real replace carries its preliminary preflight cost into locked planning', t => {
  const f = writerFixture(t); baseline(f); let elapsed = 0; let calls = 0;
  const before = snapshot(f.vault.path);
  const result = writeOperation('revise', { requestId: 'budget-repeat-preflight', batch: 'budget-repeat', authorization: { origin: 'operator', request: 'Replace the baseline.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' }, { directory: f.directory, gitClock: () => elapsed, gitCall(root, args, options) { calls++; const result = git(root, args, options); elapsed += 2500; return result; } });
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, 'GIT_TIMEOUT'); assert.equal(result.operationId, null);
  assert.equal(calls, 24); assert.deepEqual(snapshot(f.vault.path), before);
});
