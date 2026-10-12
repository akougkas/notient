import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writerFixture, put } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { revision } from '../lib/paths.mjs';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { readRecord } from '../lib/journal.mjs';
import { git } from '../lib/git.mjs';

test('S3 published moves are recognized before oversized or invalid later destination bytes', t => {
  for (const later of [Buffer.alloc(4 * 1024 * 1024 + 1, 'x'), Buffer.from([0xff, 0, 0xfe])]) {
    const f = writerFixture(t); baseline(f);
    const input = { requestId: 'published-recognition', batch: 'recognition', authorization: { origin: 'operator', request: 'Move the note.' }, operation: 'move', path: 'One.md', destination: 'new/Two.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))) };
    const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory });
    const stopped = writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory, barrier(name) { if (name === 'afterRef') throw Object.assign(new Error('Stop after publishing the ref.'), { code: 'INJECTED_STOP' }); } });
    assert.equal(stopped.error.code, 'INJECTED_STOP', JSON.stringify(stopped));
    const oid = git(f.vault.path, ['rev-parse', 'HEAD']);
    put(f, input.destination, later);
    const status = commandStatusSnapshot(f.directory);
    assert.equal(status.recovered[0].result, 'already_committed', JSON.stringify(status.recovered));
    assert.equal(status.recovered[0].commit, oid);
    const record = readRecord(f.directory, f.vault, input.requestId);
    assert.equal(record.state, 'committed'); assert.equal(record.indexState, 'updated');
    assert.deepEqual(readFileSync(path.join(f.vault.path, input.destination)), later);
    assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '2');
    commandStatusSnapshot(f.directory);
    assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), oid);
  }
});
