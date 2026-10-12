import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { revision, WriteError } from '../lib/paths.mjs';
import { atomicJson } from '../lib/config.mjs';
import { readRecord } from '../lib/journal.mjs';
import { git } from '../lib/git.mjs';
import { moveFixture } from './move-publication.test.mjs';
import { snapshot } from './write-helpers.mjs';

const input = f => ({ vault: f.vault.id, requestId: 'r7-revise-001', batch: 'r7-authority', authorization: { origin: 'operator', request: 'Replace the selected fixture heading.' }, operation: 'replace', path: 'Peer.md', revision: revision(readFileSync(path.join(f.vault.path, 'Peer.md'))), oldText: 'Peer', newText: 'Changed' });

test('R7 rechecks read-only registration after the lock and before file or ref publication', t => {
  for (const barrier of ['afterWriterLock', 'afterCandidate', 'afterAllAfterBytes']) {
    const f = moveFixture(t);
    const before = readFileSync(path.join(f.vault.path, 'Peer.md'));
    const head = git(f.vault.path, ['rev-parse', 'HEAD']);
    const result = writeOperation('revise', input(f), { directory: f.directory, barrier(name) {
      if (name === barrier) atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] });
    } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(['READ_ONLY_VAULT', 'RECOVERY_BLOCKED_AUTHORIZATION'].includes(result.error.code));
    assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), head);
    if (barrier !== 'afterAllAfterBytes') assert.deepEqual(readFileSync(path.join(f.vault.path, 'Peer.md')), before);
    else assert.equal(result.partial, true);
    if (barrier === 'afterWriterLock') assert.equal(result.operationId, null);
  }
});

test('R7 role downgrade after lock acquisition refuses unattended work before intent', t => {
  const f = moveFixture(t);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own' }] });
  const before = snapshot(f.vault.path);
  const result = writeOperation('revise', { ...input(f), authorization: { origin: 'unattended', request: 'Revise the own-vault note.' } }, { directory: f.directory, barrier(name) {
    if (name === 'afterWriterLock') atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
  } });
  assert.equal(result.error.code, 'UNATTENDED_REFUSED');
  assert.equal(result.operationId, null);
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('R7 all-before intent aborts after a symbolic branch change without publishing or staying pending', t => {
  const f = moveFixture(t);
  const head = git(f.vault.path, ['rev-parse', 'HEAD']);
  const before = readFileSync(path.join(f.vault.path, 'Peer.md'));
  const result = writeOperation('revise', input(f), { directory: f.directory, barrier(name) { if (name === 'afterIntent') throw new WriteError('STOP_FOR_BRANCH_CHANGE', 'Pause before publication.'); } });
  assert.equal(result.ok, false);
  git(f.vault.path, ['update-ref', 'refs/heads/other', head]);
  writeFileSync(path.join(f.vault.path, '.git/HEAD'), 'ref: refs/heads/other\n');
  const status = commandStatusSnapshot(f.directory, { vault: f.vault.id });
  assert.equal(status.recovered[0].result, 'aborted_unapplied', JSON.stringify(status.recovered));
  assert.equal(status.recovered[0].commit, null);
  assert.equal(status.vaults[0].journal.pendingCount, 0);
  assert.equal(readRecord(f.directory, f.vault, result.operationId).state, 'aborted');
  assert.deepEqual(readFileSync(path.join(f.vault.path, 'Peer.md')), before);
  assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), head);
});
