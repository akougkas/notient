import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { gardenFixture, gardenTool } from './garden-helpers.mjs';
import { revision } from '../lib/paths.mjs';
import { beginGarden } from './garden-helpers.mjs';
import { gardenPath } from '../lib/garden-store.mjs';
import { readRecord } from '../lib/journal.mjs';

test('G1 no vault state is read after the final revision check and before rename', async t => {
  const f = gardenFixture(t, { 'A.md': 'Authored source.\n', 'T.md': 'Target evidence.\n' });
  const entry = path.join(f.temporary, 'g1-command.mjs'); const target = path.join(f.vault.path, 'A.md');
  writeFileSync(entry, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; let checked=false; let reads=0; const root=${JSON.stringify(f.vault.path)}; for(const name of ['readdirSync','lstatSync','readFileSync','openSync']){const original=fs[name];fs[name]=function(filename,...args){if(checked&&typeof filename==='string'&&filename.startsWith(root))reads++;return original.call(this,filename,...args)}} const rename=fs.renameSync;fs.renameSync=function(...args){checked=false;return rename.apply(this,args)};syncBuiltinESMExports();const {runCommand}=await import(${JSON.stringify(new URL('../lib/command.mjs', import.meta.url).href)});const {writeOperation}=await import(${JSON.stringify(new URL('../lib/write.mjs', import.meta.url).href)});await runCommand('revise', input=>{const result=writeOperation('revise',input,{observe(name,record,file){if(name==='afterRecheck'&&file.path==='A.md')checked=true}});return {...result,fixtureReads:reads}});`);
  const { spawnSync } = await import('node:child_process');
  const input = { vault: f.vault.id, path: 'A.md', revision: revision(readFileSync(target)), operation: 'link', link: { edges: [{ targetNotePath: 'T.md', rationale: 'Append this named target.' }] }, authorization: { origin: 'unattended', request: 'Append the target without modifying authored prose.' }, batch: 'g1-fixture', requestId: 'g1-write-001' };
  const child = spawnSync(process.execPath, [entry, JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } }); const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.fixtureReads, 0);
});

test('G3 an export failure after publication returns a committed result with pending garden reconciliation', async t => {
  const f = gardenFixture(t); const run = (await beginGarden(f)).value;
  for (const item of run.items) await gardenTool(f, 'garden', { action: 'settle', runId: run.runId, itemId: item.id, leaseToken: item.leaseToken, outcome: 'complete', reason: 'No change is warranted.', operationIds: [] });
  const input = { action: 'finish', runId: run.runId, revision: 'absent' }; const preview = await gardenTool(f, 'garden', { ...input, dryRun: true }); assert.equal(preview.status, 0, JSON.stringify(preview));
  const directory = path.join(path.dirname(gardenPath(f.directory, f.vault)), 'garden-runs', run.runId); mkdirSync(directory, { recursive: true }); mkdirSync(path.join(directory, 'result.json'));
  const result = await gardenTool(f, 'garden', { ...input, planHash: preview.value.planHash });
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.value.ok, true); assert.equal(result.value.outcome, 'committed'); assert.ok(result.value.commit.oid); assert.equal(result.value.gardenReconciliation.state, 'pending');
  const record = readRecord(f.directory, f.vault, `${run.runId}.digest`); assert.equal(record.state, 'committed'); assert.equal(record.gardenReconciliation.state, 'pending');
});

test('G3 a held garden writer after publication cannot turn success into a refusal', async t => {
  const f = gardenFixture(t); const run = (await beginGarden(f)).value;
  for (const item of run.items) await gardenTool(f, 'garden', { action: 'settle', runId: run.runId, itemId: item.id, leaseToken: item.leaseToken, outcome: 'complete', reason: 'No further change.', operationIds: [] });
  const input = { action: 'finish', runId: run.runId, revision: 'absent' }; const preview = await gardenTool(f, 'garden', { ...input, dryRun: true });
  const entry = path.join(f.temporary, 'g3-lock-command.mjs');
  writeFileSync(entry, `import {runCommand} from ${JSON.stringify(new URL('../lib/command.mjs', import.meta.url).href)};import {gardenCommand} from ${JSON.stringify(new URL('../lib/garden.mjs', import.meta.url).href)};import {DatabaseSync} from 'node:sqlite';let lock;await runCommand('garden',input=>{try{return gardenCommand(input,{barrier(name){if(name==='afterCommitted'){lock=new DatabaseSync(${JSON.stringify(gardenPath(f.directory, f.vault))});lock.exec("PRAGMA journal_mode=WAL;PRAGMA cache_size=1;BEGIN IMMEDIATE;UPDATE runs SET request=request||' locked';WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100) INSERT INTO owned SELECT 'lock-'||n,NULL FROM seq");}}})}finally{lock?.exec('ROLLBACK');lock?.close()}});`);
  const { spawnSync } = await import('node:child_process'); const child = spawnSync(process.execPath, [entry, JSON.stringify({ vault: f.vault.id, ...input, planHash: preview.value.planHash })], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } }); const result = JSON.parse(child.stdout);
  assert.equal(child.status, 0, JSON.stringify(result)); assert.equal(result.ok, true); assert.equal(result.outcome, 'committed'); assert.equal(result.gardenReconciliation.state, 'pending');
});
