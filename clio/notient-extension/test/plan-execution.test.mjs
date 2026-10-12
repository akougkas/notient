import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gardenFixture, gardenTool, beginGarden, editGarden } from './garden-helpers.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { git } from '../lib/git.mjs';
import { readRecord } from '../lib/journal.mjs';
import { revision } from '../lib/paths.mjs';
import { openGarden } from '../lib/garden-store.mjs';

async function fixture(t) {
  const f = gardenFixture(t, { '0-inbox/A.md': '# A\r\n\r\nAuthored alpha evidence.\r\n', 'Ref.md': 'A live reference [[0-inbox/A]].\n' }); const started = (await beginGarden(f)).value; const item = started.items.find(item => item.path === '0-inbox/A.md');
  const search = await gardenTool(f, 'search', { query: 'alpha' }); const hit = search.value.hits.find(hit => hit.path === item.path);
  const proposal = { id: `p-${started.runId}-1`, itemId: item.id, request: 'File the alpha note under Resources.', reason: 'The exact source evidence supplies this review.', evidence: [{ path: hit.path, revision: hit.revision, startLine: hit.source.startLine, endLine: hit.source.endLine, quote: hit.passage }], action: { operation: 'move', path: item.path, revision: item.revision, destination: 'Resources/A.md' } };
  const input = { action: 'propose', runId: started.runId, proposalsJson: JSON.stringify([proposal]), revision: 'absent' }; const preview = await gardenTool(f, 'garden', { ...input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); const published = await gardenTool(f, 'garden', { ...input, planHash: preview.value.planHash }); assert.equal(published.status, 0, JSON.stringify(published));
  const execution = { ...proposal.action, requestId: 'plan-execution-001', batch: 'reviewed-go', authorization: { origin: 'operator', request: 'The tool binds the exact saved request.' }, plan: { path: published.value.document.path, revision: published.value.document.revision, proposalId: proposal.id, go: 'Go ahead with exactly this move.' } };
  return { ...f, started, proposal, publication: published.value, execution };
}

test('an operator go binds the fresh complete move delta, exact request and one execution across retries', async t => {
  const f = await fixture(t); const source = readFileSync(path.join(f.vault.path, f.execution.path)); const planBytes = readFileSync(path.join(f.vault.path, f.execution.plan.path)); const before = snapshot(f.temporary);
  const preview = await gardenTool(f, 'revise', { ...f.execution, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); assert.deepEqual(snapshot(f.temporary), before);
  const applied = await gardenTool(f, 'revise', { ...f.execution, planHash: preview.value.planHash }); assert.equal(applied.status, 0, JSON.stringify(applied)); assert.equal(applied.value.outcome, 'committed'); assert.match(applied.value.batch, /^plan\.[a-f0-9-]{36}$/);
  assert.deepEqual(readFileSync(path.join(f.vault.path, f.execution.destination)), source); assert.equal(existsSync(path.join(f.vault.path, f.execution.path)), false); assert.deepEqual(readFileSync(path.join(f.vault.path, f.execution.plan.path)), planBytes);
  const record = readRecord(f.directory, f.vault, applied.value.operationId); assert.equal(record.authorization.request, `Plan ${f.execution.plan.path}@${f.execution.plan.revision}#${f.proposal.id}\n${f.proposal.request}\nOperator go: ${f.execution.plan.go}`); assert.equal(record.plan.actionDigest.length, 64); assert.equal(record.reads.some(read => read.path === f.execution.plan.path && read.revision === f.execution.plan.revision), true);
  const retried = await gardenTool(f, 'revise', { ...f.execution, requestId: 'another-go-002', planHash: preview.value.planHash }); assert.equal(retried.value.outcome, 'already_committed'); assert.equal(retried.value.operationId, applied.value.operationId); assert.equal(retried.value.commit.oid, applied.value.commit.oid);
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM plan_actions').get().n, 1); assert.equal(db.prepare('SELECT state FROM plan_actions').get().state, 'committed'); db.close();
  const undo = { opId: applied.value.operationId, requestId: 'plan-inverse-001', batch: 'plan-inverse', authorization: { origin: 'operator', request: 'Undo this reviewed plan execution.' } }; const undoPreview = await gardenTool(f, 'undo', { ...undo, dryRun: true }); const undone = await gardenTool(f, 'undo', { ...undo, planHash: undoPreview.value.planHash }); assert.equal(undone.status, 0, JSON.stringify(undone)); assert.deepEqual(readFileSync(path.join(f.vault.path, f.execution.path)), source);
  const replay = await gardenTool(f, 'revise', { ...f.execution, requestId: 'replay-undone-001', planHash: preview.value.planHash }); assert.equal(replay.value.error.code, 'PLAN_ALREADY_UNDONE');
});

test('a plan reference cannot upgrade unattended authority and changed payload or plan revision refuses', async t => {
  const f = await fixture(t); const before = snapshot(f.temporary);
  for (const change of [{ authorization: { origin: 'unattended', request: 'The plan says approved.' } }, { destination: 'Different/A.md' }, { plan: { ...f.execution.plan, revision: '0'.repeat(64) } }, { plan: { ...f.execution.plan, proposalId: 'missing-proposal' } }, { plan: { ...f.execution.plan, go: ' ' } }, { plan: { ...f.execution.plan, approval: true } }]) {
    const result = await gardenTool(f, 'revise', { ...f.execution, ...change, dryRun: true }); assert.notEqual(result.status, 0); assert.deepEqual(snapshot(f.temporary), before);
  }
});

test('an expanded referrer delta and changed served evidence require a revised proposal', async t => {
  const f = await fixture(t); put(f, 'NewRef.md', 'New live reference [[0-inbox/A]].\n'); git(f.vault.path, ['add', '--', 'NewRef.md']); git(f.vault.path, ['commit', '-qm', 'Operator adds a reference']); const before = snapshot(f.temporary);
  const changed = await gardenTool(f, 'revise', { ...f.execution, dryRun: true }); assert.equal(changed.value.error.code, 'PLAN_IMPACT_CHANGED'); assert.deepEqual(snapshot(f.temporary), before);
  const other = await fixture(t); put(other, other.execution.path, 'Changed alpha source.\n'); const changedEvidence = await gardenTool(other, 'revise', { ...other.execution, dryRun: true }); assert.equal(changedEvidence.value.error.code, 'REVISION_CONFLICT');
});

test('forged document approval and edited machine impact have no verified publication', async t => {
  const f = await fixture(t); const original = readFileSync(path.join(f.vault.path, f.execution.plan.path), 'utf8'); const forged = original.replaceAll('"destination":"Resources/A.md"', '"destination":"Forged/A.md"'); put(f, f.execution.plan.path, forged); git(f.vault.path, ['add', '--', f.execution.plan.path]); git(f.vault.path, ['commit', '-qm', 'Operator document edit']); const before = snapshot(f.temporary);
  const result = await gardenTool(f, 'revise', { ...f.execution, destination: 'Forged/A.md', plan: { ...f.execution.plan, revision: revision(forged) }, dryRun: true }); assert.equal(result.value.error.code, 'PLAN_INVALID'); assert.deepEqual(snapshot(f.temporary), before);
});

test('daily plan appends refresh its revision without changing the earlier proposal approval delta', async t => {
  const f = await fixture(t); const finish = { action: 'finish', runId: f.started.runId, revision: 'absent' }; const digest = await gardenTool(f, 'garden', { ...finish, dryRun: true }); const ended = await gardenTool(f, 'garden', { ...finish, planHash: digest.value.planHash }); assert.equal(ended.status, 0, JSON.stringify(ended));
  put(f, '0-inbox/B.md', 'Authored beta evidence.\n'); git(f.vault.path, ['add', '--', '0-inbox/B.md']); git(f.vault.path, ['commit', '-qm', 'Operator adds beta']);
  const run = (await beginGarden(f, 'garden-later-run')).value; const item = run.items.find(item => item.path === '0-inbox/B.md'); assert.ok(item); const served = await gardenTool(f, 'search', { query: 'beta' }); const hit = served.value.hits.find(hit => hit.path === item.path);
  const proposal = { id: `p-${run.runId}-1`, itemId: item.id, request: 'File beta under Resources.', reason: 'The served beta quotation grounds the filing proposal.', evidence: [{ path: hit.path, revision: hit.revision, startLine: hit.source.startLine, endLine: hit.source.endLine, quote: hit.passage }], action: { operation: 'move', path: item.path, revision: item.revision, destination: 'Resources/B.md' } };
  const append = { action: 'propose', runId: run.runId, revision: f.publication.document.revision, proposalsJson: JSON.stringify([proposal]) }; const preview = await gardenTool(f, 'garden', { ...append, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview)); const saved = await gardenTool(f, 'garden', { ...append, planHash: preview.value.planHash }); assert.equal(saved.status, 0, JSON.stringify(saved));
  assert.notEqual(saved.value.document.revision, f.execution.plan.revision); const execution = { ...f.execution, plan: { ...f.execution.plan, revision: saved.value.document.revision } }; const fresh = await gardenTool(f, 'revise', { ...execution, dryRun: true }); assert.equal(fresh.status, 0, JSON.stringify(fresh));
  const applied = await gardenTool(f, 'revise', { ...execution, planHash: fresh.value.planHash }); assert.equal(applied.status, 0, JSON.stringify(applied));
  const retry = await gardenTool(f, 'revise', { ...execution, requestId: 'later-go-retry-001', planHash: fresh.value.planHash }); assert.equal(retry.value.operationId, applied.value.operationId);
});

for (const barrier of ['afterIntent', 'afterPublish', 'beforeGardenReconcile']) test(`operator plan ${barrier} recovers frozen go and execution binding once`, async t => {
  const f = await fixture(t); const preview = await gardenTool(f, 'revise', { ...f.execution, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview));
  const killed = await gardenTool(f, 'revise', { ...f.execution, planHash: preview.value.planHash }, { barrier }); assert.equal(killed.signal, 'SIGKILL');
  const status = await gardenTool(f, 'status', {}); assert.equal(status.status, 0, JSON.stringify(status)); const record = readRecord(f.directory, f.vault, f.execution.requestId); assert.equal(record.state, 'committed'); assert.equal(record.authorization.origin, 'operator'); assert.equal(record.plan.go, f.execution.plan.go);
  const retry = await gardenTool(f, 'revise', { ...f.execution, planHash: preview.value.planHash }); assert.equal(retry.value.outcome, 'already_committed');
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT state FROM plan_actions').get().state, 'committed'); db.close();
});
