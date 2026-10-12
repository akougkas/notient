import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gardenFixture, gardenTool, beginGarden, editGarden } from './garden-helpers.mjs';
import { put, snapshot } from './write-helpers.mjs';
import { openGarden, gardenPath } from '../lib/garden-store.mjs';
import { indexPath, atomicJson } from '../lib/config.mjs';
import { openIndex } from '../lib/index.mjs';

test('garden begin freezes three leases, idempotent enqueue and independent concurrent claims', async t => {
  const f = gardenFixture(t, Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`0-inbox/N${i}.md`, `Authored evidence ${i}.\n`]))); const before = snapshot(f.vault.path);
  const [a, b] = await Promise.all([beginGarden(f, 'garden-concurrent-a'), beginGarden(f, 'garden-concurrent-b')]);
  assert.equal(a.status, 0, JSON.stringify(a)); assert.equal(b.status, 0, JSON.stringify(b)); assert.deepEqual([a.value.state, b.value.state].sort(), ['active', 'busy']);
  const active = [a, b].find(result => result.value.state === 'active'); assert.equal(active.value.items.length, 3); assert.equal(active.value.queue.queued, 1);
  const retry = await beginGarden(f, active.value.runId); assert.deepEqual(retry.value.items, active.value.items); assert.equal(retry.value.queue.leased, 3);
  assert.deepEqual(snapshot(f.vault.path), before);
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT count(*) AS n FROM queue').get().n, 4); assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 1); db.close();
  const changedRequest = await gardenTool(f, 'garden', { action: 'begin', runId: active.value.runId, request: 'Different request' }); assert.equal(changedRequest.value.error.code, 'REQUEST_ID_REUSED');
});

test('expired attempts are claimed once, stale tokens refuse and the fifth expiry poisons without reset', async t => {
  const f = gardenFixture(t); let old;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const started = await beginGarden(f, `garden-attempt-${attempt}`); assert.equal(started.value.items[0].attempt, attempt); old ??= started.value.items[0];
    if (attempt > 1) {
      const stale = await gardenTool(f, 'garden', { action: 'settle', runId: 'garden-attempt-1', itemId: old.id, leaseToken: old.leaseToken, outcome: 'complete', operationIds: [], reason: 'Unchanged' }); assert.notEqual(stale.status, 0);
    }
    editGarden(f, db => { db.exec("UPDATE runs SET leaseUntil=0; UPDATE queue SET leaseUntil=0 WHERE state='leased'"); });
  }
  const poisoned = await beginGarden(f, 'garden-attempt-6'); assert.equal(poisoned.value.items.length, 0); assert.equal(poisoned.value.queue.poison, 1);
  const db = openGarden(f.directory, f.vault); assert.equal(db.prepare('SELECT attempts FROM queue').get().attempts, 5); db.close();
});

test('no-change settlement is idempotent, changed sources skip, and made-up operations cannot complete', async t => {
  const f = gardenFixture(t); const started = await beginGarden(f); const item = started.value.items[0];
  const input = { action: 'settle', runId: started.value.runId, itemId: item.id, leaseToken: item.leaseToken, outcome: 'complete', operationIds: [], reason: 'No evidence supports another change.' };
  const fake = await gardenTool(f, 'garden', { ...input, operationIds: ['invented-operation'] }); assert.equal(fake.value.error.code, 'GARDEN_ACTION_INVALID');
  const complete = await gardenTool(f, 'garden', input); assert.equal(complete.value.state, 'complete'); const retry = await gardenTool(f, 'garden', input); assert.deepEqual(retry.value, complete.value);
  editGarden(f, db => { db.exec("UPDATE runs SET leaseUntil=0,state='interrupted'"); });
  put(f, item.path, 'Changed source revision.\n');
  const next = await beginGarden(f, 'garden-changed-001'); assert.equal(next.value.items.length, 1); assert.notEqual(next.value.items[0].id, item.id);
  put(f, item.path, 'An additional operator save.\n');
  const skip = await gardenTool(f, 'garden', { ...input, runId: next.value.runId, itemId: next.value.items[0].id, leaseToken: next.value.items[0].leaseToken }); assert.equal(skip.value.state, 'skipped');
});

test('bounded structural continuation records its cursor and cannot lease incomplete coverage', async t => {
  const f = gardenFixture(t, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`N${String(i).padStart(2, '0')}.md`, `Evidence ${i}.\n`])));
  const first = await beginGarden(f); assert.equal(first.value.state, 'deferred'); assert.equal(first.value.deterministic.structural.hashed, 50); assert.equal(first.value.items.length, 0); assert.equal(first.value.deterministic.structural.remaining, 1);
  const db = openIndex(f.directory, f.vault); const cursor = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='gardenScan'").get().value); assert.equal(cursor.remaining, 1); assert.equal(typeof cursor.cursor, 'string'); db.close();
  editGarden(f, db => { db.exec("UPDATE runs SET leaseUntil=0,state='interrupted'"); });
  const next = await beginGarden(f, 'garden-scan-next'); assert.equal(next.value.state, 'active'); assert.equal(next.value.deterministic.structural.hashed, 1); assert.equal(next.value.items.length, 3);
});

test('index rebuild preserves queue history and excludes reports, conventions and visitor-only notes', async t => {
  const f = gardenFixture(t, { 'A.md': 'Authored alpha.\n', 'Notient/Conventions.md': 'Conventions prose.\n', 'Notient/Plans/2026-10-01.md': 'Generated prose.\n', 'Notient/Digest/2026-10-01.md': 'Generated prose.\n', 'Visitor.md': '<!-- notient:start -->\nVisitor only.\n<!-- notient:end -->\n' });
  const first = await beginGarden(f); assert.deepEqual(first.value.items.map(item => item.path), ['A.md']); const bytes = readFileSync(gardenPath(f.directory, f.vault));
  unlinkSync(indexPath(f.directory, f.vault)); const retry = await beginGarden(f); assert.deepEqual(retry.value.items, first.value.items); assert.deepEqual(readFileSync(gardenPath(f.directory, f.vault)), bytes);
});

test('missing FTS5 defers before leasing and performs no model or vault write', async t => {
  const f = gardenFixture(t); const before = snapshot(f.vault.path); const loader = path.join(f.temporary, 'no-fts.mjs');
  writeFileSync(loader, "import { DatabaseSync } from 'node:sqlite'; const exec=DatabaseSync.prototype.exec; DatabaseSync.prototype.exec=function(sql){if(sql==='CREATE VIRTUAL TABLE temp.x USING fts5(a)')throw new Error('fixture unavailable');return exec.call(this,sql)};");
  const result = await gardenTool(f, 'garden', { action: 'begin', runId: 'garden-no-fts-001', request: 'Review this fixture' }, { imports: [loader] });
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.value.state, 'deferred'); assert.equal(result.value.coverage.state, 'unknown'); assert.equal(result.value.items.length, 0); assert.equal(result.value.queue.leased, 0); assert.deepEqual(snapshot(f.vault.path), before);
});

test('read-only, registration, deadline, capacity and foreign action fields refuse through the command', async t => {
  const f = gardenFixture(t); const first = await beginGarden(f); const item = first.value.items[0];
  editGarden(f, db => { db.exec('UPDATE runs SET deadline=0'); });
  const late = await gardenTool(f, 'garden', { action: 'settle', runId: first.value.runId, itemId: item.id, leaseToken: item.leaseToken, outcome: 'complete', operationIds: [], reason: 'Late' }); assert.equal(late.value.error.code, 'GARDEN_RUN_EXPIRED');
  const foreign = await gardenTool(f, 'garden', { action: 'begin', request: 'Review', reason: 'Foreign' }); assert.equal(foreign.value.error.code, 'INVALID_INPUT');
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, readOnly: true }] }); const before = snapshot(f.temporary); const refused = await beginGarden(f, 'garden-read-only'); assert.equal(refused.value.error.code, 'READ_ONLY_VAULT'); assert.deepEqual(snapshot(f.temporary), before);
  atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [] }); const absent = await beginGarden(f); assert.equal(absent.status, 0); assert.equal(absent.value.configured, false);
});

test('retained run and queue capacity refuse without dropping history', async t => {
  for (const table of ['runs', 'queue']) {
    const f = gardenFixture(t); await beginGarden(f);
    editGarden(f, db => {
      db.exec("UPDATE runs SET state='interrupted',leaseUntil=0; UPDATE queue SET state='complete'");
      if (table === 'runs') db.exec("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<9999) INSERT INTO runs SELECT 'capacity.'||n,vault,startedAt,deadline,0,'interrupted',batch,request,inputDigest,limits,counters,deterministicJson,resultJson FROM seq,runs WHERE id='garden-fixture-001'");
      else db.exec("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<9999) INSERT INTO queue SELECT printf('%064x',n),path,revision,NULL,kind,policyVersion,enqueuedAt,'complete',attempts,NULL,NULL,runId,NULL,NULL FROM seq,queue WHERE runId='garden-fixture-001'");
    });
    if (table === 'queue') put(f, 'New.md', 'New eligible prose.\n');
    const before = snapshot(f.vault.path); const refused = await beginGarden(f, 'garden-at-capacity'); assert.equal(refused.value.error.code, 'GARDEN_CAPACITY'); assert.deepEqual(snapshot(f.vault.path), before);
    const db = openGarden(f.directory, f.vault); assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 10000); db.close();
  }
});

test('a promotion epoch advances once even when begin is retried after its result was lost', async t => {
  const f = gardenFixture(t); await gardenTool(f, 'refresh', {});
  const db = openIndex(f.directory, f.vault, true); db.exec("UPDATE note_vitals SET maturity='raw'"); db.close();
  const first = await beginGarden(f); assert.equal(first.value.deterministic.vitals.promoted, 1);
  editGarden(f, db => { db.exec('UPDATE runs SET resultJson=NULL,deterministicJson=NULL'); });
  const retried = await beginGarden(f); assert.equal(retried.value.deterministic.vitals.promoted, 1); assert.deepEqual(retried.value.items, first.value.items); assert.deepEqual(retried.value.deterministic, first.value.deterministic);
  const index = openIndex(f.directory, f.vault); assert.equal(index.prepare('SELECT maturity FROM note_vitals').get().maturity, 'adolescent'); index.close();
});

test('begin SIGKILL after its deterministic checkpoint reuses the same index generation and claims once', async t => {
  const f = gardenFixture(t); const input = { action: 'begin', runId: 'garden-tick-interrupt', request: 'Review the fixture once.' };
  const killed = await gardenTool(f, 'garden', input, { barrier: 'afterGardenTick' }); assert.equal(killed.signal, 'SIGKILL');
  let db = openIndex(f.directory, f.vault); const generation = db.prepare("SELECT value FROM meta WHERE key='indexGeneration'").get().value; db.close();
  const resumed = await gardenTool(f, 'garden', input); assert.equal(resumed.status, 0, JSON.stringify(resumed)); assert.equal(resumed.value.items.length, 1); assert.equal(resumed.value.items[0].attempt, 1);
  db = openIndex(f.directory, f.vault); assert.equal(db.prepare("SELECT value FROM meta WHERE key='indexGeneration'").get().value, generation); db.close();
});

test('vitals visits at most fifty notes per run in descending word order and continues its retained cycle', async t => {
  const f = gardenFixture(t, Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`N${String(i).padStart(3, '0')}.md`, 'word '.repeat(i + 1) + '\n']))); await gardenTool(f, 'refresh', {});
  const db = openIndex(f.directory, f.vault, true); db.exec("UPDATE note_vitals SET maturity='raw'"); db.close();
  for (const [ordinal, expected] of [[1, 50], [2, 50], [3, 10]]) {
    const run = await beginGarden(f, `garden-vitals-${ordinal}`); assert.equal(run.status, 0, JSON.stringify(run)); assert.equal(run.value.deterministic.vitals.promoted, expected);
    const index = openIndex(f.directory, f.vault); const epoch = JSON.parse(index.prepare("SELECT value FROM meta WHERE key='gardenPromotions'").get().value); assert.equal(epoch.paths.length, expected); if (ordinal === 1) assert.deepEqual(epoch.paths, Array.from({ length: 50 }, (_, i) => `N${String(109 - i).padStart(3, '0')}.md`).reverse()); index.close();
    editGarden(f, db => { db.exec("UPDATE runs SET state='interrupted',leaseUntil=0; UPDATE queue SET leaseUntil=0 WHERE state='leased'"); });
  }
  const index = openIndex(f.directory, f.vault); assert.equal(index.prepare("SELECT count(*) AS n FROM note_vitals WHERE maturity='adolescent'").get().n, 110); index.close();
});
