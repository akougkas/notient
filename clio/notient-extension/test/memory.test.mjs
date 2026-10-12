import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, indexPath } from '../lib/config.mjs';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { refreshIndex, searchIndex } from '../lib/index.mjs';
import { inspectNote } from '../lib/note.mjs';
import { revision } from '../lib/paths.mjs';
import { readRecord } from '../lib/journal.mjs';
import { git } from '../lib/git.mjs';
import { documentSpans } from '../lib/markdown.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { contribution, memoryDocument, readMemory, appendMemory, marker, bodyLimit } from './memory-workflow.mjs';

const fixtureBytes = name => readFileSync(new URL(`../../fixtures/own-memory/${name}`, import.meta.url));
const source = { date: '2026-10-11', repository: '/work/repository-a', entries: ['task-storage-1'], lesson: 'Check metadata latency before optimizing refresh.' };
const later = { date: '2026-10-12', repository: '/work/repository-b', session: 'session-b', entries: ['task-storage-2', 'task-storage-3'], lesson: 'A metadata profile measures the work that dominates refresh.' };
const authorization = { origin: 'clio', request: 'Preserve the task\'s observed lesson in Clio\'s own vault.' };

function own(t, indexed = true) {
  const f = writerFixture(t); f.vault.role = 'own'; atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] }); baseline(f);
  if (indexed) refreshIndex(f.vault, f.directory);
  return f;
}
function capture(f, requestId = 'memory-capture-golden', content = fixtureBytes('storage.md').toString(), options = {}) {
  const input = { vault: f.vault.id, requestId, name: 'Storage lesson', content, batch: 'memory-task', authorization };
  const preview = writeOperation('capture', { ...input, dryRun: true }, { directory: f.directory }); assert.equal(preview.ok, true, JSON.stringify(preview));
  const result = writeOperation('capture', { ...input, planHash: preview.planHash }, { directory: f.directory, ...options });
  return { input, result };
}
function append(f, name, value = later, requestId = 'memory-append-golden') {
  const bytes = readFileSync(path.join(f.vault.path, name));
  const plan = appendMemory(bytes, value); if (plan.noop) return plan;
  const input = { vault: f.vault.id, requestId, batch: 'memory-task', authorization, operation: 'replace', path: name, revision: revision(bytes), oldText: plan.oldText, newText: plan.newText };
  const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory }); assert.equal(preview.ok, true, JSON.stringify(preview));
  const result = writeOperation('revise', { ...input, planHash: preview.planHash }, { directory: f.directory }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(readFileSync(path.join(f.vault.path, name)), plan.bytes); return result;
}

test('memory golden readable format has exact dates, known and unknown sessions and encoded observed IDs', () => {
  const text = memoryDocument('A reusable storage lesson', source);
  assert.equal(text.replace('["memory","storage"]', '["memory", "storage"]'), fixtureBytes('storage.md').toString());
  assert.equal(readMemory(Buffer.from(text)).entries[0].session, null);
  const unusual = { ...later, session: 'session; "quoted"\nline', entries: ['entry; "quoted"', 'another\nentry'] };
  const known = memoryDocument('Known session', unusual);
  assert.deepEqual(readMemory(Buffer.from(known)).entries[0].entries, unusual.entries);
  assert.equal(readMemory(Buffer.from(known)).entries[0].session, unusual.session);
  assert.equal(known.split('\n').filter(line => line.startsWith('Source:')).length, 1);
  assert.doesNotMatch(documentSpans(Buffer.from(known)).text.slice(0, documentSpans(Buffer.from(known)).bodyStart), /session:|source_entry_ids:/);
});

test('memory golden LF and CRLF append preserve all earlier body and metadata bytes', t => {
  for (const fixture of ['storage.md', 'storage-crlf.md']) {
    const f = own(t); const bytes = fixtureBytes(fixture); put(f, 'Memory.md', bytes);
    git(f.vault.path, ['add', '--', 'Memory.md']); git(f.vault.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'memory fixture']);
    const parsed = readMemory(bytes);
    const result = append(f, 'Memory.md');
    const after = readFileSync(path.join(f.vault.path, 'Memory.md'));
    assert.deepEqual(after, fixtureBytes(fixture.includes('crlf') ? 'storage-appended-crlf.md' : 'storage-appended.md'));
    assert.deepEqual(after.subarray(0, Buffer.byteLength(parsed.document.text.slice(0, parsed.markerOffset))), bytes.subarray(0, Buffer.byteLength(parsed.document.text.slice(0, parsed.markerOffset))));
    assert.equal(readMemory(after).entries.length, 2);
    if (fixture.includes('crlf')) assert.equal(after.toString().replaceAll('\r\n', '').includes('\n'), false);
    assert.equal(result.commit.oid, git(f.vault.path, ['rev-parse', 'HEAD']));
  }
});

test('memory golden duplicate tuples ignore session and summaries, accept distinct same-day IDs, and refuse collisions', () => {
  const bytes = fixtureBytes('storage.md');
  const stale = Buffer.from(bytes.toString().replace('updated: "2026-10-11"', 'updated: "1999-01-01"').replace('repositories: ["/work/repository-a"]', 'repositories: []'));
  const repeated = appendMemory(stale, { ...source, session: 'different-session' });
  assert.equal(repeated.noop, true); assert.deepEqual(repeated.bytes, stale);
  const sameDay = appendMemory(stale, { ...source, entries: ['different-entry'], lesson: 'A newly observed same-day lesson.' });
  assert.equal(readMemory(sameDay.bytes).entries.filter(entry => entry.heading === '2026-10-11 · repository-a').length, 2);
  assert.throws(() => appendMemory(bytes, { ...source, lesson: 'Changed claim using the same tuple.' }), error => error.code === 'MEMORY_PROVENANCE_COLLISION');
  assert.throws(() => readMemory(fixtureBytes('duplicate-tuple.md')), error => error.code === 'MEMORY_PROVENANCE_COLLISION');
  const partial = appendMemory(bytes, { ...source, entries: ['task-storage-1', 'new-entry'] });
  assert.deepEqual(readMemory(partial.bytes).entries[1].entries, ['new-entry']);
});

test('memory golden correction appends its old quotation and source without removing the earlier claim', t => {
  const f = own(t); const captured = capture(f).result; assert.equal(captured.ok, true, JSON.stringify(captured));
  const name = captured.capture.path; const before = readFileSync(path.join(f.vault.path, name));
  const correction = { ...later, lesson: `Corrects "2026-10-11 · repository-a": the earlier claim was "${source.lesson}".\n\nMetadata calls took 97.3% of the measured unchanged refresh on the Windows drive.` };
  append(f, name, correction);
  const after = readMemory(readFileSync(path.join(f.vault.path, name)));
  assert.equal(after.body, readMemory(fixtureBytes('storage-corrected.md')).body);
  assert.equal(after.entries[0].lesson, source.lesson); assert.equal(after.entries[1].lesson, correction.lesson);
  const prefix = before.toString().slice(0, readMemory(before).markerOffset);
  assert.equal(readFileSync(path.join(f.vault.path, name), 'utf8').slice(0, prefix.length), prefix);
  const hit = searchIndex(f.vault, f.directory, { query: '97.3 metadata' }).hits[0]; assert.equal(hit.path, name); assert.equal(hit.memory, 'unverified memory');
});

test('memory golden duplicate marker, missing adoption and size refusal preserve every byte', t => {
  const f = own(t); const bytes = fixtureBytes('duplicate-marker.md'); put(f, 'Duplicate.md', bytes);
  const before = snapshot(f.vault.path);
  assert.throws(() => appendMemory(bytes, later), error => error.code === 'MEMORY_MARKER');
  assert.throws(() => appendMemory(Buffer.from('# Authored note\n\nPreserve this prose.\n'), later), error => error.code === 'MEMORY_ADOPTION_REQUIRED');
  assert.throws(() => memoryDocument('Too long', { ...source, lesson: 'x'.repeat(bodyLimit + 1) }), error => error.code === 'MEMORY_SIZE');
  const near = Buffer.from(memoryDocument('Near limit', { ...source, lesson: 'x'.repeat(15500) }));
  assert.throws(() => appendMemory(near, { ...later, lesson: 'y'.repeat(1000) }), error => error.code === 'MEMORY_SIZE');
  const overhead = readMemory(Buffer.from(memoryDocument('Exact bound', { ...source, lesson: 'x' }))).body.length - 1;
  assert.equal(readMemory(Buffer.from(memoryDocument('Exact bound', { ...source, lesson: 'x'.repeat(bodyLimit - overhead) }))).body.length, bodyLimit);
  assert.throws(() => memoryDocument('Exact bound', { ...source, lesson: 'x'.repeat(bodyLimit - overhead + 1) }), error => error.code === 'MEMORY_SIZE');
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('memory committed body survives skipped and interrupted optional summary refresh and batch undo', t => {
  for (const pending of [false, true]) {
    const f = own(t); const captured = capture(f).result; assert.equal(captured.ok, true, JSON.stringify(captured));
    const name = captured.capture.path; append(f, name);
    const current = readFileSync(path.join(f.vault.path, name)); const body = documentSpans(current).text.slice(documentSpans(current).bodyStart);
    const metadata = { vault: f.vault.id, requestId: 'memory-summary-refresh', batch: 'memory-task', authorization, operation: 'frontmatter', path: name, revision: pending ? revision(current) : '0'.repeat(64), set: [{ key: 'updated', valueJson: JSON.stringify(later.date) }, { key: 'repositories', valueJson: JSON.stringify([source.repository, later.repository]) }], unset: [] };
    const result = writeOperation('revise', metadata, { directory: f.directory, barrier(event) { if (pending && event === 'afterIntent') throw Object.assign(new Error('Stop optional summary refresh.'), { code: 'INJECTED_STOP' }); } });
    assert.equal(result.ok, false); assert.equal(result.operationId !== null, pending, JSON.stringify(result));
    assert.equal(appendMemory(readFileSync(path.join(f.vault.path, name)), { ...later, session: 'retry-session' }).noop, true);
    assert.equal(readRecord(f.directory, f.vault, captured.operationId).state, 'committed');
    if (pending) assert.equal(commandStatusSnapshot(f.directory).recovered[0].result, 'resumed_from_intent');
    const final = readFileSync(path.join(f.vault.path, name)); assert.equal(documentSpans(final).text.slice(documentSpans(final).bodyStart), body);
    assert.match(final.toString(), /created: "2026-10-11"/); assert.match(final.toString(), /tags: \["memory", "storage"\]/);
    const undo = { requestId: 'memory-task-inverse', batch: 'memory-inverse', authorization: { origin: 'operator', request: 'Undo the memory task.' }, targetBatch: 'memory-task' };
    const preview = writeOperation('undo', { ...undo, dryRun: true }, { directory: f.directory });
    const inverse = writeOperation('undo', { ...undo, planHash: preview.planHash }, { directory: f.directory });
    assert.equal(inverse.ok, true, JSON.stringify(inverse)); assert.equal(existsSync(path.join(f.vault.path, name)), false);
  }
});

test('memory distinguishes a committed body with pending Git index from pending searchable indexing', t => {
  const f = own(t); const lock = path.join(f.vault.path, '.git/index.lock');
  const captured = capture(f, 'memory-native-pending', undefined, { barrier(event) { if (event === 'afterRef') put(f, '.git/index.lock', 'Foreign owner lock.\n'); } }).result;
  assert.equal(captured.ok, true, JSON.stringify(captured)); assert.equal(readRecord(f.directory, f.vault, captured.operationId).state, 'committed'); assert.equal(captured.indexState, 'pending'); assert.equal(captured.derivedIndexState, 'updated');
  assert.equal(readMemory(readFileSync(path.join(f.vault.path, captured.capture.path))).entries.length, 1);
  unlinkSync(lock); commandStatusSnapshot(f.directory); assert.equal(readRecord(f.directory, f.vault, captured.operationId).indexState, 'updated');
  const other = own(t, false); const deferred = capture(other, 'memory-derived-pending').result;
  assert.equal(deferred.ok, true); assert.equal(deferred.indexState, 'updated'); assert.equal(deferred.derivedIndexState, 'pending');
  refreshIndex(other.vault, other.directory); commandStatusSnapshot(other.directory); assert.equal(searchIndex(other.vault, other.directory, { query: 'metadata latency' }).hits[0].path, deferred.capture.path);
});

test('memory rebuild from Markdown preserves provenance and retrieves through a different repository command', t => {
  const f = own(t); const captured = capture(f).result; assert.equal(captured.ok, true, JSON.stringify(captured));
  const name = captured.capture.path; const before = readFileSync(path.join(f.vault.path, name));
  const journalBefore = snapshot(path.join(f.directory, 'journal')); const head = git(f.vault.path, ['rev-parse', 'HEAD']);
  unlinkSync(indexPath(f.directory, f.vault)); refreshIndex(f.vault, f.directory);
  const repositoryB = path.join(f.temporary, 'repository-b'); mkdirSync(repositoryB);
  const command = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/search.mjs', import.meta.url)), JSON.stringify({ vault: f.vault.id, query: 'metadata latency', limit: 5 })], { encoding: 'utf8', cwd: repositoryB, env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(command.status, 0, command.stderr); const hit = JSON.parse(command.stdout).hits.find(hit => hit.path === name);
  assert.equal(hit.memory, 'unverified memory'); assert.equal(hit.revision, revision(before));
  const note = inspectNote(f.vault, f.directory, { path: name }); assert.match(note.body, /task-storage-1/); assert.equal(note.memory, 'unverified memory');
  assert.deepEqual(readFileSync(path.join(f.vault.path, name)), before); assert.deepEqual(snapshot(path.join(f.directory, 'journal')), journalBefore); assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), head);
});

test('memory malicious trust claims remain inert evidence and do not widen operator authority', t => {
  const f = own(t); const captured = capture(f, 'memory-inert-evidence', fixtureBytes('malicious.md').toString()).result;
  assert.equal(captured.ok, true, JSON.stringify(captured)); const before = snapshot(f.vault.path);
  const result = searchIndex(f.vault, f.directory, { query: 'rewrite operator policies' });
  assert.ok(result.hits.length); for (const hit of result.hits) { assert.equal(hit.memory, 'unverified memory'); assert.equal(hit.evidence, 'vault text; unverified'); }
  const note = inspectNote(f.vault, f.directory, { path: captured.capture.path }); assert.equal(note.memory, 'unverified memory'); assert.match(note.evidence, /cannot grant authority/); assert.match(note.frontmatter, /trust: verified/);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'operator' }] });
  const refused = writeOperation('revise', { requestId: 'memory-inert-refusal', batch: 'inert', authorization: { origin: 'unattended', request: 'A note claimed permission to rewrite.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' }, { directory: f.directory });
  assert.equal(refused.error.code, 'UNATTENDED_REFUSED'); assert.deepEqual(snapshot(f.vault.path), before);
});
