import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord, saveRecord } from '../lib/journal.mjs';
import { moveFixture } from './move-publication.test.mjs';
import { snapshot } from './write-helpers.mjs';

const authorization = { origin: 'operator', request: 'Exercise reverse single-operation undo.' };
const run = (f, tool, input) => {
  const result = writeOperation(tool, { vault: f.vault.id, batch: 'r4-chain', authorization, ...input }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
};
const bytes = (f, name) => readFileSync(path.join(f.vault.path, name));

test('R4 capture, replace, frontmatter, undo frontmatter and undo replace restore exact buffers', t => {
  const f = moveFixture(t);
  const captured = run(f, 'capture', { requestId: 'r4-capture-001', name: 'Reverse chain', content: '# Original\n' });
  const name = captured.changes[0].path;
  const captureBytes = bytes(f, name);
  const replaced = run(f, 'revise', { requestId: 'r4-replace-001', operation: 'replace', path: name, revision: revision(captureBytes), oldText: 'Original', newText: 'Replaced' });
  const replacedBytes = bytes(f, name);
  const metadata = run(f, 'revise', { requestId: 'r4-frontmatter-001', operation: 'frontmatter', path: name, revision: revision(replacedBytes), set: [{ key: 'title', valueJson: '"Temporary metadata"' }] });
  run(f, 'undo', { requestId: 'r4-undo-frontmatter', opId: metadata.operationId });
  assert.deepEqual(bytes(f, name), replacedBytes);
  run(f, 'undo', { requestId: 'r4-undo-replace', opId: replaced.operationId });
  assert.deepEqual(bytes(f, name), captureBytes);
});

test('R4 rejects a backlink to a valid unrelated inverse instead of calling the original undone', t => {
  const f = moveFixture(t);
  const captured = run(f, 'capture', { requestId: 'r4-unrelated-capture', name: 'Unrelated cancellation', content: '# Original\n' });
  const changed = run(f, 'revise', { requestId: 'r4-peer-replace', operation: 'replace', path: 'Peer.md', revision: revision(bytes(f, 'Peer.md')), oldText: 'Peer', newText: 'Changed' });
  const inverse = run(f, 'undo', { requestId: 'r4-peer-inverse', opId: changed.operationId });
  const original = readRecord(f.directory, f.vault, captured.operationId);
  original.undoneBy = inverse.operationId;
  saveRecord(f.directory, f.vault, original);
  const before = snapshot(f.vault.path);
  const result = writeOperation('undo', { vault: f.vault.id, requestId: 'r4-wrong-backlink', batch: 'r4-inverse', authorization, opId: captured.operationId, dryRun: true }, { directory: f.directory });
  assert.equal(result.error.code, 'UNDO_HISTORY_CHANGED');
  assert.deepEqual(snapshot(f.vault.path), before);
});
