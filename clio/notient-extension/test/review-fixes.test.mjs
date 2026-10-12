import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeOperation } from '../lib/write.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
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
      assert.equal(result.error.code, 'COMMITTED_INDEX_CONFLICT');
      assert.equal(result.commit, git(f.vault.path, ['rev-parse', 'HEAD']));
      assert.equal(readFileSync(path.join(f.vault.path, 'deeper/new/Two.md'), 'utf8'), 'Operator staged a third value while releasing the lock.');
    } else assert.equal(result.ok, true, JSON.stringify(result));
  }
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
