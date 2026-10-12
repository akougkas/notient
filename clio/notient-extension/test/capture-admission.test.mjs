import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captureDocument, captureBodyHash } from '../lib/capture.mjs';
import { documentSpans } from '../lib/markdown.mjs';
import { writeOperation } from '../lib/write.mjs';
import { atomicJson } from '../lib/config.mjs';
import { refreshIndex } from '../lib/index.mjs';
import { git } from '../lib/git.mjs';
import { revision } from '../lib/paths.mjs';
import { moveFixture } from './move-publication.test.mjs';
import { snapshot } from './write-helpers.mjs';
import { readRecord } from '../lib/journal.mjs';

const input = (f, n = 0) => ({ vault: f.vault.id, requestId: `r6-capture-${n}`, batch: 'r6-capture', authorization: { origin: 'operator', request: 'Capture the supplied fixture body.' }, name: 'Admission', content: `# Body ${n}\n` });
const run = (f, raw, options = {}) => writeOperation('capture', raw, { directory: f.directory, ...options });

test('T7 capture tag items must be strings rather than mappings, nested collections or typed scalars', t => {
  for (const tags of ['\n  - key: value', '[key: value]', '\n  - - nested', '\n  - 1_000', '[0b101]', '[false]', '[null]', '[{}]', '[[]]']) {
    assert.throws(() => captureDocument({ content: `---\ntags: ${tags}\n---\nBody\n`, authorization: { origin: 'clio' } }, '2026-10-11T12:00:00.000Z'), error => error.code === 'CAPTURE_TAGS_INVALID', tags);
  }
  for (const tags of ['["key: value", "1_000", "false", "null"]', "\n  - 'key: value'\n  - 'project:clio'", '[]']) {
    assert.doesNotThrow(() => captureDocument({ content: `---\ntags: ${tags}\n---\nBody\n`, authorization: { origin: 'clio' } }, '2026-10-11T12:00:00.000Z'), tags);
  }
  const f = moveFixture(t); const before = snapshot(f.vault.path);
  const refused = run(f, { ...input(f, 300), content: '---\ntags:\n  - key: value\n---\nDo not capture.\n' });
  assert.equal(refused.error.code, 'CAPTURE_TAGS_INVALID'); assert.equal(refused.operationId, null); assert.deepEqual(snapshot(f.vault.path), before);
});

test('T6 Clio is the capture contributor while journal, audit and Git retain authorization origin', t => {
  const f = moveFixture(t);
  for (const [i, origin] of ['operator', 'clio', 'unattended'].entries()) {
    const request = { ...input(f, 200 + i), authorization: { origin, request: 'Capture the observed contributor attribution.' } };
    const captured = run(f, request); assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.match(readFileSync(path.join(f.vault.path, captured.capture.path), 'utf8'), /created_by: "clio"/);
    assert.equal(readRecord(f.directory, f.vault, captured.operationId).authorization.origin, origin);
    assert.equal(JSON.parse(captured.log.line.slice(2)).origin, origin);
    assert.ok(git(f.vault.path, ['show', '-s', '--format=%B', captured.commit.oid]).includes(`Notient-Origin: ${origin}`));
  }
  const time = new Date(); const request = { ...input(f, 210), content: 'Preview origin-only change.\n', dryRun: true };
  const first = run(f, request, { now: () => time });
  const second = run(f, { ...request, authorization: { ...request.authorization, origin: 'clio' } }, { now: () => time });
  assert.equal(first.planHash, second.planHash);
});

test('T4 capture dedup follows its own later moves when an inbox path is reused on the same UTC date', t => {
  const f = moveFixture(t); const time = new Date(); const now = () => time;
  const first = run(f, { ...input(f, 90), content: 'Body A\n' }, { now }); assert.equal(first.ok, true, JSON.stringify(first));
  const move = (captured, destination, requestId) => {
    const request = { requestId, batch: 'lineage-moves', authorization: input(f).authorization, operation: 'move', path: captured.capture.path, destination, revision: captured.capture.revision };
    const preview = writeOperation('revise', { ...request, dryRun: true }, { directory: f.directory });
    const result = writeOperation('revise', { ...request, planHash: preview.planHash }, { directory: f.directory }); assert.equal(result.ok, true, JSON.stringify(result));
  };
  move(first, 'Archive/A.md', 'lineage-move-first');
  const second = run(f, { ...input(f, 91), content: 'Body B\n' }, { now }); assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.capture.path, first.capture.path);
  const before = snapshot(f.temporary);
  const repeated = run(f, { ...input(f, 92), content: 'Body B\n' }, { now });
  assert.equal(repeated.outcome, 'noop', JSON.stringify(repeated)); assert.equal(repeated.capture.path, second.capture.path); assert.equal(repeated.capture.duplicateOf, second.operationId);
  assert.deepEqual(snapshot(f.temporary), before);
  move(second, 'Archive/B.md', 'lineage-move-second');
  const moved = run(f, { ...input(f, 93), content: 'Body B\n' }, { now });
  assert.equal(moved.outcome, 'noop'); assert.equal(moved.capture.path, 'Archive/B.md'); assert.equal(moved.capture.duplicateOf, second.operationId);
});

test('R6 capture construction preserves caller fields, BOM, EOF and string tags with Clio attribution', () => {
  for (const tags of ['[]', '["a # b", \'c\'\'d\', plain]', '[\n  "one", # comment\n  "two"\n]', '\n  - "one" # inline\n  - plain']) {
    const content = `\uFEFF--- \r\ntitle: "Caller"\r\ntags: ${tags}\r\n...\r\n# Body\r\nExact EOF`;
    const result = captureDocument({ content, authorization: { origin: 'clio' } }, '2026-10-11T12:30:00.000Z', '/fixture/Workspace');
    const doc = documentSpans(result.bytes);
    assert.equal(doc.text.slice(doc.bodyStart), '# Body\nExact EOF');
    assert.equal(doc.text[0], '\uFEFF');
    assert.ok(doc.text.includes('title: "Caller"'));
    assert.ok(doc.text.includes('created_by: "clio"'));
    assert.ok(doc.text.includes('workspace: "Workspace"'));
    assert.equal(result.bodyHash, revision('# Body\nExact EOF'));
  }
  for (const key of ['created_by', 'workspace', 'captured_at']) assert.throws(() => captureDocument({ content: `---\n${key}: supplied\n---\nBody`, authorization: { origin: 'operator' } }, new Date().toISOString()), error => error.code === 'CAPTURE_RESERVED_FIELD');
  for (const tags of ['word', 'null', '[1]', '[true]', '[{}]', '[[]]', '["a"junk]']) assert.throws(() => captureDocument({ content: `---\ntags: ${tags}\n---\nBody`, authorization: { origin: 'operator' } }, new Date().toISOString()), error => error.code === 'CAPTURE_TAGS_INVALID');
});

test('R6 body dedup ignores caller metadata, precedes quota and returns the live receipt without writes', t => {
  const f = moveFixture(t);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, captureLimitPerHour: 1 }] });
  const first = run(f, { ...input(f), content: '---\ntitle: First\n---\nBody\r\n' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = snapshot(f.temporary);
  const duplicate = run(f, { ...input(f, 1), name: 'Other title', content: '---\ntitle: Second\n---\nBody\n' });
  assert.equal(duplicate.outcome, 'noop', JSON.stringify(duplicate));
  assert.equal(duplicate.capture.path, first.capture.path);
  assert.equal(duplicate.capture.duplicateOf, first.operationId);
  assert.equal(duplicate.capture.revision, first.capture.revision);
  assert.deepEqual(snapshot(f.temporary), before);
  assert.equal(run(f, input(f, 2)).error.code, 'CAPTURE_RATE_LIMIT');
});

test('R6 dedup follows a committed move and stops matching after the live body changes', t => {
  const f = moveFixture(t);
  const first = run(f, input(f));
  const move = { vault: f.vault.id, requestId: 'r6-file-capture', batch: 'r6-file', authorization: input(f).authorization, operation: 'move', path: first.capture.path, revision: first.capture.revision, destination: 'Filed/Captured.md' };
  const preview = writeOperation('revise', { ...move, dryRun: true }, { directory: f.directory });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(writeOperation('revise', { ...move, planHash: preview.planHash }, { directory: f.directory }).ok, true);
  const duplicate = run(f, { ...input(f, 1), content: input(f).content });
  assert.equal(duplicate.outcome, 'noop', JSON.stringify(duplicate));
  assert.equal(duplicate.capture.path, move.destination);
  const edited = writeOperation('revise', { vault: f.vault.id, requestId: 'r6-edit-live-body', batch: 'r6-edit', authorization: input(f).authorization, operation: 'replace', path: move.destination, revision: duplicate.capture.revision, oldText: 'Body 0', newText: 'Changed body' }, { directory: f.directory });
  assert.equal(edited.ok, true);
  const next = run(f, { ...input(f, 2), content: input(f).content });
  assert.equal(next.outcome, 'committed', JSON.stringify(next));
  assert.notEqual(next.capture.path, duplicate.capture.path);
});

test('R6 default rolling quota admits twelve, refuses thirteen and admits after expiry', t => {
  const f = moveFixture(t);
  const at = new Date('2026-10-11T12:00:00.000Z');
  for (let n = 0; n < 12; n++) {
    const result = run(f, input(f, n), { now: () => at });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const before = snapshot(f.temporary);
  const refused = run(f, input(f, 12), { now: () => at });
  assert.equal(refused.error.code, 'CAPTURE_RATE_LIMIT');
  assert.ok(refused.error.message.includes('2026-10-11T13:00:00.000Z'));
  assert.deepEqual(snapshot(f.temporary), before);
  const admitted = run(f, input(f, 12), { now: () => new Date('2026-10-11T13:00:00.001Z') });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(git(f.vault.path, ['rev-list', '--count', 'HEAD']), '14');
});

test('R6 preview timestamps do not change review hashes, while dates and workspaces remain bound', t => {
  const f = moveFixture(t);
  const raw = input(f);
  const first = run(f, { ...raw, dryRun: true }, { now: () => new Date('2026-10-11T12:00:00Z') });
  const second = run(f, { ...raw, dryRun: true }, { now: () => new Date('2026-10-11T12:10:00Z') });
  assert.equal(first.planHash, second.planHash);
  assert.notEqual(first.capture.capturedAt, second.capture.capturedAt);
  const originalCwd = process.cwd();
  try {
    process.chdir(f.temporary);
    const otherWorkspace = run(f, { ...raw, dryRun: true }, { now: () => new Date('2026-10-11T12:00:00Z') });
    assert.notEqual(otherWorkspace.planHash, first.planHash);
  } finally { process.chdir(originalCwd); }
  const changedDate = run(f, { ...raw, planHash: first.planHash }, { now: () => new Date('2026-10-12T00:00:00Z') });
  assert.equal(changedDate.error.code, 'PLAN_CHANGED');
  const written = run(f, { ...raw, planHash: first.planHash }, { now: () => new Date('2026-10-11T12:10:00Z') });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(written.capture.capturedAt, second.capture.capturedAt);
});
