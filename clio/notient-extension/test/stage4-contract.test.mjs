import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { revision } from '../lib/paths.mjs';
import { unknownCoverageMessage, refreshIndex } from '../lib/index.mjs';
import { atomicJson, indexPath, readConfig } from '../lib/config.mjs';
import { baseline } from './git-write.test.mjs';
import { readRecord } from '../lib/journal.mjs';
import { statusSnapshot } from '../lib/status.mjs';

function command(f, name, input) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url)), JSON.stringify(input)], { encoding: 'utf8', timeout: 20000, env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
  assert.equal(result.error, undefined, result.stderr);
  return { status: result.status, value: JSON.parse(result.stdout) };
}

const off = { state: 'off', spaceId: null, model: null, responseModel: null, dimension: null, eligible: 0, embedded: 0, missing: 0, skipped: 0 };

test('stage 4 frozen schemas match the design and retain the runtime authority boundary', () => {
  const manifest = JSON.parse(readFileSync(new URL('../clio-coder-extension.yaml', import.meta.url)));
  const schemas = [...readFileSync(new URL('../../design/04-links-and-relations.md', import.meta.url), 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const tools = new Map(manifest.capabilities.tools.map(tool => [tool.name, tool]));
  for (const [name, schema] of [['candidates', schemas[1]], ['vitals', schemas[2]], ['revise', schemas[3]]]) {
    assert.ok(tools.has(name), name); assert.deepEqual(tools.get(name).inputSchema, schema);
  }
  assert.equal(tools.get('candidates').timeoutMs, 30000); assert.equal(tools.get('candidates').maxOutputBytes, 1048576);
  assert.deepEqual(tools.get('search').inputSchema.properties.mode, { type: 'string', enum: ['hybrid', 'lexical', 'semantic'] });
  assert.deepEqual(tools.get('refresh').inputSchema.properties.tier, { type: 'string', enum: ['structural', 'embed'] });
  assert.deepEqual(tools.get('refresh').inputSchema.properties.budgetMs, { type: 'integer', minimum: 1000, maximum: 240000 });
  assert.deepEqual(manifest.runtime.permissions.fs.write, []); assert.equal(manifest.runtime.permissions.net, false); assert.equal(manifest.runtime.permissions.exec, false);
});

test('stage 4 candidates checks the raw source revision before returning read-only embedding off', t => {
  const f = writerFixture(t); const bytes = Buffer.from('\uFEFF# Source\r\n\r\nAuthored evidence.\r\n'); put(f, 'Source.md', bytes);
  const before = snapshot(f.temporary); const input = { vault: f.vault.id, source: 'Source.md', revision: revision(bytes) };
  for (const extra of [{}, { limit: 1 }, { limit: 12 }]) {
    const { status, value } = command(f, 'candidates', { ...input, ...extra });
    assert.equal(status, 0, JSON.stringify(value)); assert.equal(value.ok, true); assert.equal(value.tool, 'candidates'); assert.equal(value.reason, 'embedding_off');
    assert.equal(value.revision, input.revision); assert.equal(value.source, input.source); assert.equal(value.candidateSet, null); assert.equal(value.expiresAt, null); assert.deepEqual(value.candidates, []); assert.deepEqual(value.embedding, off);
    assert.equal(value.coverage.state, 'unknown'); assert.equal(value.coverage.message, unknownCoverageMessage);
    assert.deepEqual(value.separation, { state: 'undetermined', semantic: null, lexical: null });
    for (const duration of Object.values(value.timings)) assert.ok(Number.isFinite(duration) && duration >= 0);
  }
  const conflict = command(f, 'candidates', { ...input, revision: '0'.repeat(64) }); assert.equal(conflict.status, 1); assert.equal(conflict.value.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(snapshot(f.temporary), before);
});

test('stage 4 semantic and embed requests degrade with no index or vault mutation', t => {
  const f = writerFixture(t); put(f, 'Source.md', 'Authored evidence.\n'); const before = snapshot(f.temporary);
  for (const mode of ['semantic', 'hybrid']) {
    const result = command(f, 'search', { vault: f.vault.id, query: 'evidence', mode }); assert.equal(result.status, 0, JSON.stringify(result.value));
    assert.equal(result.value.reason, 'embedding_off'); assert.deepEqual(result.value.hits, []); assert.deepEqual(result.value.embedding, off); assert.equal(result.value.coverage.message, unknownCoverageMessage);
  }
  for (const budgetMs of [1000, 240000]) {
    const result = command(f, 'refresh', { vault: f.vault.id, tier: 'embed', budgetMs }); assert.equal(result.status, 0, JSON.stringify(result.value)); assert.equal(result.value.reason, 'embedding_off');
    assert.deepEqual(result.value.embedding, { ...off, embeddedThisCall: 0, failedBatches: 0, remaining: 0 });
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('stage 4 lexical reads preserve exact evidence and workspace filters while hybrid reports its off arm', t => {
  const f = writerFixture(t); put(f, 'One.md', '---\nworkspace: Repo\n---\nExact quartz evidence.\r\n'); put(f, 'Other.md', '---\nworkspace: repo\n---\nquartz elsewhere\n'); refreshIndex(f.vault, f.directory);
  const before = snapshot(f.vault.path);
  for (const mode of [undefined, 'lexical', 'hybrid', 'semantic']) {
    const result = command(f, 'search', { vault: f.vault.id, query: 'quartz', workspace: 'Repo', ...(mode ? { mode } : {}) }); assert.equal(result.status, 0, JSON.stringify(result.value));
    assert.deepEqual(result.value.embedding, off);
    if (mode === 'semantic') assert.deepEqual(result.value.hits, []);
    else { assert.equal(result.value.hits.length, 1); assert.equal(result.value.hits[0].path, 'One.md'); assert.equal(result.value.hits[0].passage, 'Exact quartz evidence.\r\n'); }
    assert.equal(result.value.coverage.state, mode === 'hybrid' || mode === 'semantic' ? 'incomplete' : 'current');
    assert.equal(result.value.reason, mode === 'hybrid' || mode === 'semantic' ? 'embedding_off' : null);
  }
  assert.deepEqual(snapshot(f.vault.path), before);
});

test('stage 4 new read modes retain exit-zero unavailable setup guidance', t => {
  const f = writerFixture(t); unlinkSync(path.join(f.directory, 'config.json')); const before = snapshot(f.temporary);
  for (const [name, input] of [['candidates', { vault: 'missing', source: 'Source.md', revision: 'a'.repeat(64) }], ['search', { mode: 'semantic', query: 'quartz' }], ['refresh', { tier: 'embed' }]]) {
    const result = command(f, name, input); assert.equal(result.status, 0, JSON.stringify(result.value)); assert.equal(result.value.configured, false); assert.match(result.value.setupHint, /setup\.mjs/);
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('stage 4 command schemas refuse model calibration and foreign nested fields before mutation', t => {
  const f = writerFixture(t); put(f, 'Source.md', 'Source.\n'); put(f, 'Target.md', '# Target\n'); baseline(f, ['Source.md', 'Target.md', 'Other.md']);
  const source = revision(readFileSync(path.join(f.vault.path, 'Source.md')));
  const candidate = { vault: f.vault.id, source: 'Source.md', revision: source };
  const revise = { vault: f.vault.id, operation: 'link', path: 'Source.md', revision: source, batch: 'contracts', authorization: { origin: 'operator', request: 'Add the named edge.' }, link: { edges: [{ targetNotePath: 'Target.md', rationale: 'Named by the operator.' }] } };
  const before = snapshot(f.temporary);
  for (const [name, input] of [
    ...[{ limit: 0 }, { limit: 13 }, { model: 'redirect' }, { query: 'quartz' }, { endpoint: 'https://fixture.invalid' }, { distance: 0.1 }, { calibrated: true }, { revision: 'x'.repeat(64) }, { source: '../Target.md' }].map(extra => ['candidates', { ...candidate, ...extra }]),
    ...[{ mode: 'other' }, { zMin: 1 }, { model: 'redirect' }, { limit: 21 }].map(extra => ['search', { query: 'quartz', ...extra }]),
    ...[{ tier: 'other' }, { budgetMs: 999 }, { budgetMs: 240001 }, { baseUrl: 'https://fixture.invalid' }].map(extra => ['refresh', extra]),
    ['revise', { ...revise, relate: {} }], ['revise', { ...revise, oldText: 'Source' }],
    ['revise', { ...revise, link: { edges: [{ ...revise.link.edges[0], confidence: 0.8 }] } }],
    ['revise', { ...revise, link: { edges: [{ ...revise.link.edges[0], type: 'supports' }] } }],
    ['revise', { ...revise, link: { edges: [{ ...revise.link.edges[0], heading: 'Target', block: 'anchor' }] } }],
    ['revise', { ...revise, link: { edges: Array(5).fill(revise.link.edges[0]) } }],
  ]) {
    const result = command(f, name, input); assert.equal(result.status, 1, JSON.stringify({ name, input, output: result.value }));
    assert.equal(result.value.ok, false); assert.equal(typeof result.value.error.code, 'string'); assert.equal(typeof result.value.error.message, 'string'); assert.ok(Array.isArray(result.value.error.paths));
  }
  assert.deepEqual(snapshot(f.temporary), before);
});

test('stage 4 actual revise link and relate commands publish version two and batch undo restores exact bytes', t => {
  const f = writerFixture(t); const original = Buffer.from('Authored source.\r\n'); put(f, 'Source.md', original); put(f, 'Target.md', '# Target\n'); baseline(f, ['Source.md', 'Target.md', 'Other.md']);
  const authorization = { origin: 'operator', request: 'Add the named relationships.' };
  const common = { vault: f.vault.id, batch: 'contract-edges', authorization, path: 'Source.md' };
  for (const [operation, fields] of [['link', { link: { edges: [{ targetNotePath: 'Target.md', rationale: 'Named by the operator.' }] } }], ['relate', { relate: { target: 'Target.md', relation: 'supports' } }]]) {
    const input = { ...common, requestId: `contract-${operation}`, operation, revision: revision(readFileSync(path.join(f.vault.path, 'Source.md'))), ...fields };
    const before = snapshot(f.temporary); const preview = command(f, 'revise', { ...input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview.value)); assert.equal(preview.value.outcome, 'preview'); assert.ok(preview.value[operation]); assert.deepEqual(snapshot(f.temporary), before);
    const written = command(f, 'revise', { ...input, planHash: preview.value.planHash }); assert.equal(written.status, 0, JSON.stringify(written.value)); assert.equal(written.value.ok, true); assert.ok(written.value.commit.oid);
    assert.equal(readRecord(f.directory, f.vault, written.value.operationId).version, 2);
    const retry = command(f, 'revise', { ...input, planHash: preview.value.planHash }); assert.equal(retry.status, 0, JSON.stringify(retry.value)); assert.equal(retry.value.operationId, written.value.operationId);
  }
  const inverse = { vault: f.vault.id, requestId: 'contract-inverse', batch: 'contract-undo', authorization, targetBatch: 'contract-edges' };
  const preview = command(f, 'undo', { ...inverse, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview.value));
  const result = command(f, 'undo', { ...inverse, planHash: preview.value.planHash }); assert.equal(result.status, 0, JSON.stringify(result.value)); assert.deepEqual(readFileSync(path.join(f.vault.path, 'Source.md')), original);
});

test('stage 4 configuration opt-in stays per vault and status redacts the global future embedding configuration', t => {
  const f = writerFixture(t); put(f, 'Source.md', 'Authored evidence.\n');
  assert.equal(readConfig(f.directory).vaults[0].embeddings, false);
  const embeddings = { baseUrl: 'https://fixture.invalid/private/v1', model: 'private-model', dimension: 8, maxInputBytes: 1600, responseModel: 'private-response', apiKey: 'fixture-not-a-real-secret' };
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, embeddings, vaults: [{ ...f.vault, embeddings: true }] });
  const root = path.dirname(indexPath(f.directory, f.vault)); mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, `vectors.${'a'.repeat(64)}.1.i8`), Buffer.alloc(7)); writeFileSync(path.join(root, `vectors.${'b'.repeat(64)}.2.i8`), Buffer.alloc(11));
  const before = snapshot(f.temporary);
  for (const [name, input] of [['candidates', { vault: f.vault.id, source: 'Source.md', revision: revision('Authored evidence.\n') }], ['search', { query: 'evidence', mode: 'semantic' }], ['refresh', { tier: 'embed' }], ['status', {}]]) {
    const result = command(f, name, input); assert.equal(result.status, 0, JSON.stringify(result.value));
    const text = JSON.stringify(result.value); for (const privateValue of Object.values(embeddings).filter(value => typeof value === 'string')) assert.equal(text.includes(privateValue), false, name);
    if (name === 'status') { assert.equal(result.value.vaults[0].embeddings, true); assert.deepEqual(result.value.vaults[0].embedding, off); assert.equal(result.value.vaults[0].retainedPackBytes, 18); }
  }
  const runtime = statusSnapshot(f.directory, { runtime: true }); assert.equal(runtime.vaults[0].retainedPackBytes, 18); assert.deepEqual(runtime.vaults[0].embedding, off);
  assert.deepEqual(snapshot(f.temporary), before);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, embeddings }] });
  assert.throws(() => readConfig(f.directory), /embeddings setting must be a boolean/);
});

test('stage 4 structural refresh retains its default behavior and reports the frozen embedding fields', t => {
  const f = writerFixture(t); put(f, 'Source.md', 'Authored evidence.\n'); const before = snapshot(f.vault.path);
  for (const input of [{}, { tier: 'structural', budgetMs: 1000 }, { tier: 'structural', force: true, budgetMs: 240000 }]) {
    const result = command(f, 'refresh', input); assert.equal(result.status, 0, JSON.stringify(result.value)); assert.equal(result.value.tier, 'structural'); assert.equal(result.value.scanned, 1); assert.equal(result.value.reason, null); assert.deepEqual(result.value.embedding, { ...off, embeddedThisCall: 0, failedBatches: 0, remaining: 0 });
  }
  assert.deepEqual(snapshot(f.vault.path), before);
});
