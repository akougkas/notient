import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';
import { openIndex, refreshIndex, indexSummary, unknownCoverageMessage } from '../lib/index.mjs';
import { inspectNote } from '../lib/note.mjs';
import { readVitals } from '../lib/vitals-read.mjs';
import { indexPath, atomicJson } from '../lib/config.mjs';
import { writeOperation } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { git } from '../lib/git.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readRecord, saveRecord, freezeIntentSet, journalRoot } from '../lib/journal.mjs';

const now = Date.now();
const day = 86400000;
const at = () => now;
const age = (f, name, days) => utimesSync(path.join(f.vault.path, name), new Date(now - days * day), new Date(now - days * day));

function legacyRecord(f, id) {
  const record = readRecord(f.directory, f.vault, id); const prepared = record.intentSet.prepared; record.version = 1;
  for (const key of ['link', 'relate', 'semanticEvidence', 'vitalsBefore']) delete record[key];
  freezeIntentSet(record); record.intentSet.prepared = prepared; saveRecord(f.directory, f.vault, record);
  const intents = new DatabaseSync(path.join(journalRoot(f.directory, f.vault), 'intents.db'));
  intents.prepare('UPDATE intents SET manifest_hash=? WHERE operation_id=?').run(record.intentSet.manifestHash, record.id); intents.close();
}

for (const variant of ['restored path', 'moved restored path', 'unrelated path']) test(`V4 legacy edit-age rebuild verifies a contiguous path history for ${variant}`, t => {
  const f = writerFixture(t); baseline(f);
  const capturedAt = now - 14 * day;
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'legacy-age-capture', batch: 'age', authorization: { origin: 'operator', request: 'Capture the age fixture.' }, name: 'Contiguous age', content: 'Original stored prose.\n' }, { directory: f.directory, now: () => new Date(capturedAt) }); assert.equal(capture.ok, true, JSON.stringify(capture)); legacyRecord(f, capture.operationId);
  const name = capture.capture.path; const original = readFileSync(path.join(f.vault.path, name));
  const changedPath = variant === 'unrelated path' ? 'Other.md' : name;
  for (const [index, bytes] of [Buffer.from('Intervening operator bytes.\n'), variant === 'unrelated path' ? Buffer.from('Restored unrelated bytes.\n') : original].entries()) {
    put(f, changedPath, bytes); git(f.vault.path, ['add', '--', changedPath]); git(f.vault.path, ['-c', 'user.name=Operator', '-c', 'user.email=operator@localhost', 'commit', '-m', `operator intervening ${index}`]);
  }
  age(f, name, 3);
  const operation = variant.startsWith('moved') ? 'move' : 'replace';
  const input = { vault: f.vault.id, requestId: 'legacy-age-latest', batch: 'age', authorization: { origin: 'operator', request: 'Apply the final fixture change.' }, operation, path: name, revision: revision(original), ...(operation === 'move' ? { destination: 'Moved/Legacy.md' } : { oldText: 'Original', newText: 'Later' }) };
  if (operation === 'move') { const preview = writeOperation('revise', { ...input, dryRun: true }, { directory: f.directory }); assert.equal(preview.ok, true, JSON.stringify(preview)); input.planHash = preview.planHash; }
  const written = writeOperation('revise', input, { directory: f.directory }); assert.equal(written.ok, true, JSON.stringify(written)); legacyRecord(f, written.operationId);
  const pathName = operation === 'move' ? input.destination : name; const journal = snapshot(path.join(f.directory, 'journal'));
  refreshIndex(f.vault, f.directory, { now: at });
  const expected = variant === 'unrelated path' ? capturedAt : now;
  assert.equal(inspectNote(f.vault, f.directory, { path: pathName }, { now: at }).vitals.values.lastUserEditAt, new Date(expected).toISOString());
  assert.equal(indexSummary(f.vault, f.directory).editAgeFallbackPaths.includes(pathName), variant !== 'unrelated path');
  assert.deepEqual(snapshot(path.join(f.directory, 'journal')), journal);
});

test('vitals count unique directed wiki edges and typed frontmatter while ignoring embeds self Markdown and code', t => {
  const f = writerFixture(t);
  put(f, 'A.md', '# A\n\nAuthored alpha prose.\n\n- [[B]]\n- [[B|alias]]\n- [[B#Part]]\n- ![[C]]\n- [[Missing]]\n- [[A]]\n\n[Only markdown](D.md)\n\n    [[C]]\n\n> ```\n> [[C]]\n> ```\n\n%% [[C]] %%\n');
  put(f, 'B.md', '# B\n\n[[A]]\n'); put(f, 'C.md', '---\nnotient:\n  extends: ["[[A]]"]\n---\n# C\n'); put(f, 'D.md', '# D\n');
  refreshIndex(f.vault, f.directory, { now: at });
  const before = snapshot(f.directory); const vaultBefore = snapshot(f.vault.path);
  const response = readVitals(f.vault, f.directory, {}, { now: at }); assert.equal(response.coverage.state, 'current');
  const a = response.notes.find(note => note.path === 'A.md');
  assert.equal(a.vitals.outbound, 1); assert.equal(a.vitals.inbound, 2); assert.equal(a.vitals.edges, 3); assert.equal(a.vitals.connectivityTier, 'sparse');
  const c = inspectNote(f.vault, f.directory, { path: 'C.md' }, { now: at }).vitals;
  assert.equal(c.state, 'current'); assert.equal(c.values.words, 0); assert.equal(c.values.chunkCoverage, 0); assert.equal(c.values.hasEdges, 1);
  assert.deepEqual(snapshot(f.directory), before); assert.deepEqual(snapshot(f.vault.path), vaultBefore);
  const db = openIndex(f.directory, f.vault, true); db.exec('DROP TABLE chunks_fts'); db.close();
  assert.deepEqual(readVitals(f.vault, f.directory, {}, { now: at }).notes, response.notes);
  assert.deepEqual(inspectNote(f.vault, f.directory, { path: 'C.md' }, { now: at }).vitals, c);
});

test('missing structural vitals are unknown and reads never create an index or journal', t => {
  const f = writerFixture(t); put(f, 'One.md', '# One\n'); const before = snapshot(f.directory);
  const values = readVitals(f.vault, f.directory, {}, { now: at });
  assert.equal(values.coverage.state, 'unknown'); assert.equal(values.coverage.message, unknownCoverageMessage); assert.deepEqual(values.notes, []);
  assert.deepEqual(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals, { state: 'unknown', snapshotRevision: null, values: null, computedAt: new Date(now).toISOString() });
  assert.deepEqual(snapshot(f.directory), before);
});

test('vitals omit changed and deleted selected notes and note reports a stale snapshot without invented values', t => {
  const f = writerFixture(t); put(f, 'One.md', 'Original prose.\n'); put(f, 'Two.md', 'Another original note.\n'); refreshIndex(f.vault, f.directory, { now: at });
  const old = revision(readFileSync(path.join(f.vault.path, 'One.md'))); put(f, 'One.md', 'Later external bytes.\n'); unlinkSync(path.join(f.vault.path, 'Two.md'));
  const before = snapshot(f.directory);
  const values = readVitals(f.vault, f.directory, {}, { now: at }); assert.deepEqual(values.notes, []); assert.equal(values.remaining, 2); assert.equal(values.coverage.state, 'incomplete');
  const note = inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }); assert.equal(note.vitals.state, 'incomplete'); assert.equal(note.vitals.snapshotRevision, old); assert.equal(note.vitals.values, null);
  assert.deepEqual(snapshot(f.directory), before);
});

test('vitals filters are conjunctive component prefixes with deterministic health freshness and word sorts', t => {
  const f = writerFixture(t); put(f, 'Project/A.md', 'alpha beta\n'); put(f, 'Project/Z.md', 'alpha beta gamma\n'); put(f, 'Projects/Outside.md', 'outside\n');
  age(f, 'Project/A.md', 14); age(f, 'Project/Z.md', 1); refreshIndex(f.vault, f.directory, { now: at });
  assert.deepEqual(readVitals(f.vault, f.directory, { folder: 'Project', maturity: 'adolescent', connectivityTier: 'isolated', sort: 'health' }, { now: at }).notes.map(note => note.path), ['Project/A.md', 'Project/Z.md']);
  assert.equal(readVitals(f.vault, f.directory, { folder: 'Project', sort: 'freshness' }, { now: at }).notes[0].path, 'Project/A.md');
  const limited = readVitals(f.vault, f.directory, { folder: 'Project', sort: 'words', limit: 1 }, { now: at }); assert.equal(limited.notes[0].path, 'Project/Z.md'); assert.equal(limited.remaining, 1);
  assert.equal(readVitals(f.vault, f.directory, { folder: 'Project', maturity: 'raw' }, { now: at }).notes.length, 0);
  for (const folder of ['../Project', '/Project', 'Project//Nested', 'Project/']) assert.throws(() => readVitals(f.vault, f.directory, { folder }, { now: at }));
  assert.throws(() => readVitals(f.vault, f.directory, { limit: 101 }, { now: at }));
});

test('explicit refresh advances one rung and reads never promote or demote earned maturity after a rewrite', t => {
  const f = writerFixture(t); const prose = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  put(f, 'One.md', `${prose}\n`); age(f, 'One.md', 8); refreshIndex(f.vault, f.directory, { now: at });
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.maturity, 'adolescent');
  for (let i = 0; i < 10; i++) put(f, `N${i}.md`, i < 3 ? '[[One]]\n' : '# Neighbor\n');
  put(f, 'One.md', `${prose}\n\n${Array.from({ length: 10 }, (_, i) => `- [[N${i}]]`).join('\n')}\n`); age(f, 'One.md', 8);
  refreshIndex(f.vault, f.directory, { now: at });
  for (let i = 0; i < 3; i++) {
    assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.maturity, 'mature');
    assert.equal(readVitals(f.vault, f.directory, { maturity: 'synthesis-ready' }, { now: at }).notes.length, 0);
  }
  const unchanged = refreshIndex(f.vault, f.directory, { now: at }); assert.equal(unchanged.hashed, 0);
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.maturity, 'synthesis-ready');
  put(f, 'One.md', '# Rewritten without substantive prose\n'); refreshIndex(f.vault, f.directory, { now: at });
  const final = inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values;
  assert.equal(final.words, 0); assert.equal(final.maturity, 'synthesis-ready');
});

test('verified Notient repair preserves edit age and external edits use observed mtime', t => {
  const f = writerFixture(t); baseline(f); age(f, 'One.md', 14); refreshIndex(f.vault, f.directory, { now: at });
  const before = inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.lastUserEditAt;
  const input = { vault: f.vault.id, requestId: 'vitals-owned-edit', batch: 'vitals', authorization: { origin: 'operator', request: 'Replace the baseline.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' };
  const result = writeOperation('revise', input, { directory: f.directory }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.lastUserEditAt, before);
  put(f, 'One.md', 'An external rewrite.\n'); age(f, 'One.md', 1); refreshIndex(f.vault, f.directory, { now: at });
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.lastUserEditAt, new Date(now - day).toISOString());
});

test('index rebuild recovers verified capture lineage and never attributes an arbitrary older hash', t => {
  const f = writerFixture(t); baseline(f); refreshIndex(f.vault, f.directory, { now: at });
  const capturedAt = now - 4 * day;
  const capture = writeOperation('capture', { vault: f.vault.id, requestId: 'vitals-capture-lineage', batch: 'vitals', authorization: { origin: 'operator', request: 'Capture the fixture.' }, name: 'Age lineage', content: 'Canonical stored prose.\n' }, { directory: f.directory, now: () => new Date(capturedAt) });
  assert.equal(capture.ok, true, JSON.stringify(capture)); const name = capture.capture.path; const initial = readFileSync(path.join(f.vault.path, name));
  const replaced = writeOperation('revise', { vault: f.vault.id, requestId: 'vitals-replace-lineage', batch: 'vitals', authorization: { origin: 'operator', request: 'Revise the fixture.' }, operation: 'replace', path: name, revision: revision(initial), oldText: 'Canonical', newText: 'Later canonical' }, { directory: f.directory }); assert.equal(replaced.ok, true, JSON.stringify(replaced));
  const journal = snapshot(path.join(f.directory, 'journal')); unlinkSync(indexPath(f.directory, f.vault)); refreshIndex(f.vault, f.directory, { now: at });
  assert.equal(inspectNote(f.vault, f.directory, { path: name }, { now: at }).vitals.values.lastUserEditAt, new Date(capturedAt).toISOString());
  assert.deepEqual(snapshot(path.join(f.directory, 'journal')), journal);
  put(f, name, initial); age(f, name, 1); git(f.vault.path, ['add', '--', name]); git(f.vault.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'external restore']);
  unlinkSync(indexPath(f.directory, f.vault)); refreshIndex(f.vault, f.directory, { now: at });
  assert.equal(inspectNote(f.vault, f.directory, { path: name }, { now: at }).vitals.values.lastUserEditAt, new Date(now - day).toISOString());
  assert.equal(indexSummary(f.vault, f.directory).editAgeFallbackPaths.includes(name), false);
});

test('vitals command serves the frozen contract from a read-only registration without changing any bytes', t => {
  const f = writerFixture(t); f.vault.readOnly = true; atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [f.vault] }); put(f, 'One.md', 'Readable structural words.\n'); refreshIndex(f.vault, f.directory, { now: at });
  const before = snapshot(f.directory); const vaultBefore = snapshot(f.vault.path);
  const command = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/vitals.mjs', import.meta.url)), JSON.stringify({ vault: f.vault.id, sort: 'words', limit: 1 })], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(command.status, 0, command.stderr || command.stdout); const result = JSON.parse(command.stdout);
  assert.equal(result.tool, 'vitals'); assert.equal(result.ok, true); assert.equal(result.coverage.state, 'current'); assert.equal(result.notes[0].vitals.words, 3);
  assert.deepEqual(snapshot(f.directory), before); assert.deepEqual(snapshot(f.vault.path), vaultBefore);
});

test('legacy published writes with no retained before mtime use conservative edit-age fallback and expose it in status', t => {
  const f = writerFixture(t); baseline(f); age(f, 'One.md', 14);
  const input = { vault: f.vault.id, requestId: 'vitals-legacy-fallback', batch: 'vitals', authorization: { origin: 'operator', request: 'Replace the baseline.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' };
  const written = writeOperation('revise', input, { directory: f.directory }); assert.equal(written.ok, true, JSON.stringify(written));
  const legacy = readRecord(f.directory, f.vault, written.operationId);
  if (legacy.version !== 1) {
    const prepared = legacy.intentSet.prepared; legacy.version = 1;
    for (const key of ['link', 'relate', 'semanticEvidence', 'vitalsBefore']) delete legacy[key];
    freezeIntentSet(legacy); legacy.intentSet.prepared = prepared; saveRecord(f.directory, f.vault, legacy);
    const intents = new DatabaseSync(path.join(journalRoot(f.directory, f.vault), 'intents.db'));
    intents.prepare('UPDATE intents SET manifest_hash=? WHERE operation_id=?').run(legacy.intentSet.manifestHash, legacy.id); intents.close();
  }
  const before = snapshot(path.join(f.directory, 'journal'));
  refreshIndex(f.vault, f.directory, { now: at });
  assert.equal(inspectNote(f.vault, f.directory, { path: 'One.md' }, { now: at }).vitals.values.lastUserEditAt, new Date(now).toISOString());
  assert.ok(indexSummary(f.vault, f.directory).editAgeFallbackPaths.includes('One.md'));
  assert.deepEqual(snapshot(path.join(f.directory, 'journal')), before);
});

test('upgrading a cached graph backfills unchanged bytes before reporting complete vitals', t => {
  const f = writerFixture(t); put(f, 'Source.md', '---\nnotient: {supports: ["[[Target]]"]}\n---\nVisible prose.\n\n%% [[Hidden]] %%\n'); put(f, 'Target.md', '# Target\n'); put(f, 'Hidden.md', '# Hidden\n'); refreshIndex(f.vault, f.directory, { now: at });
  const db = openIndex(f.directory, f.vault, true);
  db.prepare("DELETE FROM meta WHERE key='graphRule'").run();
  db.prepare("DELETE FROM links WHERE path='Source.md'").run();
  db.prepare('INSERT INTO links(path,payload,target_path,resolution,candidates) VALUES (?,?,?,?,?)').run('Source.md', JSON.stringify({ kind: 'wiki', target: 'Hidden', embed: false }), 'Hidden.md', 'resolved', '["Hidden.md"]');
  db.close(); const before = snapshot(f.vault.path);
  assert.equal(readVitals(f.vault, f.directory, {}, { now: at }).coverage.state, 'incomplete');
  const refresh = refreshIndex(f.vault, f.directory, { now: at }); assert.equal(refresh.changed, 0); assert.equal(refresh.hashed, 3);
  const values = readVitals(f.vault, f.directory, {}, { now: at }); assert.equal(values.coverage.state, 'current');
  assert.equal(values.notes.find(note => note.path === 'Target.md').vitals.inbound, 1); assert.equal(values.notes.find(note => note.path === 'Hidden.md').vitals.inbound, 0);
  assert.deepEqual(snapshot(f.vault.path), before); assert.equal(refreshIndex(f.vault, f.directory, { now: at }).hashed, 0);
});
