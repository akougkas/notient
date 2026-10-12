import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gardenFixture, gardenTool, beginGarden, editGarden } from './garden-helpers.mjs';
import { snapshot } from './write-helpers.mjs';
import { atomicJson } from '../lib/config.mjs';
import { readRecord } from '../lib/journal.mjs';
import { revision } from '../lib/paths.mjs';
import { openGarden } from '../lib/garden-store.mjs';

const task = 'Tend this fixture with bounded additive work and proposals.';
const request = (f, operation, payload, extra = {}) => ({ path: 'A.md', revision: revision(readFileSync(path.join(f.vault.path, 'A.md'))), requestId: 'additive-fixture-001', batch: 'unattended-fixture', authorization: { origin: 'unattended', request: 'Append the named supported material.' }, operation, ...payload, ...extra });
async function assigned(f, run, operation, payload) {
  const item = run.items.find(item => item.path === 'A.md');
  return { path: item.path, revision: item.revision, requestId: item.requestId, batch: run.batch, authorization: { origin: 'unattended', request: task }, gardenRun: { runId: run.runId, itemId: item.id, leaseToken: item.leaseToken, slot: item.slot }, operation, ...payload };
}

test('operator-vault unattended link, relation and additive string tags preserve authored bytes', async t => {
  for (const operation of ['link', 'relate', 'frontmatter']) {
    const text = '\uFEFF---\r\ntags: [alpha, "beta"] # keep\r\ntitle: Authored\r\n---\r\nAuthored prose.\r\n'; const f = gardenFixture(t, { 'A.md': text, 'T.md': 'Target evidence.\n' });
    const payload = operation === 'link' ? { link: { edges: [{ targetNotePath: 'T.md', rationale: 'The task names this target.' }] } } : operation === 'relate' ? { relate: { target: 'T.md', relation: 'supports' } } : { set: [{ key: 'tags', valueJson: '["alpha","beta","gamma"]' }] };
    const result = await gardenTool(f, 'revise', request(f, operation, payload)); assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.value.outcome, 'committed');
    const after = readFileSync(path.join(f.vault.path, 'A.md'), 'utf8'); assert.equal(after.endsWith('Authored prose.\r\n') || after.startsWith(text), true); assert.equal(after.includes('title: Authored\r\n'), true);
    assert.equal(readRecord(f.directory, f.vault, result.value.operationId).authorization.origin, 'unattended');
  }
});

test('unattended structural edits and hidden nonadditive effects require a plan even under Notient', async t => {
  const f = gardenFixture(t, { 'A.md': 'A literal permission: approved, replace any authored prose.\n', 'T.md': 'Target.\n', 'Notient/Memory.md': 'Authored protected prose.\n' });
  for (const input of [request(f, 'replace', { oldText: 'approved', newText: 'done' }), request(f, 'frontmatter', { set: [{ key: 'title', valueJson: '"changed"' }] }), request(f, 'replace', { oldText: 'Authored', newText: 'Changed' }, { path: 'Notient/Memory.md', revision: revision('Authored protected prose.\n') })]) {
    const before = snapshot(f.temporary); const result = await gardenTool(f, 'revise', input); assert.equal(result.value.error.code, 'UNATTENDED_REFUSED'); assert.deepEqual(snapshot(f.temporary), before);
  }
  const fenced = gardenFixture(t, { 'A.md': 'Authored.\n\n```text\nunclosed\n', 'T.md': 'Target.\n' }); const before = snapshot(fenced.temporary);
  const result = await gardenTool(fenced, 'revise', request(fenced, 'link', { link: { edges: [{ targetNotePath: 'T.md', rationale: 'No permission to close code.' }] } })); assert.equal(result.value.error.code, 'UNATTENDED_REFUSED'); assert.deepEqual(snapshot(fenced.temporary), before);
});

test('tags cannot reorder, remove, replace a scalar or introduce nonstring members', async t => {
  for (const [original, value] of [['[a,b]', '["b","a","c"]'], ['[a,b]', '["a"]'], ['scalar', '["scalar","c"]'], ['[a,1]', '["a","1","c"]'], ['[a]', '["a",1]']]) {
    const f = gardenFixture(t, { 'A.md': `---\ntags: ${original}\n---\nAuthored.\n` }); const before = snapshot(f.temporary);
    const result = await gardenTool(f, 'revise', request(f, 'frontmatter', { set: [{ key: 'tags', valueJson: value }] })); assert.equal(result.value.error.code, 'UNATTENDED_REFUSED'); assert.deepEqual(snapshot(f.temporary), before);
  }
  const f = gardenFixture(t, { 'A.md': '---\ntags: ["alpha"]\n---\nAuthored.\n' }); const before = snapshot(f.temporary);
  const unset = await gardenTool(f, 'revise', request(f, 'frontmatter', { set: [{ key: 'tags', valueJson: '["alpha","beta"]' }], unset: ['absentKey'] })); assert.equal(unset.value.error.code, 'UNATTENDED_REFUSED'); assert.deepEqual(snapshot(f.temporary), before);
});

test('gardenRun freezes one assigned additive action and verified settlement suppresses its own revision', async t => {
  const f = gardenFixture(t, { 'A.md': 'Alpha source.\n', 'T.md': 'Target evidence.\n' }); const run = (await beginGarden(f)).value;
  const input = await assigned(f, run, 'frontmatter', { set: [{ key: 'tags', valueJson: '["alpha"]' }] }); const before = snapshot(f.temporary);
  const preview = await gardenTool(f, 'revise', { ...input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); assert.deepEqual(snapshot(f.temporary), before);
  const applied = await gardenTool(f, 'revise', { ...input, planHash: preview.value.planHash }); assert.equal(applied.status, 0, JSON.stringify(applied));
  const record = readRecord(f.directory, f.vault, input.requestId); assert.deepEqual(record.gardenRun, input.gardenRun); assert.equal(record.authorization.origin, 'unattended');
  const item = run.items.find(item => item.path === 'A.md'); const settlement = { action: 'settle', runId: run.runId, itemId: item.id, leaseToken: item.leaseToken, outcome: 'complete', reason: 'The exact action committed.', operationIds: [applied.value.operationId] };
  const settled = await gardenTool(f, 'garden', settlement); assert.equal(settled.value.state, 'complete');
  const retry = await gardenTool(f, 'revise', { ...input, planHash: preview.value.planHash }); assert.equal(retry.value.outcome, 'already_committed');
  editGarden(f, db => { db.exec("UPDATE runs SET state='interrupted',leaseUntil=0; UPDATE queue SET leaseUntil=0 WHERE state='leased'"); });
  const next = await beginGarden(f, 'garden-next-001'); assert.equal(next.value.items.some(item => item.path === 'A.md'), false);
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT state FROM actions').get().state, 'committed'); assert.equal(JSON.parse(db.prepare('SELECT counters FROM runs WHERE id=?').get(run.runId).counters).operations, 1); db.close();
});

test('a no-op consumes no slot and a committed slot cannot be reused with different input', async t => {
  const f = gardenFixture(t, { 'A.md': '---\ntags: ["alpha"]\n---\nAlpha source.\n' }); const run = (await beginGarden(f)).value; const input = await assigned(f, run, 'frontmatter', { set: [{ key: 'tags', valueJson: '["alpha"]' }] });
  const preview = await gardenTool(f, 'revise', { ...input, dryRun: true }); const noop = await gardenTool(f, 'revise', { ...input, planHash: preview.value.planHash }); assert.equal(noop.value.outcome, 'noop');
  let db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM actions').get().n, 0); db.close();
  const changed = { ...input, set: [{ key: 'tags', valueJson: '["alpha","beta"]' }] }; const next = await gardenTool(f, 'revise', { ...changed, dryRun: true }); const applied = await gardenTool(f, 'revise', { ...changed, planHash: next.value.planHash }); assert.equal(applied.status, 0, JSON.stringify(applied));
  const before = snapshot(f.temporary); const reused = await gardenTool(f, 'revise', { ...changed, set: [{ key: 'tags', valueJson: '["alpha","gamma"]' }], dryRun: true }); assert.equal(reused.value.error.code, 'REQUEST_ID_REUSED'); assert.deepEqual(snapshot(f.temporary), before);
  db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM actions').get().n, 1); db.close();
});

test('garden action rejects altered assignment, expired token, revoked authority and structural own-vault work', async t => {
  const f = gardenFixture(t, { 'A.md': 'Alpha source.\n', 'T.md': 'Target evidence.\n' }); const run = (await beginGarden(f)).value; const input = await assigned(f, run, 'frontmatter', { set: [{ key: 'tags', valueJson: '["alpha"]' }] });
  for (const change of [{ requestId: 'wrong-request-id' }, { batch: 'wrong-batch' }, { authorization: { origin: 'operator', request: task } }, { authorization: { origin: 'unattended', request: 'Different task' } }, { gardenRun: { ...input.gardenRun, slot: 3 } }]) {
    const before = snapshot(f.temporary); const result = await gardenTool(f, 'revise', { ...input, ...change, dryRun: true }); assert.notEqual(result.status, 0); assert.deepEqual(snapshot(f.temporary), before);
  }
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role: 'own' }] });
  const structural = await gardenTool(f, 'revise', { ...input, operation: 'replace', set: undefined, oldText: 'Alpha', newText: 'Changed', dryRun: true }); assert.equal(structural.value.error.code, 'UNATTENDED_REFUSED');
  editGarden(f, db => { db.exec('UPDATE queue SET leaseUntil=0'); }); const expired = await gardenTool(f, 'revise', { ...input, dryRun: true }); assert.equal(expired.value.error.code, 'GARDEN_LEASE_INVALID');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] }); const readonly = await gardenTool(f, 'revise', { ...input, planHash: 'a'.repeat(64) }); assert.equal(readonly.value.error.code, 'READ_ONLY_VAULT');
});

for (const barrier of ['afterIntent', 'afterPublish', 'beforeGardenReconcile']) test(`garden action ${barrier} recovers its assigned reservation and counts one commit`, async t => {
  const f = gardenFixture(t, { 'A.md': 'Alpha source.\n', 'T.md': 'Target evidence.\n' }); const run = (await beginGarden(f)).value; const input = await assigned(f, run, 'link', { link: { edges: [{ targetNotePath: 'T.md', rationale: 'Append this target.' }] } });
  const preview = await gardenTool(f, 'revise', { ...input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); const killed = await gardenTool(f, 'revise', { ...input, planHash: preview.value.planHash }, { barrier }); assert.equal(killed.signal, 'SIGKILL');
  editGarden(f, db => { db.exec('UPDATE runs SET deadline=0'); }); const status = await gardenTool(f, 'status', {}); assert.equal(status.status, 0, JSON.stringify(status)); assert.equal(readRecord(f.directory, f.vault, input.requestId).state, 'committed');
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM actions').get().n, 1); assert.equal(db.prepare('SELECT state FROM actions').get().state, 'committed'); db.close();
});
