import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { embeddingStub, profile } from './embedding-helpers.mjs';
import { atomicJson, readConfig } from '../lib/config.mjs';
import { normalizeEmbeddings } from '../lib/embedding-config.mjs';
import { openIndex, refreshIndex } from '../lib/index.mjs';
import { refreshVectors } from '../lib/embed-refresh.mjs';
import { findCandidates } from '../lib/candidates.mjs';
import { vectorState, vectorChunks, publishVectors } from '../lib/vector-store.mjs';
import { revision } from '../lib/paths.mjs';
import { semanticSignal } from '../lib/separation.mjs';

export async function embeddingFixture(t, { files, handler, ...extra } = {}) {
  const stub = await embeddingStub(t, handler); const f = writerFixture(t);
  f.profile = normalizeEmbeddings(profile(stub.baseUrl, { ...extra }));
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, embeddings: f.profile, vaults: [{ ...f.vault, embeddings: true }] });
  for (const [name, text] of Object.entries(files ?? { 'Source.md': '# Source\n\nAlpha evidence.\n', 'Target.md': '# Target\n\nBeta evidence.\n' })) put(f, name, text);
  refreshIndex(f.vault, f.directory);
  return { ...f, stub, sourceRevision: revision((files ?? {})['Source.md'] ?? '# Source\n\nAlpha evidence.\n') };
}

export async function embeddingCommand(f, name, input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url)), JSON.stringify({ vault: f.vault.id, ...input })], { env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [status] = await once(child, 'exit'); return { status, value: JSON.parse(stdout), stderr };
}

test('embed refresh exports only eligible authored slices in bounded prefixed batches and resumes without re-exporting ready rows', async t => {
  const f = await embeddingFixture(t, { batch: 1, documentPrefix: 'doc: ', files: { 'Source.md': '---\nsecret: hidden\n---\n# Source\n\nAuthored alpha.\n\n## Related\n\n- [[Target]]\n', 'Target.md': '# Target\n\nAuthored beta.\n', 'Visitor.md': '<!-- notient:start -->\nhidden visitor\n<!-- notient:end -->\n' } });
  const before = snapshot(f.vault.path);
  const first = await embeddingCommand(f, 'refresh', { tier: 'embed' }); assert.equal(first.status, 0, JSON.stringify(first)); assert.equal(first.value.embedding.state, 'ready'); assert.equal(first.value.embedding.embeddedThisCall, 2);
  assert.deepEqual(f.stub.requests.map(request => request.body.input), [['doc: Authored alpha.\n'], ['doc: Authored beta.\n']]);
  const second = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(second.embedding.embeddedThisCall, 0); assert.equal(f.stub.requests.length, 2);
  const forced = await refreshVectors(f.vault, f.directory, { tier: 'embed', force: true }); assert.equal(forced.generation.reused, 2); assert.equal(f.stub.requests.length, 2);
  put(f, 'Target.md', '# Target\n\nUpdated beta.\n'); refreshIndex(f.vault, f.directory);
  const resumed = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(resumed.embedding.embeddedThisCall, 1); assert.equal(f.stub.requests.length, 3); assert.equal(resumed.embedding.state, 'ready');
  assert.equal(snapshot(f.vault.path)['Source.md'], before['Source.md']);
});

test('budget exhaustion preserves only committed batches and the next explicit refresh resumes missing rows', async t => {
  const f = await embeddingFixture(t, { batch: 1 }); let clock = 0;
  const adapter = { describe: () => ({ spaceId: vectorState(f.vault, f.directory).spaceId }), async embed(texts) { clock += 600; return { vectors: texts.map(() => [1, 0]), model: f.profile.model, responseModel: f.profile.responseModel, dimension: 2 }; } };
  const first = await refreshVectors(f.vault, f.directory, { tier: 'embed', budgetMs: 1000 }, { now: () => clock, adapter }); assert.equal(first.reason, 'budget_exhausted'); assert.equal(first.embedding.embeddedThisCall, 1); assert.equal(first.embedding.remaining, 1);
  const next = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(next.embedding.embeddedThisCall, 1); assert.equal(next.embedding.state, 'ready'); assert.equal(f.stub.requests.length, 1);
});

test('a retryable stub failure is persisted without private values and later refresh retries the missing batch only', async t => {
  let failed = false;
  const f = await embeddingFixture(t, { batch: 1, apiKey: 'fixture-private-key', handler: (request, response, body) => { if (body.input[0].startsWith('Beta') && !failed) { failed = true; response.writeHead(429); response.end('fixture-private-key endpoint-secret'); } else response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); } });
  const first = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(first.embedding.embeddedThisCall, 1); assert.equal(first.embedding.failedBatches, 1); assert.equal(first.reason, 'embedding_unavailable');
  const db = openIndex(f.directory, f.vault); const failure = db.prepare("SELECT value FROM meta WHERE key='embeddingFailure'").get().value; db.close(); assert.equal(failure.includes('fixture-private-key'), false); assert.match(failure, /EMBEDDING_HTTP/);
  const next = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(next.embedding.embeddedThisCall, 1); assert.equal(next.embedding.state, 'ready'); assert.equal(f.stub.requests.length, 3);
});

test('embed prerequisites and pinned-model drift prohibit further export until a setup re-probe', async t => {
  const f = await embeddingFixture(t, { handler: (request, response, body) => response.end(JSON.stringify({ model: 'wrong-model', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })) });
  put(f, 'Target.md', 'Human save.\n'); const prerequisite = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(prerequisite.reason, 'structural_refresh_required'); assert.equal(f.stub.requests.length, 0);
  refreshIndex(f.vault, f.directory); const failed = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(failed.reason, 'stale_model'); assert.equal(f.stub.requests.length, 1);
  const blocked = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(blocked.reason, 'stale_model'); assert.equal(f.stub.requests.length, 1);
});

test('inference occurs outside the publication exclusion and discards changed chunks or configuration', async t => {
  let f;
  f = await embeddingFixture(t, { handler: (request, response, body) => { put(f, 'Target.md', 'New live evidence.\n'); refreshIndex(f.vault, f.directory); response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })); } });
  const result = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(result.reason, 'structural_refresh_required'); assert.equal(result.embedding.embeddedThisCall, 1); assert.equal(result.embedding.missing, 1);
  const before = snapshot(f.vault.path); const config = readConfig(f.directory); config.vaults[0].embeddings = false; atomicJson(path.join(f.directory, 'config.json'), config);
  const off = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(off.reason, 'embedding_off'); assert.deepEqual(snapshot(f.vault.path), before);
});

test('a shared profile change during a batch discards all inferred rows without disabling the new profile', async t => {
  let f;
  f = await embeddingFixture(t, { handler: (request, response, body) => {
    const config = readConfig(f.directory); config.embeddings.queryPrefix = 'changed: '; atomicJson(path.join(f.directory, 'config.json'), config);
    response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  } });
  const result = await refreshVectors(f.vault, f.directory, { tier: 'embed' }); assert.equal(result.reason, 'config_changed'); assert.equal(result.embedding.embeddedThisCall, 0); assert.equal(result.embedding.state, 'building');
  const db = openIndex(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM vec_meta').get().n, 0); db.close(); assert.equal(f.stub.requests.length, 1);
});

test('exhaustive candidates choose each note minimum winning pair, deterministic ties and literal CRLF evidence without HTTP', async t => {
  const files = { 'Source.md': '# Source\r\n\r\nFirst source.\r\n\r\nSecond source.\r\n', 'A.md': '# A\n\nFirst target.\n\nSecond target.\n', 'B.md': '# B\n\nOther target.\n', 'Negative.md': 'Negative target.\n' };
  const f = await embeddingFixture(t, { files }); const db = openIndex(f.directory, f.vault); const chunks = [...vectorChunks(db, f.profile)].filter(row => row.eligible); db.close();
  const vectors = chunks.map(chunk => chunk.path === 'Source.md' ? chunk.ordinal ? [0, 1] : [1, 0] : chunk.path === 'Negative.md' ? [-1, -1] : chunk.path === 'A.md' && !chunk.ordinal ? [0.6, 0.8] : [0, 1]);
  publishVectors(f.vault, f.directory, f.profile, chunks, vectors);
  const before = snapshot(f.vault.path); const result = await embeddingCommand(f, 'candidates', { source: 'Source.md', revision: f.sourceRevision, limit: 12 }); assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(result.value.candidates.map(row => row.path), ['A.md', 'B.md', 'Negative.md']); assert.equal(result.value.candidates[0].bestDistance, 0); assert.match(result.value.candidates[0].sourceEvidence.passage, /Second source\.\r\n$/); assert.match(result.value.candidates[0].targetEvidence.passage, /Second target/);
  assert.ok(result.value.candidates[2].bestDistance > 1); assert.match(result.value.candidateSet, /^[a-f0-9-]{36}$/); assert.equal(f.stub.requests.length, 0); assert.deepEqual(snapshot(f.vault.path), before);
  const receipts = openIndex(f.directory, f.vault); const row = receipts.prepare('SELECT * FROM candidate_sets').get(); const payload = JSON.parse(row.payload_json); receipts.close();
  assert.deepEqual(payload.targets, result.value.candidates); assert.equal(row.inventory_hash, payload.inventoryHash); assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 86400000);
});

test('bidirectional resolved wiki edges exclude neighbors while embeds and Markdown links remain candidates', async t => {
  const f = await embeddingFixture(t, { files: { 'Source.md': 'Source evidence.\n\n[[Outgoing]]\n![[Embedded]]\n[Markdown](Markdown.md)\n', 'Outgoing.md': 'Outgoing evidence.\n', 'Incoming.md': 'Incoming evidence.\n\n[[Source]]\n', 'Embedded.md': 'Embedded evidence.\n', 'Markdown.md': 'Markdown evidence.\n' } });
  await refreshVectors(f.vault, f.directory, { tier: 'embed' }); const requests = f.stub.requests.length;
  const result = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision }); assert.deepEqual(result.candidates.map(row => row.path), ['Embedded.md', 'Markdown.md']); assert.equal(f.stub.requests.length, requests);
});

test('candidates requires every source chunk, bounds at 64 without sampling and creates no receipt on deadline or drift', async t => {
  const f = await embeddingFixture(t, { files: { 'Source.md': Array.from({ length: 65 }, (_, i) => `Source paragraph ${i}.\n`).join('\n'), 'Target.md': 'Target evidence.\n' } });
  await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  assert.throws(() => findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision }), error => error.code === 'CANDIDATE_LIMIT');
  put(f, 'Source.md', 'Small source.\n'); refreshIndex(f.vault, f.directory);
  const missing = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: revision('Small source.\n') }); assert.equal(missing.reason, 'source_vectors_missing');
  await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  let clock = 0; assert.throws(() => findCandidates(f.vault, f.directory, { source: 'Source.md', revision: revision('Small source.\n') }, { now: () => { clock += 10000; return clock; } }), error => error.code === 'CANDIDATE_TIMEOUT');
  assert.throws(() => findCandidates(f.vault, f.directory, { source: 'Source.md', revision: revision('Small source.\n') }, { beforeReceipt: () => put(f, 'Target.md', 'Later target.\n') }), error => error.code === 'TARGET_CHANGED');
  const db = openIndex(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM candidate_sets').get().n, 0); db.close();
});

test('receipt capacity never prunes a live preview and explicit refresh reclaims only expired rows', async t => {
  const f = await embeddingFixture(t); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const db = openIndex(f.directory, f.vault, true); db.exec('BEGIN'); const insert = db.prepare('INSERT INTO candidate_sets VALUES (?,?,?,?,?,?,?,?,?,?)');
  const spaceId = vectorState(f.vault, f.directory, { db }).spaceId;
  for (let i = 0; i < 10000; i++) insert.run(`fixture-${i}`, f.vault.id, 'Source.md', f.sourceRevision, spaceId, 1, 'a'.repeat(64), '{}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'); db.exec('COMMIT');
  assert.throws(() => findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision }), error => error.code === 'CANDIDATE_CAPACITY');
  db.prepare("UPDATE candidate_sets SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='fixture-0'").run(); db.close();
  await refreshVectors(f.vault, f.directory, { tier: 'structural' }); const result = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision }); assert.ok(result.candidateSet);
});

test('candidate separation uses per-note scores before limit one and keeps flat or negative neighbors visible', async t => {
  const files = { 'Source.md': 'Source evidence.\n', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`N${i.toString().padStart(2, '0')}.md`, `Neighbor ${i} evidence.\n`])) };
  const f = await embeddingFixture(t, { files }); await refreshVectors(f.vault, f.directory, { tier: 'embed' });
  const result = findCandidates(f.vault, f.directory, { source: 'Source.md', revision: f.sourceRevision, limit: 1 }); assert.equal(result.candidates.length, 1); assert.equal(result.separation.state, 'flat'); assert.equal(result.separation.semantic.candidates, 12); assert.equal(result.separation.semantic.value, 0); assert.equal(result.separation.semantic.calibrated, false);
  assert.equal(semanticSignal([1, ...Array(9).fill(0)]).reason, 'zero_variance_gap');
});
