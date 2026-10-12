import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, appendFileSync, truncateSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { atomicJson, readConfig, indexPath } from '../lib/config.mjs';
import { normalizeEmbeddings, embeddingSpace } from '../lib/embedding-config.mjs';
import { refreshIndex, openIndex, searchIndex, repairCommittedIndex } from '../lib/index.mjs';
import { quantizeVector, reconstructedVector, cosine, unitVector } from '../lib/vector-math.mjs';
import { vectorState, vectorChunks, publishVectors, openVectorSnapshot, rebuildVectorGeneration, markVectorFailure } from '../lib/vector-store.mjs';
import { withIndexWriter } from '../lib/index-lock.mjs';
import { retainedPackBytes } from '../lib/embedding-off.mjs';
import { statusSnapshot } from '../lib/status.mjs';
import { embeddingStub, setupCommand } from './embedding-helpers.mjs';

function fixture(t, extra = {}) {
  const f = writerFixture(t);
  f.profile = normalizeEmbeddings({ baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', responseModel: 'fixture-pinned', dimension: 3, maxInputBytes: 1600, ...extra });
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, embeddings: f.profile, vaults: [{ ...f.vault, embeddings: true }] });
  put(f, 'A.md', '# A\n\nAuthored alpha evidence.\n'); put(f, 'B.md', '# B\n\nAuthored beta evidence.\n');
  refreshIndex(f.vault, f.directory); return f;
}

function chunks(f) {
  const db = openIndex(f.directory, f.vault);
  try { return [...vectorChunks(db, f.profile)].filter(chunk => chunk.eligible); }
  finally { db.close(); }
}

function publishAll(f) { const selected = chunks(f); return publishVectors(f.vault, f.directory, f.profile, selected, selected.map((_, i) => Array.from({ length: f.profile.dimension }, (_, index) => [1, i + 1, -1][index % 3]))); }

function pack(f) {
  const db = openIndex(f.directory, f.vault);
  try { const space = db.prepare('SELECT * FROM vector_spaces WHERE space_id=?').get(embeddingSpace(f.profile)); return { ...space, filename: path.join(path.dirname(indexPath(f.directory, f.vault)), space.pack_file) }; }
  finally { db.close(); }
}

test('int8 vectors normalize finite extremes and use reconstructed norms for bounded cosine', () => {
  for (const vector of [[3, 4, 0], [-3, 4, 1], [1e308, -1e308, 1e307], [Number.MIN_VALUE, 0, 0]]) {
    const packed = quantizeVector(vector); const rebuilt = reconstructedVector(packed.bytes, packed.scale);
    assert.equal(packed.bytes.length, vector.length); assert.ok(packed.scale > 0);
    assert.ok(Math.abs(Math.hypot(...unitVector(vector)) - 1) < 1e-14);
    assert.ok(cosine(vector, rebuilt) > 0.99998); assert.ok(Math.abs(cosine(rebuilt, rebuilt) - 1) < 1e-14);
    assert.ok(cosine(rebuilt, Float64Array.from(rebuilt, value => -value)) < -0.999999999);
  }
  for (const bad of [[0, 0], [Infinity, 1], [NaN, 1], [1]]) assert.throws(() => quantizeVector(bad, 2), error => error.code === 'VECTOR_INVALID');
  assert.throws(() => reconstructedVector(Buffer.alloc(2), 1), error => error.code === 'VECTOR_INVALID');
  assert.throws(() => reconstructedVector(Buffer.from([1]), Infinity), error => error.code === 'VECTOR_INVALID');
});

test('pack publication exposes only fsynced committed slots and records private WAL state without vault effects', t => {
  const f = fixture(t); const before = snapshot(f.vault.path); const selected = chunks(f);
  assert.deepEqual(publishVectors(f.vault, f.directory, f.profile, selected.slice(0, 1), [[1, 0, 0]]), { published: 1, discarded: 0, warnings: [] });
  assert.equal(vectorState(f.vault, f.directory).state, 'building');
  publishVectors(f.vault, f.directory, f.profile, selected.slice(1), [[0, 1, 0]]);
  const state = vectorState(f.vault, f.directory); assert.equal(state.state, 'ready'); assert.equal(state.eligible, 2); assert.equal(state.embedded, 2); assert.equal(state.missing, 0);
  const row = pack(f); assert.equal(statSync(row.filename).size, 6); assert.equal(statSync(row.filename).mode & 0o777, 0o600); assert.equal(statSync(row.filename).nlink, 1);
  const db = openIndex(f.directory, f.vault); assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); db.close();
  assert.equal(statusSnapshot(f.directory).vaults[0].embedding.state, 'ready'); assert.equal(retainedPackBytes(f.directory, f.vault), 6);
  const reader = openVectorSnapshot(f.vault, f.directory, f.profile);
  try { for (const chunk of reader.chunks()) assert.ok(Number.isFinite(cosine(reader.vector(reader.metadata(chunk)), [1, 0, 0]))); }
  finally { reader.close(); reader.close(); }
  assert.deepEqual(snapshot(f.vault.path), before);
});

for (const operation of ['publish', 'rebuild']) for (const barrier of ['afterAppend', 'afterFsync', 'afterSQLCommit']) test(`pack process death ${operation} ${barrier} leaves a bounded recoverable prefix`, t => {
  const f = fixture(t); publishAll(f); const before = pack(f); const oldBytes = readFileSync(before.filename); const vaultBefore = snapshot(f.vault.path);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./vector-crash.mjs', import.meta.url)), operation, barrier, f.directory, f.vault.id], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const after = pack(f);
  if (operation === 'publish') {
    assert.equal(after.pack_slots, barrier === 'afterSQLCommit' ? 3 : 2); assert.equal(statSync(after.filename).size, 9);
    assert.deepEqual(readFileSync(after.filename).subarray(0, 6), oldBytes);
  } else {
    assert.equal(after.generation, barrier === 'afterSQLCommit' ? before.generation + 1 : before.generation);
    assert.equal(after.pack_slots, 2); assert.deepEqual(readFileSync(before.filename), oldBytes);
  }
  const reader = openVectorSnapshot(f.vault, f.directory, f.profile);
  try { for (const chunk of reader.chunks()) assert.ok(reader.vector(reader.metadata(chunk)).some(value => value !== 0));
    assert.throws(() => reader.vector({ ...reader.metadata([...reader.chunks()][0]), slot: after.pack_slots }), error => error.code === 'VECTOR_PACK_INVALID'); }
  finally { reader.close(); }
  if (operation === 'publish' && barrier !== 'afterSQLCommit') { const selected = chunks(f).slice(0, 1); publishVectors(f.vault, f.directory, f.profile, selected, [[0, 0, 1]]); assert.equal(pack(f).pack_slots, 3); assert.equal(statSync(pack(f).filename).size, 9); }
  else if (operation === 'rebuild' && barrier !== 'afterSQLCommit') { const rebuilt = rebuildVectorGeneration(f.vault, f.directory, f.profile); assert.equal(rebuilt.generation, before.generation + 2); }
  assert.deepEqual(snapshot(f.vault.path), vaultBefore);
});

test('a live reader retains its exact generation while rebuilding reuses packed bytes and scales without links or pruning', t => {
  const f = fixture(t); publishAll(f); const old = pack(f); const reader = openVectorSnapshot(f.vault, f.directory, f.profile);
  const prior = [...reader.chunks()].map(chunk => ({ metadata: reader.metadata(chunk), bytes: reader.packed(reader.metadata(chunk)), vector: reader.vector(reader.metadata(chunk)) }));
  const rebuilt = rebuildVectorGeneration(f.vault, f.directory, f.profile);
  assert.deepEqual(rebuilt, { generation: old.generation + 1, slots: 2, reused: 2, warnings: [] });
  assert.equal(reader.space.generation, old.generation);
  const next = openVectorSnapshot(f.vault, f.directory, f.profile);
  try { [...next.chunks()].forEach((chunk, index) => { const metadata = next.metadata(chunk); assert.equal(metadata.scale, prior[index].metadata.scale); assert.deepEqual(next.packed(metadata), prior[index].bytes); assert.deepEqual(reader.vector(prior[index].metadata), prior[index].vector); }); }
  finally { next.close(); reader.close(); }
  assert.equal(retainedPackBytes(f.directory, f.vault), 12);
  assert.equal(readdirSync(path.dirname(old.filename)).filter(name => name.endsWith('.i8')).length, 2);
});

test('pack readers ignore crash tails, refuse corruption, and leave structural evidence and journal state usable', t => {
  const f = fixture(t); publishAll(f); const row = pack(f); appendFileSync(row.filename, Buffer.from([127, 127, 127]));
  let reader = openVectorSnapshot(f.vault, f.directory, f.profile);
  assert.equal(reader.space.pack_slots, 2); reader.close();
  truncateSync(row.filename, 5); assert.equal(vectorState(f.vault, f.directory).state, 'unavailable');
  assert.throws(() => openVectorSnapshot(f.vault, f.directory, f.profile), error => error.code === 'VECTOR_PACK_INVALID');
  assert.equal(searchIndex(f.vault, f.directory, { query: 'alpha' }).hits[0].path, 'A.md');
  assert.equal(statusSnapshot(f.directory).vaults[0].journal.pending.length, 0);
});

test('metadata identity and chunk-id reuse cannot adopt vectors from another revision or text', t => {
  const f = fixture(t); publishAll(f); const row = pack(f); const selected = chunks(f);
  const db = openIndex(f.directory, f.vault, true);
  db.prepare('UPDATE vec_meta SET text_hash=? WHERE chunk_id=?').run('0'.repeat(64), selected[0].id); db.close();
  assert.equal(vectorState(f.vault, f.directory).missing, 1);
  put(f, 'A.md', '# A\n\nChanged human evidence.\n'); refreshIndex(f.vault, f.directory);
  assert.equal(vectorState(f.vault, f.directory).state, 'incomplete'); assert.equal(vectorState(f.vault, f.directory).missing, 1);
  assert.deepEqual(publishVectors(f.vault, f.directory, f.profile, selected.slice(0, 1), [[1, 0, 0]]), { published: 0, discarded: 1, warnings: [] });
  publishAll(f); assert.ok(pack(f).pack_slots > row.pack_slots); assert.equal(vectorState(f.vault, f.directory).state, 'ready');
});

test('every space identity change disables the prior pack until the complete new space is published', t => {
  const f = fixture(t); publishAll(f); const original = f.profile; const before = pack(f);
  for (const extra of [{ model: 'new-model' }, { responseModel: 'new-pinned' }, { dimension: 4 }, { baseUrl: 'http://127.0.0.1:2/v1' }, { documentPrefix: 'doc: ' }, { queryPrefix: 'query: ' }, { spaceVersion: '2' }, { maxInputBytes: 1200 }]) {
    const config = readConfig(f.directory); config.embeddings = normalizeEmbeddings({ ...original, ...extra }); atomicJson(path.join(f.directory, 'config.json'), config);
    assert.equal(vectorState(f.vault, f.directory).state, 'stale-model');
    assert.throws(() => openVectorSnapshot(f.vault, f.directory, config.embeddings), error => error.code === 'VECTOR_PACK_UNAVAILABLE');
  }
  f.profile = normalizeEmbeddings({ ...original, model: 'new-model' }); const config = readConfig(f.directory); config.embeddings = f.profile; atomicJson(path.join(f.directory, 'config.json'), config);
  const selected = chunks(f); publishVectors(f.vault, f.directory, f.profile, selected.slice(0, 1), [[1, 0, 0]]);
  assert.equal(vectorState(f.vault, f.directory).state, 'building');
  publishVectors(f.vault, f.directory, f.profile, selected.slice(1), [[0, 1, 0]]); assert.equal(vectorState(f.vault, f.directory).state, 'ready');
  assert.equal(statSync(before.filename).size, 6);
});

test('oversized chunks remain explicit coverage gaps and directory fsync limitations are warnings', t => {
  const f = fixture(t, { maxInputBytes: 64 }); put(f, 'Oversize.md', 'large '.repeat(100)); refreshIndex(f.vault, f.directory);
  const selected = chunks(f); const result = publishVectors(f.vault, f.directory, f.profile, selected, selected.map(() => [1, 0, 0]), { sync: () => false });
  assert.equal(result.warnings[0].code, 'DIRECTORY_FSYNC_UNAVAILABLE');
  const state = vectorState(f.vault, f.directory); assert.equal(state.skipped, 1); assert.equal(state.missing, 0); assert.equal(state.state, 'incomplete');
  assert.throws(() => rebuildVectorGeneration(f.vault, f.directory, f.profile, { deadline: 0 }), error => error.code === 'VECTOR_REBUILD_TIMEOUT');
  assert.equal(vectorState(f.vault, f.directory).state, 'incomplete');
});

test('shared index exclusion refuses asynchronous publication and competing structural writers within five seconds', t => {
  const f = fixture(t);
  assert.throws(() => withIndexWriter(f.vault, f.directory, () => Promise.resolve()), error => error.code === 'INDEX_LOCK_SCOPE');
  const started = performance.now();
  withIndexWriter(f.vault, f.directory, () => assert.throws(() => refreshIndex(f.vault, f.directory), error => error.code === 'INDEX_BUSY'));
  assert.ok(performance.now() - started >= 4900); assert.ok(performance.now() - started < 6500);
  assert.equal(refreshIndex(f.vault, f.directory).unchanged, 2);
  withIndexWriter(f.vault, f.directory, () => assert.throws(() => repairCommittedIndex(f.vault, f.directory, { files: [] }), error => error.code === 'INDEX_BUSY'));
});

test('empty eligible corpora have a durable empty generation and semantic failure requires a successful operator re-probe', async t => {
  const stub = await embeddingStub(t); const f = fixture(t, { baseUrl: stub.baseUrl, model: 'stub-wire', responseModel: 'stub-pinned', dimension: 2 }); publishAll(f);
  markVectorFailure(f.vault, f.directory, f.profile, 'EMBEDDING_STALE_MODEL', false);
  assert.equal(vectorState(f.vault, f.directory).state, 'stale-model');
  assert.throws(() => publishAll(f), error => error.code === 'EMBEDDING_STALE_MODEL');
  const result = await setupCommand(f, ['--embeddings-on']); assert.equal(result.status, 0, result.stderr);
  assert.equal(vectorState(f.vault, f.directory).state, 'ready'); assert.equal(stub.requests.length, 1);
  const db = openIndex(f.directory, f.vault, true); db.exec('DELETE FROM notes'); db.close();
  publishVectors(f.vault, f.directory, f.profile, [], []);
  const rebuilt = rebuildVectorGeneration(f.vault, f.directory, f.profile); assert.equal(rebuilt.slots, 0);
  assert.equal(statSync(pack(f).filename).size, 0); assert.equal(vectorState(f.vault, f.directory).state, 'ready');
});
