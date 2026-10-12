import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, utimesSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { goldens } from './link-writeback.test.mjs';
import { writeOperation, recoverVault } from '../lib/write.mjs';
import { readRecord, saveRecord, freezeIntentSet, journalRoot, validateRecord } from '../lib/journal.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { revision } from '../lib/paths.mjs';
import { refreshIndex, openIndex } from '../lib/index.mjs';
import { inspectNote } from '../lib/note.mjs';
import { indexPath, atomicJson } from '../lib/config.mjs';
import { relations } from '../lib/relate.mjs';

const timestamp = Date.now();
const options = f => ({ directory: f.directory, now: () => new Date(timestamp) });
const authorization = { origin: 'operator', request: 'Apply this named relationship.' };
const edge = { targetNotePath: 'Target.md', rationale: 'The operator selected the live target.' };
const bytes = (f, name = 'Source.md') => readFileSync(path.join(f.vault.path, name));
function fixture(t, text) {
  const f = writerFixture(t); put(f, 'Source.md', text); put(f, 'Target.md', '# Target\n\n## Part\n\nLive block. ^block-id\n'); baseline(f, ['Source.md', 'Target.md', 'Other.md']);
  utimesSync(path.join(f.vault.path, 'Source.md'), new Date(timestamp - 14 * 86400000), new Date(timestamp - 14 * 86400000));
  refreshIndex(f.vault, f.directory, { now: () => timestamp }); return f;
}
function request(f, operation, id, extra = {}) {
  return { vault: f.vault.id, requestId: id, batch: 'relationships', authorization, operation, path: 'Source.md', revision: revision(bytes(f)), ...(operation === 'link' ? { link: { edges: [edge] } } : { relate: { target: 'Target.md', relation: 'supports' } }), ...extra };
}
function legacy(f, id) {
  const record = readRecord(f.directory, f.vault, id); const prepared = record.intentSet.prepared; record.version = 1;
  for (const key of ['link', 'relate', 'semanticEvidence', 'vitalsBefore']) delete record[key];
  freezeIntentSet(record); record.intentSet.prepared = prepared; saveRecord(f.directory, f.vault, record);
  const db = new DatabaseSync(path.join(journalRoot(f.directory, f.vault), 'intents.db'));
  db.prepare('UPDATE intents SET manifest_hash=? WHERE operation_id=?').run(record.intentSet.manifestHash, id); db.close(); return record;
}

for (const [ordinal, [name, before, expected]] of goldens.entries()) test(`coordinator ${name} preview publication retry noop and exact inverse`, t => {
  const f = fixture(t, before); const input = request(f, 'link', `link-golden-${ordinal.toString().padStart(3, '0')}`);
  put(f, 'Other.md', 'Unrelated staged content.\n'); git(f.vault.path, ['add', '--', 'Other.md']);
  const staged = normalIndexEntries(f.vault.path).entries.get('Other.md').bytes;
  const initialVault = snapshot(f.vault.path); const initialState = snapshot(f.directory);
  const preview = writeOperation('revise', { ...input, dryRun: true }, options(f)); assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(snapshot(f.vault.path), initialVault); assert.deepEqual(snapshot(f.directory), initialState);
  assert.equal(preview.link.admitted[0].basis, 'operator'); assert.equal(preview.relate, null);
  const written = writeOperation('revise', { ...input, planHash: preview.planHash }, options(f)); assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(bytes(f), Buffer.from(expected)); assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Other.md').bytes, staged);
  if (before === expected) { assert.equal(written.outcome, 'noop'); assert.equal(written.operationId, null); return; }
  const record = readRecord(f.directory, f.vault, written.operationId); assert.equal(record.version, 2); assert.equal(record.state, 'committed');
  assert.deepEqual(record.link, written.link); assert.equal(record.relate, null); assert.equal(record.semanticEvidence, null);
  assert.deepEqual(record.vitalsBefore, [{ path: 'Source.md', lastUserEditMs: timestamp - 14 * 86400000 }]);
  assert.equal(record.files.length, 2); assert.equal(bytes(f, record.log.path).toString().split('\n').filter(line => line.startsWith('- ')).length, 1);
  const retry = writeOperation('revise', input, options(f)); assert.equal(retry.outcome, 'already_committed'); assert.equal(retry.commit.oid, written.commit.oid); assert.deepEqual(retry.link, written.link);
  const head = git(f.vault.path, ['rev-parse', 'HEAD']); const after = snapshot(f.directory);
  const noop = writeOperation('revise', { ...input, requestId: `link-noop-${ordinal.toString().padStart(3, '0')}`, revision: revision(bytes(f)) }, options(f)); assert.equal(noop.outcome, 'noop'); assert.equal(git(f.vault.path, ['rev-parse', 'HEAD']), head); assert.deepEqual(snapshot(f.directory), after);
  const undo = writeOperation('undo', { vault: f.vault.id, requestId: `link-undo-${ordinal.toString().padStart(3, '0')}`, batch: 'undo-relationships', authorization, opId: written.operationId }, options(f)); assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.deepEqual(bytes(f), Buffer.from(before)); assert.equal(readRecord(f.directory, f.vault, written.operationId).undoneBy, undo.operationId);
});

test('new nonrelationship operations freeze version two metadata and legacy retries synthesize null results', t => {
  const f = fixture(t, 'Authored original prose.\n');
  const input = { vault: f.vault.id, requestId: 'version-two-replace', batch: 'relationships', authorization, operation: 'replace', path: 'Source.md', revision: revision(bytes(f)), oldText: 'original', newText: 'changed' };
  const written = writeOperation('revise', input, options(f)); assert.equal(written.ok, true, JSON.stringify(written));
  const record = readRecord(f.directory, f.vault, written.operationId); assert.equal(record.version, 2); assert.equal(record.link, null); assert.equal(record.relate, null); assert.equal(record.semanticEvidence, null);
  assert.deepEqual(record.vitalsBefore, [{ path: 'Source.md', lastUserEditMs: timestamp - 14 * 86400000 }]);
  legacy(f, record.id); const before = snapshot(path.join(f.directory, 'journal'));
  const retry = writeOperation('revise', input, options(f)); assert.equal(retry.outcome, 'already_committed'); assert.equal(retry.link, null); assert.equal(retry.relate, null);
  assert.deepEqual(snapshot(path.join(f.directory, 'journal')), before);
});

for (const [index, relation] of relations.entries()) test(`coordinator W${15 + index} ${relation} publishes exact YAML bytes and preserves edit age through inverse and rebuild`, t => {
  const before = `\uFEFF---\r\ntags: [keep]\r\nnotient:\r\n  ${relation}:\r\n    - "[[Earlier]]" # preserve\r\n  sibling: {count: 3}\r\n---\r\nAuthored body without terminal newline`;
  const f = fixture(t, before); const input = request(f, 'relate', `relate-golden-${index}`, { relate: { target: 'Target.md', relation } });
  const preview = writeOperation('revise', { ...input, dryRun: true }, options(f)); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.link, null); assert.deepEqual(preview.relate, input.relate);
  const written = writeOperation('revise', { ...input, planHash: preview.planHash }, options(f)); assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(bytes(f), Buffer.from(before.replace('    - "[[Earlier]]" # preserve\r\n', '    - "[[Earlier]]" # preserve\r\n    - "[[Target]]"\r\n')));
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Source.md' }).vitals.values.lastUserEditAt, new Date(timestamp - 14 * 86400000).toISOString());
  const db = openIndex(f.directory, f.vault); assert.equal(JSON.parse(db.prepare("SELECT payload FROM links WHERE path='Source.md' AND target_path='Target.md'").get().payload).relation, relation); db.close();
  assert.equal(writeOperation('revise', input, options(f)).commit.oid, written.commit.oid);
  assert.equal(writeOperation('revise', { ...input, requestId: `relate-noop-${index}`, revision: revision(bytes(f)) }, options(f)).outcome, 'noop');
  const inverse = writeOperation('undo', { vault: f.vault.id, requestId: `relate-undo-${index}`, batch: 'inverses', authorization, opId: written.operationId }, options(f)); assert.equal(inverse.ok, true, JSON.stringify(inverse)); assert.deepEqual(bytes(f), Buffer.from(before));
  unlinkSync(indexPath(f.directory, f.vault)); const journal = snapshot(path.join(f.directory, 'journal')); refreshIndex(f.vault, f.directory, { now: () => timestamp });
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Source.md' }).vitals.values.lastUserEditAt, new Date(timestamp - 14 * 86400000).toISOString()); assert.deepEqual(snapshot(path.join(f.directory, 'journal')), journal);
});

test('coordinator W20 relation alias noop and W21 wrong-type refusal preserve every state byte', t => {
  for (const [index, before] of ['---\nnotient: {supports: ["[[Target|alias]]"]}\n---\nBody.\n', '---\nnotient: {supports: [true]}\n---\nBody.\n'].entries()) {
    const f = fixture(t, before); const vault = snapshot(f.vault.path); const state = snapshot(f.directory);
    const result = writeOperation('revise', request(f, 'relate', `relate-closed-${index}`), options(f));
    if (index === 0) { assert.equal(result.ok, true); assert.equal(result.outcome, 'noop'); }
    else { assert.equal(result.ok, false); assert.equal(result.operationId, null); }
    assert.deepEqual(snapshot(f.vault.path), vault); assert.deepEqual(snapshot(f.directory), state);
  }
});

test('relationship dependencies and structural hashes bind target bytes and inventory while attribution stays outside', t => {
  const f = fixture(t, 'Body.\n'); const input = request(f, 'link', 'relationship-hash-one');
  const preview = writeOperation('revise', { ...input, dryRun: true }, options(f)); assert.equal(preview.ok, true, JSON.stringify(preview));
  const attributed = writeOperation('revise', { ...input, requestId: 'relationship-hash-two', batch: 'changed-attribution', authorization: { origin: 'operator', request: 'A different exact request.' }, link: { edges: [{ ...edge, rationale: 'A different rationale.' }], candidateSet: '00000000-0000-0000-0000-000000000000' }, dryRun: true }, options(f));
  assert.equal(attributed.planHash, preview.planHash); assert.equal(attributed.link.candidateSet, null);
  put(f, 'New.md', 'A new inventory member.\n'); const changed = writeOperation('revise', { ...input, planHash: preview.planHash }, options(f)); assert.equal(changed.error.code, 'PLAN_CHANGED'); assert.equal(changed.operationId, null);
  unlinkSync(path.join(f.vault.path, 'New.md'));
  const partial = writeOperation('revise', input, { ...options(f), barrier(name) { if (name === 'afterIntent') { put(f, 'Target.md', 'A later target save.\n'); } } });
  assert.equal(partial.ok, false); assert.equal(partial.error.code, 'DEPENDENCY_CHANGED'); assert.deepEqual(bytes(f), Buffer.from('Body.\n'));
  const aborted = readRecord(f.directory, f.vault, partial.operationId); assert.equal(aborted.state, 'aborted'); assert.equal(aborted.error.code, 'DEPENDENCY_CHANGED');
});

test('relationship recovery completes stamped partial publication after an index rebuild and preserves a later published save', t => {
  const f = fixture(t, 'Preserved authored prose.\n'); const input = request(f, 'link', 'relationship-recovery');
  const failed = writeOperation('revise', input, { ...options(f), barrier(name) { if (name === 'afterPublish') throw new Error('fixture interruption'); } }); assert.equal(failed.ok, false);
  assert.match(bytes(f).toString(), /- \[\[Target\]\]/); const pending = readRecord(f.directory, f.vault, failed.operationId); assert.equal(pending.version, 2);
  unlinkSync(indexPath(f.directory, f.vault)); refreshIndex(f.vault, f.directory, { now: () => timestamp });
  const recovered = recoverVault(f.vault, f.directory); assert.equal(recovered.remaining.length, 0, JSON.stringify(recovered));
  const committed = readRecord(f.directory, f.vault, failed.operationId); assert.equal(committed.state, 'committed'); assert.equal(committed.git.indexInstalled, true);
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Source.md' }).vitals.values.lastUserEditAt, new Date(timestamp - 14 * 86400000).toISOString());
  const next = writeOperation('revise', request(f, 'relate', 'relation-later-save'), { ...options(f), barrier(name) { if (name === 'afterRef') { put(f, 'Source.md', 'A later operator save.\n'); throw new Error('fixture interruption after ref'); } } }); assert.equal(next.ok, false); assert.ok(next.commit);
  const repaired = recoverVault(f.vault, f.directory); assert.equal(readRecord(f.directory, f.vault, next.operationId).state, 'committed'); assert.deepEqual(bytes(f), Buffer.from('A later operator save.\n')); assert.equal(repaired.results[0].commit, next.commit);
});

test('version two rejects altered admission ages ranges and unknown versions before any recovery publication', t => {
  const f = fixture(t, 'Body.\n'); const result = writeOperation('revise', request(f, 'link', 'frozen-corruption'), options(f)); assert.equal(result.ok, true, JSON.stringify(result));
  const record = readRecord(f.directory, f.vault, result.operationId); const vault = snapshot(f.vault.path); const state = snapshot(f.directory);
  for (const change of [value => { value.link.admitted[0].rationale = 'Altered evidence'; }, value => { value.vitalsBefore[0].lastUserEditMs++; }, value => { value.files[0].splices[0].startByte++; }, value => { delete value.semanticEvidence; }, value => { value.version = 99; }]) {
    const altered = structuredClone(record); change(altered); assert.throws(() => validateRecord(altered, f.vault), error => error.code === 'JOURNAL_CORRUPT');
  }
  assert.deepEqual(snapshot(f.vault.path), vault); assert.deepEqual(snapshot(f.directory), state);
});

test('mixed version originals batch undo through one exact inverse including link and relate', t => {
  const f = fixture(t, 'Original authored prose.\n'); const original = bytes(f);
  const replaced = writeOperation('revise', { vault: f.vault.id, requestId: 'mixed-legacy-replace', batch: 'relationships', authorization, operation: 'replace', path: 'Source.md', revision: revision(bytes(f)), oldText: 'Original', newText: 'Changed' }, options(f)); assert.equal(replaced.ok, true); legacy(f, replaced.operationId);
  const linked = writeOperation('revise', request(f, 'link', 'mixed-new-link'), options(f)); assert.equal(linked.ok, true, JSON.stringify(linked));
  const related = writeOperation('revise', request(f, 'relate', 'mixed-new-relate'), options(f)); assert.equal(related.ok, true, JSON.stringify(related));
  const inverse = { vault: f.vault.id, requestId: 'mixed-batch-inverse', batch: 'inverses', authorization, targetBatch: 'relationships' };
  const preview = writeOperation('undo', { ...inverse, dryRun: true }, options(f)); assert.equal(preview.ok, true, JSON.stringify(preview));
  const undone = writeOperation('undo', { ...inverse, planHash: preview.planHash }, options(f)); assert.equal(undone.ok, true, JSON.stringify(undone)); assert.deepEqual(bytes(f), original);
  for (const id of [replaced.operationId, linked.operationId, related.operationId]) assert.equal(readRecord(f.directory, f.vault, id).undoneBy, undone.operationId);
  assert.equal(readRecord(f.directory, f.vault, replaced.operationId).version, 1);
});

test('legacy pending recovery stays version one and own authority relaxes only unattended location', t => {
  const f = fixture(t, 'Original body.\n');
  const failed = writeOperation('revise', { vault: f.vault.id, requestId: 'legacy-pending-one', batch: 'legacy', authorization, operation: 'replace', path: 'Source.md', revision: revision(bytes(f)), oldText: 'Original', newText: 'Changed' }, { ...options(f), barrier(name) { if (name === 'afterIntent') throw new Error('fixture legacy pending'); } }); assert.equal(failed.ok, false); legacy(f, failed.operationId);
  assert.equal(recoverVault(f.vault, f.directory).remaining.length, 0); assert.equal(readRecord(f.directory, f.vault, failed.operationId).version, 1);
  const input = request(f, 'link', 'unattended-boundary', { authorization: { origin: 'unattended', request: 'Add the named relationship.' } });
  assert.equal(writeOperation('revise', input, options(f)).error.code, 'UNATTENDED_REFUSED');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own' }] });
  const own = writeOperation('revise', input, options(f)); assert.equal(own.ok, true, JSON.stringify(own)); assert.equal(own.link.admitted[0].basis, 'unattended');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own', readOnly: true }] });
  assert.equal(writeOperation('revise', request(f, 'relate', 'readonly-relation'), options(f)).error.code, 'READ_ONLY_VAULT');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] });
  assert.equal(writeOperation('revise', request(f, 'link', 'clio-admission-off', { authorization: { origin: 'clio', request: 'Add the relationship.' } }), options(f)).error.code, 'EMBEDDING_OFF');
});

test('capture frontmatter move replace and aggregate inverse freeze edit ages for every changed note', t => {
  const f = fixture(t, 'Original authored prose.\n');
  const captured = writeOperation('capture', { vault: f.vault.id, requestId: 'v2-provenance-capture', batch: 'captures', authorization, name: 'Fixture capture', content: 'Captured evidence.\n' }, options(f)); assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(readRecord(f.directory, f.vault, captured.operationId).vitalsBefore, [{ path: captured.capture.path, lastUserEditMs: null }]);
  assert.equal(inspectNote(f.vault, f.directory, { path: captured.capture.path }).vitals.values.lastUserEditAt, new Date(timestamp).toISOString());
  const move = { vault: f.vault.id, requestId: 'v2-provenance-move', batch: 'v2-history', authorization, operation: 'move', path: 'Source.md', revision: revision(bytes(f)), destination: 'Folder/Moved.md' };
  const preview = writeOperation('revise', { ...move, dryRun: true }, options(f)); assert.equal(preview.ok, true, JSON.stringify(preview));
  const moved = writeOperation('revise', { ...move, planHash: preview.planHash }, options(f)); assert.equal(moved.ok, true, JSON.stringify(moved));
  const replaced = writeOperation('revise', { vault: f.vault.id, requestId: 'v2-provenance-replace', batch: 'v2-history', authorization, operation: 'replace', path: 'Folder/Moved.md', revision: revision(bytes(f, 'Folder/Moved.md')), oldText: 'Original', newText: 'Changed' }, options(f)); assert.equal(replaced.ok, true, JSON.stringify(replaced));
  const metadata = writeOperation('revise', { vault: f.vault.id, requestId: 'v2-provenance-frontmatter', batch: 'v2-history', authorization, operation: 'frontmatter', path: 'Folder/Moved.md', revision: revision(bytes(f, 'Folder/Moved.md')), set: [{ key: 'tags', valueJson: '["preserved"]' }] }, options(f)); assert.equal(metadata.ok, true, JSON.stringify(metadata));
  for (const operation of [moved, replaced, metadata]) {
    const record = readRecord(f.directory, f.vault, operation.operationId); assert.equal(record.version, 2);
    assert.equal(record.vitalsBefore.length, record.files.filter(file => file.role === 'note').length);
    assert.ok(record.vitalsBefore.every(value => value.lastUserEditMs === timestamp - 14 * 86400000));
  }
  const undo = { vault: f.vault.id, requestId: 'v2-provenance-undo', batch: 'inverses', authorization, targetBatch: 'v2-history' };
  const undoPreview = writeOperation('undo', { ...undo, dryRun: true }, options(f)); assert.equal(undoPreview.ok, true, JSON.stringify(undoPreview));
  const inverse = writeOperation('undo', { ...undo, planHash: undoPreview.planHash }, options(f)); assert.equal(inverse.ok, true, JSON.stringify(inverse));
  assert.deepEqual(bytes(f), Buffer.from('Original authored prose.\n'));
  const values = inspectNote(f.vault, f.directory, { path: 'Source.md' }).vitals.values;
  assert.equal(values.lastUserEditAt, new Date(timestamp - 14 * 86400000).toISOString()); assert.equal(values.maturity, 'adolescent');
  unlinkSync(indexPath(f.directory, f.vault)); refreshIndex(f.vault, f.directory, { now: () => timestamp });
  assert.equal(inspectNote(f.vault, f.directory, { path: 'Source.md' }).vitals.values.lastUserEditAt, values.lastUserEditAt);
});
