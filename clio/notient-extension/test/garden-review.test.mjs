import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gardenFixture, gardenTool } from './garden-helpers.mjs';
import { revision } from '../lib/paths.mjs';

test('G1 no vault state is read after the final revision check and before rename', async t => {
  const f = gardenFixture(t, { 'A.md': 'Authored source.\n', 'T.md': 'Target evidence.\n' });
  const entry = path.join(f.temporary, 'g1-command.mjs'); const target = path.join(f.vault.path, 'A.md');
  writeFileSync(entry, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; let checked=false; let reads=0; const root=${JSON.stringify(f.vault.path)}; for(const name of ['readdirSync','lstatSync','readFileSync','openSync']){const original=fs[name];fs[name]=function(filename,...args){if(checked&&typeof filename==='string'&&filename.startsWith(root))reads++;return original.call(this,filename,...args)}} const rename=fs.renameSync;fs.renameSync=function(...args){checked=false;return rename.apply(this,args)};syncBuiltinESMExports();const {runCommand}=await import(${JSON.stringify(new URL('../lib/command.mjs', import.meta.url).href)});const {writeOperation}=await import(${JSON.stringify(new URL('../lib/write.mjs', import.meta.url).href)});await runCommand('revise', input=>{const result=writeOperation('revise',input,{observe(name,record,file){if(name==='afterRecheck'&&file.path==='A.md')checked=true}});return {...result,fixtureReads:reads}});`);
  const { spawnSync } = await import('node:child_process');
  const input = { vault: f.vault.id, path: 'A.md', revision: revision(readFileSync(target)), operation: 'link', link: { edges: [{ targetNotePath: 'T.md', rationale: 'Append this named target.' }] }, authorization: { origin: 'unattended', request: 'Append the target without modifying authored prose.' }, batch: 'g1-fixture', requestId: 'g1-write-001' };
  const child = spawnSync(process.execPath, [entry, JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } }); const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.fixtureReads, 0);
});
