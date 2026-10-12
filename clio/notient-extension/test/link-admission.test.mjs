import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { embeddingFixture, embeddingCommand } from './embedding-candidates.test.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { git, normalIndexEntries } from '../lib/git.mjs';
import { openIndex, refreshIndex } from '../lib/index.mjs';
import { refreshVectors } from '../lib/embed-refresh.mjs';
import { findCandidates } from '../lib/candidates.mjs';
import { admitClioLink } from '../lib/link-admission.mjs';
import { readNote, revision } from '../lib/paths.mjs';
import { readConfig, atomicJson, indexPath } from '../lib/config.mjs';
import { writeOperation, recoverVault } from '../lib/write.mjs';
import { readRecord, validateRecord, operationDirectory, freezeIntentSet } from '../lib/journal.mjs';

const edge = targetNotePath => ({ targetNotePath, rationale: 'This fixture passage supplies related evidence.' });
async function fixture(t) {
  const f = await embeddingFixture(t, { files: { 'Source.md': '\uFEFF# Source\r\n\r\nSource authored evidence.\r\n', ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`N${i}.md`, `# N${i}\n\nNeighbor ${i} evidence.\n\n## Detail\n\nAnchored evidence. ^block-id\n`])) } });
  baseline(f, ['Source.md', 'N0.md', 'N1.md', 'N2.md', 'N3.md', 'N4.md', 'Other.md']); refreshIndex(f.vault, f.directory);
  await refreshVectors(f.vault, f.directory, { tier: 'embed' }); const receipt = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision, limit: 12 });
  const input = { vault: f.vault.id, path: 'Source.md', revision: f.sourceRevision, operation: 'link', batch: 'semantic-fixture', requestId: 'semantic-write-001', authorization: { origin: 'clio', request: 'Append the related links supported by the served evidence.' }, link: { candidateSet: receipt.candidateSet, edges: [edge('N0.md')] } };
  return { ...f, receipt, input };
}

function modify(f, mutate) {
  const db = openIndex(f.directory, f.vault, true); const row = db.prepare('SELECT * FROM candidate_sets WHERE id=?').get(f.receipt.candidateSet); const payload = JSON.parse(row.payload_json); mutate(payload);
  db.prepare('UPDATE candidate_sets SET payload_json=?,vault=?,source=?,revision=?,space_id=?,index_generation=?,inventory_hash=?,created_at=?,expires_at=? WHERE id=?').run(JSON.stringify(payload), payload.vault, payload.source, payload.sourceRevision, payload.spaceId, payload.indexGeneration, payload.inventoryHash, payload.createdAt, payload.expiresAt, row.id); db.close();
}

const table = [
  ['G01 four admitted edges use the inherited ceilings', [0, 0, 0, 0], ['N0.md', 'N1.md', 'N2.md', 'N3.md'], [0.95, 0.85, 0.75, 0.65]],
  ['G02 five supplied edges refuse', [0, 0, 0, 0], ['N0.md', 'N1.md', 'N2.md', 'N3.md', 'N4.md'], 'INVALID_INPUT'],
  ['G03 duplicate dropped targets refuse before filtering', [0, 0, 0, 0], ['Absent.md', 'Absent.md'], 'DUPLICATE_TARGET'],
  ['G04 an absent edge promotes the next ceiling', [0, 0, 0, 0], ['Absent.md', 'N0.md', 'N1.md'], [0.95, 0.85]],
  ['G05 a nonpositive edge promotes the next ceiling', [1, 0, 0, 0], ['N0.md', 'N1.md', 'N2.md'], [0.95, 0.85]],
  ['G06 positive similarity clamps the ceiling', [0.8, 0.7, 0, 0], ['N0.md', 'N1.md', 'N2.md'], [0.19999999999999996, 0.30000000000000004, 0.75]],
  ['G07 zero similarity drops without admission', [1, 0, 0, 0], ['N0.md'], []],
  ['G08 negative similarity drops without admission', [2, 0, 0, 0], ['N0.md'], []],
  ['G09 a stored NaN distance refuses', [NaN, 0, 0, 0], ['N0.md'], 'CANDIDATE_STALE'],
  ['G10 a stored infinite distance refuses', [Infinity, 0, 0, 0], ['N0.md'], 'CANDIDATE_STALE'],
  ['G11 an out-of-range unselected stored distance refuses', [0, 0, 0, 3], ['N0.md'], 'CANDIDATE_STALE'],
];
for (const [name, distances, names, expected] of table) test(name, async t => {
  const f = await fixture(t); modify(f, payload => payload.targets.forEach((target, index) => { target.bestDistance = distances[index] ?? 0; }));
  const input = { ...f.input, link: { candidateSet: f.receipt.candidateSet, edges: names.map(edge) } }; const before = snapshot(f.temporary);
  if (typeof expected === 'string') assert.throws(() => admitClioLink(f.vault, f.directory, input), error => error.code === expected);
  else {
    const result = admitClioLink(f.vault, f.directory, input); assert.deepEqual(result.link.admitted.map(value => value.confidence), expected);
    assert.equal(result.link.admitted.every(value => value.basis === 'clio-candidate'), true); assert.equal(result.semanticEvidence.targets.length, names.filter(name => f.receipt.candidates.some(target => target.path === name)).length);
    if (name.startsWith('G04')) assert.equal(result.link.dropped[0].reason, 'not_retrieved');
    if (name.startsWith('G05') || name.startsWith('G07') || name.startsWith('G08')) assert.equal(result.link.dropped[0].reason, 'nonpositive_similarity');
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('G12 expired receipt refuses before any bytes change', async t => {
  const f = await fixture(t); modify(f, payload => { payload.createdAt = '2000-01-01T00:00:00.000Z'; payload.expiresAt = '2000-01-02T00:00:00.000Z'; });
  const before = snapshot(f.temporary); const result = writeOperation('revise', { ...f.input, dryRun: true }, { directory: f.directory }); assert.equal(result.error.code, 'CANDIDATE_STALE'); assert.deepEqual(snapshot(f.temporary), before);
});

test('G13 a changed source returns CANDIDATE_STALE', async t => {
  const f = await fixture(t); put(f, 'Source.md', 'Later source save.\n'); const before = snapshot(f.temporary);
  const source = writeOperation('revise', { ...f.input, dryRun: true }, { directory: f.directory }); assert.equal(source.error.code, 'CANDIDATE_STALE'); assert.deepEqual(snapshot(f.temporary), before);
});

test('G14 a changed selected target returns TARGET_CHANGED', async t => {
  const f = await fixture(t); put(f, 'N0.md', 'Later target save.\n'); const before = snapshot(f.temporary);
  const target = writeOperation('revise', { ...f.input, dryRun: true }, { directory: f.directory }); assert.equal(target.error.code, 'TARGET_CHANGED'); assert.deepEqual(snapshot(f.temporary), before);
});

test('unretrieved safe paths are dropped without a read but invalid qualifiers and canonical duplicates refuse first', async t => {
  const f = await fixture(t); const calls = [];
  const input = { ...f.input, link: { candidateSet: f.receipt.candidateSet, edges: [edge('Invented.md'), edge('N0.md')] } };
  const result = admitClioLink(f.vault, f.directory, input, { read: (root, name) => { calls.push(name); return readNote(root, name); } }); assert.equal(result.link.admitted[0].confidence, 0.95); assert.deepEqual(calls, ['Source.md', 'N0.md']);
  assert.throws(() => admitClioLink(f.vault, f.directory, { ...input, link: { ...input.link, edges: [{ ...edge('Invented.md'), heading: '# unsafe' }] } }), error => error.code === 'INVALID_QUALIFIER');
  assert.throws(() => admitClioLink(f.vault, f.directory, { ...input, link: { ...input.link, edges: [edge('invented.md'), edge('Invented.md')] } }), error => error.code === 'DUPLICATE_TARGET');
});

test('wrong vault source space, missing receipt and hash corruption all refuse; a generation increase alone remains valid', async t => {
  const f = await fixture(t); const first = admitClioLink(f.vault, f.directory, f.input); refreshIndex(f.vault, f.directory);
  assert.deepEqual(admitClioLink(f.vault, f.directory, f.input), first);
  for (const change of [payload => { payload.vault = 'wrong'; }, payload => { payload.source = 'N0.md'; }, payload => { payload.spaceId = 'a'.repeat(64); }, payload => { payload.textHashes[0].source = 'b'.repeat(64); }]) {
    const db = openIndex(f.directory, f.vault); const original = db.prepare('SELECT payload_json FROM candidate_sets').get().payload_json; db.close();
    modify(f, change); assert.throws(() => admitClioLink(f.vault, f.directory, f.input), error => error.code === 'CANDIDATE_STALE');
    modify(f, payload => Object.assign(payload, JSON.parse(original)));
  }
  const db = openIndex(f.directory, f.vault, true); db.exec('DELETE FROM candidate_sets'); db.close(); assert.throws(() => admitClioLink(f.vault, f.directory, f.input), error => error.code === 'CANDIDATE_STALE');
});

test('dropped-only live calls are byte-identical noops with no journal intent log or commit', async t => {
  const f = await fixture(t); const before = snapshot(f.temporary); const requests = f.stub.requests.length;
  const result = writeOperation('revise', { ...f.input, link: { candidateSet: f.receipt.candidateSet, edges: [edge('Invented.md')] } }, { directory: f.directory });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.outcome, 'noop'); assert.equal(result.commit, null); assert.equal(result.log, null); assert.equal(result.link.dropped[0].reason, 'not_retrieved'); assert.deepEqual(snapshot(f.temporary), before); assert.equal(f.stub.requests.length, requests);
});

test('a real Clio link preview freezes admission, preserves unrelated staging, commits exact CRLF bytes and undoes through tools', async t => {
  const f = await fixture(t); put(f, 'Other.md', 'Unrelated staged bytes.\n'); git(f.vault.path, ['add', '--', 'Other.md']); const staged = normalIndexEntries(f.vault.path).entries.get('Other.md').bytes; const original = readFileSync(path.join(f.vault.path, 'Source.md')); const requests = f.stub.requests.length;
  const previewBefore = snapshot(f.temporary); const preview = await embeddingCommand(f, 'revise', { ...f.input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); assert.equal(preview.value.link.admitted[0].confidence, 0.95); assert.deepEqual(snapshot(f.temporary), previewBefore);
  const published = await embeddingCommand(f, 'revise', { ...f.input, planHash: preview.value.planHash }); assert.equal(published.status, 0, JSON.stringify(published)); assert.equal(published.value.outcome, 'committed'); assert.equal(published.value.link.admitted[0].basis, 'clio-candidate');
  const after = readFileSync(path.join(f.vault.path, 'Source.md')); assert.deepEqual(after, Buffer.concat([original, Buffer.from('\r\n## Related\r\n\r\n- [[N0]]\r\n')])); assert.deepEqual(normalIndexEntries(f.vault.path).entries.get('Other.md').bytes, staged);
  assert.deepEqual(git(f.vault.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', published.value.commit.oid]).split('\n'), [published.value.log.path, 'Source.md'].sort());
  const record = readRecord(f.directory, f.vault, f.input.requestId); assert.equal(record.version, 2); assert.equal(record.semanticEvidence.candidateSet, f.receipt.candidateSet); assert.equal(record.semanticEvidence.targets[0].bestDistance, 0); validateRecord(record, f.vault);
  const inverse = { opId: f.input.requestId, batch: 'semantic-undo', authorization: { origin: 'operator', request: 'Undo the fixture link.' }, requestId: 'semantic-inverse-001' };
  const undoPreview = await embeddingCommand(f, 'undo', { ...inverse, dryRun: true }); assert.equal(undoPreview.status, 0, JSON.stringify(undoPreview)); const undone = await embeddingCommand(f, 'undo', { ...inverse, planHash: undoPreview.value.planHash }); assert.equal(undone.status, 0, JSON.stringify(undone)); assert.deepEqual(readFileSync(path.join(f.vault.path, 'Source.md')), original); assert.equal(f.stub.requests.length, requests);
});

test('idempotent published retry keeps frozen admission after receipt loss and semantic corruption is JOURNAL_CORRUPT', async t => {
  const f = await fixture(t); const result = writeOperation('revise', f.input, { directory: f.directory }); assert.equal(result.ok, true, JSON.stringify(result)); const requests = f.stub.requests.length;
  const db = openIndex(f.directory, f.vault, true); db.exec('DELETE FROM candidate_sets'); db.close();
  const retry = writeOperation('revise', f.input, { directory: f.directory }); assert.equal(retry.outcome, 'already_committed'); assert.deepEqual(retry.link, result.link); assert.equal(f.stub.requests.length, requests);
  const record = readRecord(f.directory, f.vault, f.input.requestId); record.semanticEvidence.targets[0].bestDistance = 0.5; writeFileSync(path.join(operationDirectory(f.directory, f.vault, f.input.requestId), 'record.json'), JSON.stringify(record));
  assert.throws(() => readRecord(f.directory, f.vault, f.input.requestId), error => error.code === 'JOURNAL_CORRUPT');
});

test('E11 mixed admission freezes the dropped retrieved evidence after receipt loss', async t => {
  const f = await fixture(t); modify(f, payload => { payload.targets.find(target => target.path === 'N0.md').bestDistance = 1.25; });
  const input = { ...f.input, link: { candidateSet: f.receipt.candidateSet, edges: [edge('N0.md'), edge('Invented.md'), edge('N1.md')] } };
  const result = await embeddingCommand(f, 'revise', input); assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.value.outcome, 'committed');
  const record = readRecord(f.directory, f.vault, input.requestId);
  assert.deepEqual(record.semanticEvidence.targets.map(target => [target.path, target.bestDistance]), [['N0.md', 1.25], ['N1.md', 0]]);
  for (const target of record.semanticEvidence.targets) {
    assert.equal(readNote(f.vault.path, target.path).text.includes(target.targetEvidence.passage), true);
    assert.equal(target.sourceEvidence.passage, record.semanticEvidence.targets[0].sourceEvidence.passage);
  }
  validateRecord(record, f.vault);
  const db = openIndex(f.directory, f.vault, true); db.exec('DELETE FROM candidate_sets'); db.close();
  const retry = await embeddingCommand(f, 'revise', input); assert.equal(retry.value.outcome, 'already_committed'); assert.deepEqual(retry.value.link, result.value.link);
  for (const mutate of [value => { value.semanticEvidence.targets.shift(); }, value => { value.semanticEvidence.targets[0].bestDistance = 0.5; }]) {
    const damaged = structuredClone(record); mutate(damaged); freezeIntentSet(damaged);
    assert.throws(() => validateRecord(damaged, f.vault), error => error.code === 'JOURNAL_CORRUPT');
  }
});

test('recovery uses frozen semantic evidence after durable intent despite expired receipts or an index rebuild', async t => {
  const f = await fixture(t); const original = readFileSync(path.join(f.vault.path, 'Source.md')); const requests = f.stub.requests.length;
  const interrupted = writeOperation('revise', f.input, { directory: f.directory, barrier: name => { if (name === 'afterIntent') throw new Error('fixture interruption'); } }); assert.equal(interrupted.ok, false); assert.equal(interrupted.state, 'intent'); assert.deepEqual(readFileSync(path.join(f.vault.path, 'Source.md')), original);
  unlinkSync(indexPath(f.directory, f.vault));
  for (const suffix of ['-wal', '-shm']) { try { unlinkSync(indexPath(f.directory, f.vault) + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  refreshIndex(f.vault, f.directory); const recovered = recoverVault(f.vault, f.directory); assert.equal(recovered.blocking.length, 0, JSON.stringify(recovered)); const record = readRecord(f.directory, f.vault, f.input.requestId); assert.equal(record.state, 'committed'); assert.equal(record.semanticEvidence.candidateSet, f.receipt.candidateSet); assert.match(readFileSync(path.join(f.vault.path, 'Source.md'), 'utf8'), /\[\[N0\]\]/); assert.equal(f.stub.requests.length, requests);
});

test('operator ignores a receipt and Clio relate has no semantic or numeric requirement', async t => {
  const f = await fixture(t); const requests = f.stub.requests.length;
  const operator = writeOperation('revise', { ...f.input, requestId: 'named-operator-001', dryRun: true, authorization: { origin: 'operator', request: 'Append this named note.' }, link: { candidateSet: '00000000-0000-0000-0000-000000000000', edges: [edge('N0.md')] } }, { directory: f.directory }); assert.equal(operator.ok, true, JSON.stringify(operator)); assert.equal(operator.link.admitted[0].confidence, null); assert.equal(operator.link.candidateSet, null);
  const config = readConfig(f.directory); config.vaults[0].embeddings = false; atomicJson(path.join(f.directory, 'config.json'), config);
  const { link, ...base } = f.input;
  const related = writeOperation('revise', { ...base, operation: 'relate', requestId: 'clio-relate-001', relate: { target: 'N0.md', relation: 'supports' } }, { directory: f.directory });
  assert.equal(related.ok, true, JSON.stringify(related)); assert.deepEqual(related.relate, { target: 'N0.md', relation: 'supports' }); assert.equal(readRecord(f.directory, f.vault, 'clio-relate-001').semanticEvidence, null); assert.equal(f.stub.requests.length, requests);
});

test('a structural preview hash cannot replace live admission and a valid second receipt preserves that hash', async t => {
  const f = await fixture(t); const operator = writeOperation('revise', { ...f.input, dryRun: true, authorization: { origin: 'operator', request: 'Append the named note.' } }, { directory: f.directory }); assert.equal(operator.ok, true, JSON.stringify(operator));
  const missing = writeOperation('revise', { ...f.input, planHash: operator.planHash, link: { edges: f.input.link.edges } }, { directory: f.directory }); assert.equal(missing.error.code, 'CANDIDATE_STALE');
  const second = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision });
  const otherPreview = writeOperation('revise', { ...f.input, dryRun: true, link: { ...f.input.link, candidateSet: second.candidateSet } }, { directory: f.directory }); assert.equal(otherPreview.ok, true, JSON.stringify(otherPreview)); assert.equal(otherPreview.planHash, operator.planHash);
  const applied = writeOperation('revise', { ...f.input, planHash: operator.planHash, link: { ...f.input.link, candidateSet: second.candidateSet } }, { directory: f.directory }); assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.link.candidateSet, second.candidateSet);
});

test('expiry after durable intent cannot strand a stamped partial publication', async t => {
  const f = await fixture(t); const requests = f.stub.requests.length;
  const interrupted = writeOperation('revise', f.input, { directory: f.directory, barrier: name => { if (name === 'afterPublish') throw new Error('partial fixture interruption'); } }); assert.equal(interrupted.ok, false, JSON.stringify(interrupted)); assert.equal(interrupted.partial, true); assert.match(readFileSync(path.join(f.vault.path, 'Source.md'), 'utf8'), /\[\[N0\]\]/);
  modify(f, payload => { payload.createdAt = '2000-01-01T00:00:00.000Z'; payload.expiresAt = '2000-01-02T00:00:00.000Z'; });
  const recovered = recoverVault(f.vault, f.directory); assert.equal(recovered.blocking.length, 0, JSON.stringify(recovered)); assert.equal(readRecord(f.directory, f.vault, f.input.requestId).state, 'committed'); assert.equal(f.stub.requests.length, requests);
});

test('an uncheckpointed index refuses pure planning without touching its SQL artifacts', async t => {
  const f = await fixture(t); const db = openIndex(f.directory, f.vault, true); db.prepare("INSERT OR REPLACE INTO meta VALUES ('fixtureUncheckpointed','1')").run(); const before = snapshot(f.temporary);
  assert.throws(() => admitClioLink(f.vault, f.directory, f.input), error => error.code === 'CANDIDATE_STALE'); assert.deepEqual(snapshot(f.temporary), before); db.close();
  assert.equal(admitClioLink(f.vault, f.directory, f.input).link.admitted.length, 1);
});
