import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateSync } from 'node:fs';
import path from 'node:path';
import { embeddingFixture, embeddingCommand } from './embedding-candidates.test.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { refreshVectors } from '../lib/embed-refresh.mjs';
import { searchHybrid, fuseArms } from '../lib/hybrid-search.mjs';
import { semanticSignal, lexicalSignal, combinedSeparation, normalizedTerms, significantTerms } from '../lib/separation.mjs';
import { openIndex } from '../lib/index.mjs';
import { indexPath, readConfig, atomicJson } from '../lib/config.mjs';
import { quantizeVector, reconstructedVector, cosine } from '../lib/vector-math.mjs';

test('separation covers fewer than ten, constant tails, exact z boundary and inspectable arm precedence without nonfinite JSON', () => {
  assert.equal(semanticSignal(Array(9).fill(1)).state, 'undetermined');
  assert.deepEqual(semanticSignal(Array(10).fill(0.3)), { state: 'flat', basis: 'semantic-z', value: 0, zMin: 2, calibrated: false, candidates: 10, reason: 'zero_variance_equal' });
  const gap = semanticSignal([1, ...Array(9).fill(0.3)]); assert.equal(gap.state, 'separated'); assert.equal(gap.value, null); assert.equal(gap.reason, 'zero_variance_gap');
  const tail = [0, 0, 0, 0, 1, 1, 1, 1, 1]; const mean = 5 / 9; const sd = Math.sqrt(20 / 81);
  assert.equal(semanticSignal([mean + 2 * sd, ...tail]).state, 'separated'); assert.equal(semanticSignal([mean + 1.999 * sd, ...tail]).state, 'flat');
  const matches = Array.from({ length: 10 }, () => ({ passage: 'quartz amber' }));
  assert.equal(lexicalSignal(matches, ['quartz', 'amber'], false).state, 'separated'); assert.equal(lexicalSignal(matches, ['quartz', 'amber'], true).state, 'flat'); assert.equal(lexicalSignal(matches, [], false).state, 'undetermined');
  assert.equal(combinedSeparation(gap, lexicalSignal(matches, [], false)).state, 'separated'); assert.equal(combinedSeparation(semanticSignal(Array(10).fill(1)), lexicalSignal(matches, ['absent'], false)).state, 'flat');
  assert.equal(combinedSeparation(null, null).state, 'undetermined'); assert.doesNotMatch(JSON.stringify(gap), /NaN|Infinity/);
  assert.deepEqual(significantTerms(normalizedTerms('THE ＱＵＡＲＴＺ quartz and xx AMBER')), ['quartz', 'amber']);
});

test('RRF uses exact weights and one-based ranks by chunk with absent contributions zero', () => {
  const a = { id: 1, path: 'A.md', ordinal: 0, revision: 'a', passage: 'a', score: 0.9 };
  const b = { id: 2, path: 'B.md', ordinal: 0, revision: 'b', passage: 'b', score: 0.8 };
  const c = { id: 3, path: 'C.md', ordinal: 0, revision: 'c', passage: 'c', score: 1 };
  const result = fuseArms({ available: true, rows: [a, b] }, { available: true, rows: [c, a] });
  assert.equal(result.find(row => row.id === 1).score, 0.7 / 61 + 0.3 / 62); assert.equal(result.find(row => row.id === 2).score, 0.7 / 62); assert.equal(result.find(row => row.id === 3).score, 0.3 / 61);
  assert.deepEqual(fuseArms(null, { available: true, rows: [a] }), [a]);
});

test('lexical AND is precise, significant OR fires only at zero rows, and diagnostic labels do not depend on limit one', async t => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`N${i.toString().padStart(2, '0')}.md`, `quartz ${i === 0 ? 'amber' : 'common'} evidence ${i}.\n`]));
  const f = await embeddingFixture(t, { files }); const before = snapshot(f.vault.path);
  const precise = await searchHybrid(f.vault, f.directory, { query: 'quartz amber', mode: 'lexical' }); assert.equal(precise.hits.length, 1); assert.equal(precise.hits[0].path, 'N00.md'); assert.equal(precise.separation.lexical.candidates, 1); assert.equal(precise.reason, null); assert.equal(f.stub.requests.length, 0);
  const fallback = await searchHybrid(f.vault, f.directory, { query: 'quartz missing', mode: 'lexical', limit: 1 }); assert.equal(fallback.hits.length, 1); assert.equal(fallback.separation.lexical.candidates, 12); assert.equal(fallback.separation.lexical.state, 'flat'); assert.equal(fallback.separation.lexical.reason, 'term_fallback');
  const common = await searchHybrid(f.vault, f.directory, { query: 'quartz', mode: 'lexical', limit: 1 }); assert.equal(common.separation.lexical.state, 'separated'); assert.equal(common.separation.lexical.candidates, 12); assert.ok(common.hits[0].score < 0);
  const stopped = await searchHybrid(f.vault, f.directory, { query: 'the and nonexistent', mode: 'lexical' }); assert.equal(stopped.separation.lexical.state, 'undetermined'); assert.deepEqual(snapshot(f.vault.path), before);
});

test('default ready search embeds the query once, fuses separated arms and serves one exact chunk per note', async t => {
  const files = { 'Source.md': 'quartz source.\n', 'A.md': 'quartz alpha.\n\nquartz second.\n', 'B.md': 'quartz beta.\n' };
  const f = await embeddingFixture(t, { files, queryPrefix: 'query: ' }); await refreshVectors(f.vault, f.directory, { tier: 'embed' }); const before = snapshot(f.vault.path); const initial = f.stub.requests.length;
  const result = await embeddingCommand(f, 'search', { query: 'quartz', sourcePath: 'Source.md' }); assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.value.mode, 'hybrid'); assert.deepEqual(result.value.hits.map(hit => hit.path), ['A.md', 'B.md']); assert.equal(f.stub.requests.length, initial + 1); assert.deepEqual(f.stub.requests.at(-1).body.input, ['query: quartz']);
  assert.equal(result.value.separation.semantic.candidates, 3); assert.equal(result.value.separation.lexical.candidates, 3); assert.equal(result.value.coverage.state, 'current'); assert.deepEqual(snapshot(f.vault.path), before);
  const db = openIndex(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM served WHERE call_id=?').get(result.value.callId).n, 2); db.close();
});

test('workspace equality and source exclusion apply before both arm ranks and diagnostics', async t => {
  const f = await embeddingFixture(t, { files: { 'Source.md': '---\nworkspace: Repo\n---\nquartz source.\n', 'A.md': '---\nworkspace: Repo\n---\nquartz matching.\n', 'B.md': '---\nworkspace: repo\n---\nquartz lowercase.\n', 'C.md': '---\nrepositories: [Repo]\n---\nquartz repository only.\n' } }); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  for (const mode of ['lexical', 'semantic', 'hybrid']) { const result = await searchHybrid(f.vault, f.directory, { query: 'quartz', workspace: 'Repo', sourcePath: 'Source.md', mode }); assert.deepEqual(result.hits.map(hit => hit.path), ['A.md']); for (const signal of [result.separation.semantic, result.separation.lexical].filter(Boolean)) assert.equal(signal.candidates, 1); }
});

test('flat semantic scores stay returned and labels use fifty raw chunk scores before the display cap', async t => {
  const f = await embeddingFixture(t, { files: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`N${String(i).padStart(2, '0')}.md`, `quartz neighbor ${i}.\n`])) }); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const result = await searchHybrid(f.vault, f.directory, { query: 'quartz', mode: 'semantic', limit: 1 }); assert.equal(result.hits.length, 1); assert.equal(result.hits[0].path, 'N00.md'); assert.equal(result.separation.state, 'flat'); assert.equal(result.separation.semantic.candidates, 50); assert.equal(result.separation.semantic.value, 0); assert.equal(result.candidateLimitReached, true);
});

test('off building stale unavailable and oversized semantic arms return lexical fallback only in hybrid mode', async t => {
  let fail = false;
  const f = await embeddingFixture(t, { handler: (request, response, body) => { if (fail) { response.writeHead(429); response.end('private upstream diagnostic'); } else response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); } });
  const building = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }); assert.equal(building.reason, 'embedding_building'); assert.equal(building.hits.length, 1); assert.equal(f.stub.requests.length, 0);
  await refreshVectors(f.vault, f.directory, { tier: 'embed' }); fail = true;
  const fallback = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }); assert.equal(fallback.reason, 'embedding_unavailable'); assert.equal(fallback.hits.length, 1); assert.equal(fallback.separation.semantic, null);
  const semantic = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'semantic' }); assert.equal(semantic.reason, 'embedding_unavailable'); assert.deepEqual(semantic.hits, []);
  const lexical = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'lexical' }); assert.equal(lexical.coverage.state, 'current'); assert.equal(lexical.reason, null); assert.equal(lexical.hits.length, 1);
});

test('raw revision and literal slice verification drop drift and persist refresh need without altering vault bytes', async t => {
  const f = await embeddingFixture(t); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const result = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }, { beforeServe: () => put(f, 'Source.md', 'Later operator save.\n') });
  assert.ok(result.stalePaths.includes('Source.md')); assert.equal(result.refreshRequired, true); assert.equal(result.coverage.state, 'incomplete'); assert.equal(result.hits.some(hit => hit.path === 'Source.md'), false);
  const db = openIndex(f.directory, f.vault); assert.match(db.prepare("SELECT value FROM meta WHERE key='refreshRequired'").get().value, /Source.md/); db.close();
});

test('a short pack disables semantic independently and preserves lexical hits', async t => {
  const f = await embeddingFixture(t); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const db = openIndex(f.directory, f.vault); const filename = db.prepare('SELECT pack_file FROM vector_spaces').get().pack_file; db.close(); truncateSync(path.join(path.dirname(indexPath(f.directory, f.vault)), filename), 1);
  const result = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }); assert.equal(result.reason, 'embedding_unavailable'); assert.equal(result.embedding.state, 'unavailable'); assert.equal(result.hits[0].path, 'Source.md');
});

test('oversized queries perform no inference and preserve explicitly labeled lexical fallback', async t => {
  const f = await embeddingFixture(t, { maxInputBytes: 64 }); await refreshVectors(f.vault, f.directory, { tier: 'embed' }); const requests = f.stub.requests.length;
  const query = 'Alpha ' + 'long '.repeat(20);
  const result = await searchHybrid(f.vault, f.directory, { query, mode: 'hybrid' }); assert.equal(result.reason, 'embedding_unavailable'); assert.equal(result.hits[0].path, 'Source.md'); assert.equal(result.embedding.state, 'ready'); assert.equal(f.stub.requests.length, requests);
  const only = await searchHybrid(f.vault, f.directory, { query, mode: 'semantic' }); assert.deepEqual(only.hits, []); assert.equal(f.stub.requests.length, requests);
});

test('oversized derived scan context reports the 64 MiB limit without a truncated semantic result', async t => {
  const f = await embeddingFixture(t, { files: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`N${i}.md`, `Small authored evidence ${i}.\n`])) }); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const db = openIndex(f.directory, f.vault, true); db.prepare('UPDATE chunks SET heading=?').run(JSON.stringify(['x'.repeat(2 * 1024 * 1024)])); db.close();
  await assert.rejects(() => searchHybrid(f.vault, f.directory, { query: 'Small', mode: 'semantic', limit: 20 }), error => error.code === 'SEARCH_SCAN_LIMIT');
});

test('E8 a profile switch between scan snapshot and adapter creation cannot mix new query vectors with the old pack', async t => {
  const f = await embeddingFixture(t); await refreshVectors(f.vault, f.directory, { tier: 'embed' }); const requests = f.stub.requests.length;
  const result = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }, { beforeInference() { const config = readConfig(f.directory); config.embeddings.model = 'another-wire-profile'; atomicJson(path.join(f.directory, 'config.json'), config); } });
  assert.equal(result.reason, 'stale_model'); assert.equal(result.separation.semantic, null); assert.equal(result.hits[0].path, 'Source.md'); assert.equal(f.stub.requests.length, requests); assert.equal(result.embedding.state, 'stale-model');
});

test('E9 query inference uses the remaining command budget and returns lexical fallback before the configured timeout', async t => {
  let slow = false;
  const f = await embeddingFixture(t, { timeoutMs: 3000, handler: async (request, response, body) => { if (slow) await new Promise(resolve => setTimeout(resolve, 1000)); response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); } });
  await refreshVectors(f.vault, f.directory, { tier: 'embed' }); slow = true; const started = performance.now();
  const result = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }, { budgetMs: 200 });
  assert.equal(result.reason, 'embedding_unavailable'); assert.equal(result.separation.semantic, null); assert.equal(result.hits[0].path, 'Source.md'); assert.ok(performance.now() - started < 500);
});

test('E9 a late successful query cannot allocate a fresh twenty-five-second scan allowance', async t => {
  let clock = 0;
  const f = await embeddingFixture(t, { handler: (request, response, body) => { if (body.input[0] === 'Alpha') clock = 1000; response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); } });
  await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const result = await searchHybrid(f.vault, f.directory, { query: 'Alpha', mode: 'hybrid' }, { budgetMs: 200, now: () => clock });
  assert.equal(result.reason, 'embedding_unavailable'); assert.equal(result.separation.semantic, null); assert.equal(result.hits[0].path, 'Source.md');
});

test('int8 exhaustive top ten agrees with the float32 reference on 200 deterministic fixture queries', () => {
  let seed = 86420; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const vectors = Array.from({ length: 240 }, () => Array.from({ length: 32 }, random)); const packed = vectors.map(vector => { const value = quantizeVector(vector); return reconstructedVector(value.bytes, value.scale); });
  let found = 0;
  for (let query = 0; query < 200; query++) {
    const floatQuery = Float64Array.from(new Float32Array(vectors[query]));
    const float = vectors.map((vector, id) => ({ id, score: cosine(floatQuery, Float64Array.from(new Float32Array(vector))) })).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 10);
    const int8 = packed.map((vector, id) => ({ id, score: cosine(floatQuery, vector) })).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 10);
    found += int8.filter(row => float.some(reference => reference.id === row.id)).length;
  }
  assert.ok(found > 0); process.stdout.write(`fixture recall@10: ${found / 2000}; queries: 200; corpus: 240; dimension: 32\n`);
});
