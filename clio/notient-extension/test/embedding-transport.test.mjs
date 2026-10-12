import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, statSync, cpSync } from 'node:fs';
import path from 'node:path';
import { createOpenAIAdapter, createHostAdapter, configuredAdapter } from '../lib/embedding-adapter.mjs';
import { normalizeEmbeddings, embeddingSpace, embeddingInput, embeddingCanary } from '../lib/embedding-config.mjs';
import { readConfig, atomicJson } from '../lib/config.mjs';
import { statusSnapshot } from '../lib/status.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { embeddingStub, profile, setupCommand } from './embedding-helpers.mjs';

const flags = baseUrl => ['--embeddings-url', baseUrl, '--embeddings-model', 'stub-wire', '--embeddings-dimension', '2', '--embeddings-max-input-bytes', '1600'];

test('embedding transport pins the canary, sends exact path and headers, and configuration setup never bootstraps', async t => {
  const stub = await embeddingStub(t); const f = writerFixture(t); put(f, 'Source.md', 'Fixture-only text.\n');
  const before = snapshot(f.vault.path); const envelope = readFileSync(new URL('../clio-coder-extension.yaml', import.meta.url));
  const result = await setupCommand(f, [...flags(stub.baseUrl.replace('/v1', '')), '--embeddings-key-stdin'], { key: 'stub-secret\n' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.includes('stub-secret'), false);
  const saved = readConfig(f.directory); assert.equal(saved.embeddings.responseModel, 'stub-pinned'); assert.equal(saved.embeddings.apiKey, 'stub-secret'); assert.equal(saved.vaults[0].embeddings, true);
  assert.equal(saved.embeddings.batch, 32); assert.equal(saved.embeddings.timeoutMs, 15000); assert.equal(saved.embeddings.spaceVersion, '1'); assert.equal(saved.embeddings.documentPrefix, '');
  assert.equal(statSync(path.join(f.directory, 'config.json')).mode & 0o777, 0o600);
  assert.equal(stub.requests.length, 1); assert.equal(stub.requests[0].path, '/v1/embeddings'); assert.equal(stub.requests[0].headers.authorization, 'Bearer stub-secret');
  assert.deepEqual(stub.requests[0].body, { model: 'stub-wire', input: [embeddingCanary], encoding_format: 'float' });
  assert.deepEqual(snapshot(f.vault.path), before); assert.deepEqual(readFileSync(new URL('../clio-coder-extension.yaml', import.meta.url)), envelope);
  const status = statusSnapshot(f.directory, { runtime: true }); assert.equal(status.vaults[0].embedding.model, 'stub-wire'); assert.equal(JSON.stringify(status).includes(stub.baseUrl), false); assert.equal(JSON.stringify(status).includes('stub-secret'), false);
  const off = await setupCommand(f, ['--embeddings-off']); assert.equal(off.status, 0); assert.equal(stub.requests.length, 1); assert.equal(readConfig(f.directory).vaults[0].embeddings, false);
  const on = await setupCommand(f, ['--embeddings-on']); assert.equal(on.status, 0, on.stderr); assert.equal(stub.requests.length, 2); assert.equal(readConfig(f.directory).vaults[0].embeddings, true);
});

test('AI_AGENT presence refuses setup before missing files, stdin and network, and secret flags stay closed', async t => {
  const stub = await embeddingStub(t); const f = writerFixture(t); const before = snapshot(f.temporary);
  for (const agent of ['', 'clio']) {
    const result = await setupCommand({ ...f, vault: { ...f.vault, path: '/missing/notient-stub-vault' } }, [...flags(stub.baseUrl), '--embeddings-key-stdin'], { agent });
    assert.equal(result.status, 2); assert.equal(result.stderr, 'Notient setup is an operator act and refuses AI_AGENT.\n');
  }
  for (const args of [['--embeddings-key', 'stub-secret'], ['--embeddings-response-model', 'invented'], ['--embeddings-on', ...flags(stub.baseUrl)], ['--embeddings-url', stub.baseUrl], ['--embeddings-key-stdin']]) assert.equal((await setupCommand(f, args)).status, 2);
  assert.equal(stub.requests.length, 0); assert.deepEqual(snapshot(f.temporary), before);
});

for (const variant of ['redirect', '429', '500', 'bad-json', 'missing-index', 'duplicate-index', 'dimension', 'zero', 'nonfinite', 'model', 'missing-model', 'cap', 'timeout']) test(`embedding transport refuses ${variant} with redacted diagnostics and no retries`, async t => {
  const stub = await embeddingStub(t, async (request, response, body) => {
    if (variant === 'redirect') { response.writeHead(302, { Location: '/leak-stub-secret' }); response.end('private response'); return; }
    if (['429', '500'].includes(variant)) { response.writeHead(Number(variant)); response.end('private response stub-secret'); return; }
    if (variant === 'bad-json') { response.end('private response stub-secret'); return; }
    if (variant === 'cap') { response.writeHead(200, { 'Content-Length': 16 * 1024 * 1024 + 1 }); response.end(); return; }
    if (variant === 'timeout') { await new Promise(resolve => setTimeout(resolve, 1100)); response.end('{}'); return; }
    const data = body.input.map((text, index) => ({ index, embedding: [1, 0] }));
    if (variant === 'missing-index') delete data[0].index;
    if (variant === 'duplicate-index') data[1].index = 0;
    if (variant === 'dimension') data[0].embedding = [1];
    if (variant === 'zero') data[0].embedding = [0, 0];
    if (variant === 'nonfinite') data[0].embedding = [null, 0];
    response.end(JSON.stringify({ ...(variant === 'missing-model' ? {} : { model: variant === 'model' ? 'other-model' : 'stub-pinned' }), data }));
  });
  const adapter = createOpenAIAdapter(profile(stub.baseUrl, { apiKey: 'stub-secret', timeoutMs: 1000 }));
  await assert.rejects(adapter.embed(['private input', 'private second']), error => {
    assert.equal(error.message.includes('private'), false); assert.equal(error.message.includes('stub-secret'), false); assert.equal(error.message.includes(stub.baseUrl), false);
    assert.equal(error.retryable, ['429', '500', 'timeout'].includes(variant)); return error.code.startsWith('EMBEDDING_');
  }); assert.equal(stub.requests.length, 1);
});

test('setup failure preserves every profile and opt-in, additional opt-in re-probes and shared changes disclose existing opted-in vaults', async t => {
  let model = 'stub-pinned'; const stub = await embeddingStub(t, (request, response, body) => response.end(JSON.stringify({ model, data: body.input.map((text, index) => ({ index, embedding: [1, 0] })) })));
  const f = writerFixture(t); const first = await setupCommand(f, flags(stub.baseUrl)); assert.equal(first.status, 0, first.stderr);
  const saved = readConfig(f.directory); model = 'changed-model'; const before = readFileSync(path.join(f.directory, 'config.json'));
  const on = await setupCommand(f, ['--embeddings-on']); assert.equal(on.status, 2); assert.deepEqual(readFileSync(path.join(f.directory, 'config.json')), before);
  model = 'stub-pinned'; const configured = await setupCommand(f, [...flags(stub.baseUrl), '--embeddings-space-version', '2']); assert.equal(configured.status, 0); assert.deepEqual(JSON.parse(configured.stdout).affectedOptedInVaults, [saved.vaults[0].id]);
});

test('space identity excludes credential and scheduling, prefixes are applied once before byte bounds, and destinations are closed', () => {
  const base = normalizeEmbeddings(profile('http://127.0.0.1:1234/v1/'));
  assert.equal(embeddingSpace(base), embeddingSpace(normalizeEmbeddings({ ...base, apiKey: 'other', batch: 1, timeoutMs: 1000 })));
  for (const extra of [{ baseUrl: 'http://127.0.0.1:1235/v1' }, { model: 'other' }, { responseModel: null }, { dimension: 3 }, { documentPrefix: 'D:' }, { queryPrefix: 'Q:' }, { maxInputBytes: 100 }, { spaceVersion: '2' }]) assert.notEqual(embeddingSpace(base), embeddingSpace(normalizeEmbeddings({ ...base, ...extra })));
  const prefixed = { ...base, maxInputBytes: 64, documentPrefix: 'D:', queryPrefix: 'Q:' }; assert.equal(embeddingInput(prefixed, 'text'), 'D:text'); assert.equal(embeddingInput(prefixed, 'text', 'query'), 'Q:text');
  assert.throws(() => embeddingInput(prefixed, '𐐀'.repeat(16)), error => error.code === 'EMBEDDING_INPUT_LIMIT');
  for (const baseUrl of ['ftp://host/v1', 'http://key@host/v1', 'http://host/v1?key=secret', 'http://host/v1#secret']) assert.throws(() => normalizeEmbeddings({ ...base, baseUrl }), error => error.code === 'EMBEDDING_CONFIG');
});

test('E1 empty query and fragment delimiters refuse before probing and valid destinations use the exact embeddings suffix', async t => {
  const stub = await embeddingStub(t); const f = writerFixture(t); const before = snapshot(f.temporary);
  for (const delimiter of ['?', '#', '?#']) {
    assert.throws(() => normalizeEmbeddings(profile(stub.baseUrl + delimiter)), error => error.code === 'EMBEDDING_CONFIG');
    const refused = await setupCommand(f, flags(stub.baseUrl + delimiter)); assert.notEqual(refused.status, 0); assert.equal(stub.requests.length, 0); assert.deepEqual(snapshot(f.temporary), before);
  }
  await createOpenAIAdapter(profile(stub.baseUrl + '/')).embed(['fixture']); assert.equal(stub.requests.at(-1).path, '/v1/embeddings');
});

test('E2 host calls use the documented object contract and bind the exact expected profile identity', async () => {
  const calls = []; let returnedIdentity = 'fixture-profile-a';
  const context = { async embed(request) { calls.push(request); assert.equal(Array.isArray(request), false); return { profileIdentity: returnedIdentity, vectors: request.inputs.map(() => [1, 0]) }; } };
  const identity = { profileId: 'fixture-profile-a', profileIdentity: 'fixture-profile-a', model: 'same-model', dimension: 2, maxBatch: 2, maxInputBytes: 1600 };
  const adapter = createHostAdapter(context, identity);
  assert.equal((await adapter.embed(['a', 'b', 'c'], { task: 'query' })).vectors.length, 3);
  assert.deepEqual(calls, [{ inputs: ['a', 'b'], task: 'query', expectedProfileIdentity: 'fixture-profile-a' }, { inputs: ['c'], task: 'query', expectedProfileIdentity: 'fixture-profile-a' }]);
  const other = createHostAdapter(context, { ...identity, profileIdentity: 'fixture-profile-b' }); assert.notEqual(other.describe().spaceId, adapter.describe().spaceId);
  returnedIdentity = 'fixture-profile-b'; await assert.rejects(adapter.embed(['a']), error => error.code === 'EMBEDDING_STALE_MODEL');
  const wide = createHostAdapter(context, { ...identity, profileIdentity: 'fixture-profile-b', maxBatch: 32 }); assert.equal(wide.describe().maxBatch, 8);
  const invalid = createHostAdapter({ async embed() { return { profileIdentity: 'fixture-profile-a', vectors: [[0, 0]] }; } }, identity);
  await assert.rejects(invalid.embed(['a']), error => error.code === 'EMBEDDING_RESPONSE_INVALID');
});

test('configuration drift discards in-flight results and the host seam splits at its advertised bound', async t => {
  let current = true;
  const stub = await embeddingStub(t, (request, response, body) => { current = false; response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((text, index) => ({ index, embedding: [1, 0] })) })); });
  const adapter = createOpenAIAdapter(profile(stub.baseUrl), { isCurrent: () => current });
  await assert.rejects(adapter.embed(['fixture']), error => error.code === 'EMBEDDING_CONFIG_CHANGED');
  const calls = []; const host = createHostAdapter({ async embed({ inputs, expectedProfileIdentity }) { calls.push(inputs); return { vectors: inputs.map(() => [1, 0]), profileIdentity: expectedProfileIdentity }; } }, { profileIdentity: 'fixture-host-v1', model: 'host-model', dimension: 2, maxBatch: 2, maxInputBytes: 1600 });
  assert.equal((await host.embed(['a', 'b', 'c'])).vectors.length, 3); assert.deepEqual(calls.map(call => call.length), [2, 1]);
});

test('actual operator config replacement during a stub request discards results before publication', async t => {
  const f = writerFixture(t);
  const stub = await embeddingStub(t, (request, response, body) => {
    const current = readConfig(f.directory); current.embeddings.spaceVersion = '2'; atomicJson(path.join(f.directory, 'config.json'), current);
    response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((text, index) => ({ index, embedding: [1, 0] })) }));
  });
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, embeddings: profile(stub.baseUrl), vaults: [{ ...f.vault, embeddings: true }] });
  const adapter = configuredAdapter(f.vault, f.directory);
  await assert.rejects(adapter.embed(['fixture-only input']), error => error.code === 'EMBEDDING_CONFIG_CHANGED');
  assert.equal(stub.requests.length, 1);
});

test('one shared profile preserves independent opt-in bits and discloses every affected enabled vault', async t => {
  const stub = await embeddingStub(t); const first = writerFixture(t); const second = writerFixture(t); const third = writerFixture(t);
  atomicJson(path.join(first.directory, 'config.json'), { version: 1, vaults: [first.vault, second.vault, third.vault] });
  const configured = await setupCommand(first, flags(stub.baseUrl)); assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(readConfig(first.directory).vaults.map(vault => vault.embeddings), [true, false, false]);
  const enabled = await setupCommand({ ...first, vault: second.vault }, ['--embeddings-on']); assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(readConfig(first.directory).vaults.map(vault => vault.embeddings), [true, true, false]);
  const changed = await setupCommand(first, [...flags(stub.baseUrl), '--embeddings-space-version', '2']); assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout).affectedOptedInVaults, [first.vault.id, second.vault.id]);
  assert.deepEqual(readConfig(first.directory).vaults.map(vault => vault.embeddings), [true, true, false]);
  assert.deepEqual(snapshot(second.vault.path), {}); assert.deepEqual(snapshot(third.vault.path), {});
});
