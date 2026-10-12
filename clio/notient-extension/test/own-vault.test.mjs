import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as config from '../lib/config.mjs';
import { writeOperation, requireAuthority } from '../lib/write.mjs';
import { revision } from '../lib/paths.mjs';
import { git } from '../lib/git.mjs';
import { writerFixture, put, snapshot } from './write-helpers.mjs';
import { baseline } from './git-write.test.mjs';

test('stage 3 own location honors XDG and the default without depending on the workspace', () => {
  assert.equal(config.ownVaultPath({ XDG_DATA_HOME: '/work/data' }, '/work/user'), '/work/data/notient/clio-vault');
  assert.equal(config.ownVaultPath({}, '/work/user'), '/work/user/.local/share/notient/clio-vault');
});

test('stage 3 create-own bootstraps once, preserves conventions and commits only planned memory paths', t => {
  const f = writerFixture(t);
  const copy = path.join(f.temporary, 'package'); cpSync(fileURLToPath(new URL('../', import.meta.url)), copy, { recursive: true });
  const env = { ...process.env, XDG_DATA_HOME: path.join(f.temporary, 'data'), XDG_STATE_HOME: path.dirname(f.directory) }; delete env.AI_AGENT;
  const setup = () => spawnSync(process.execPath, [path.join(copy, 'bin/setup.mjs'), '--create-own'], { encoding: 'utf8', env });
  const created = setup(); assert.equal(created.status, 0, created.stderr);
  const own = config.readConfig(f.directory).vaults.find(vault => vault.role === 'own');
  assert.equal(own.path, path.join(env.XDG_DATA_HOME, 'notient/clio-vault')); assert.equal(own.readOnly, false);
  assert.equal(git(own.path, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  const conventions = path.join(own.path, 'Notient/Conventions.md');
  const text = readFileSync(conventions, 'utf8');
  assert.match(text, /Source:.*repository/); assert.match(text, /notient-memory:append/);
  assert.doesNotMatch(text, /Memory notes also carry session, repository, date and source_entry_ids/);
  for (const name of ['Inbox', 'Log', 'Plans']) assert.ok(existsSync(path.join(own.path, 'Notient', name)));
  writeFileSync(conventions, text + '\nOperator customization.\n');
  const again = setup(); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /"conventionsCreated": false/);
  assert.equal(readFileSync(conventions, 'utf8'), text + '\nOperator customization.\n');
  const manifest = JSON.parse(readFileSync(path.join(copy, 'clio-coder-extension.yaml'), 'utf8'));
  assert.deepEqual(manifest.runtime.permissions.fs.read, [f.directory, f.vault.path, own.path]);
  assert.deepEqual(manifest.runtime.permissions.fs.write, []);
  const captured = writeOperation('capture', { vault: own.id, name: 'Lesson', content: '# Lesson\n\nNonsecret lesson.\n', requestId: 'own-unborn-capture', batch: 'own-bootstrap', authorization: { origin: 'unattended', request: 'Capture the lesson.' } }, { directory: f.directory });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(git(own.path, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort(), [captured.capture.path, captured.log.path].sort());
  assert.match(git(own.path, ['status', '--porcelain', '--', 'Notient/Conventions.md']), /^\?\?/);
});

test('stage 3 own relaxes only unattended location and move, with read-only always enforced', t => {
  for (const role of ['operator', 'own']) {
    for (const origin of ['operator', 'clio', 'unattended']) for (const readOnly of [false, true]) {
      const f = writerFixture(t); const vault = { ...f.vault, role, readOnly };
      const authorization = { origin, request: 'Revise the exact passage.' };
      const allowed = !readOnly && (role === 'own' || origin !== 'unattended');
      if (allowed) assert.doesNotThrow(() => requireAuthority(vault, authorization, [{ path: 'Outside.md', role: 'note' }]));
      else assert.throws(() => requireAuthority(vault, authorization, [{ path: 'Outside.md', role: 'note' }]), error => error.code === (readOnly ? 'READ_ONLY_VAULT' : 'UNATTENDED_REFUSED'));
    }
    const f = writerFixture(t); baseline(f); config.atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role }] });
    const input = { requestId: 'own-outside-replace', batch: 'own-authority', authorization: { origin: 'unattended', request: 'Replace the baseline.' }, operation: 'replace', path: 'One.md', revision: revision(readFileSync(path.join(f.vault.path, 'One.md'))), oldText: 'Baseline', newText: 'Changed' };
    const result = writeOperation('revise', input, { directory: f.directory });
    assert.equal(result.ok, role === 'own', JSON.stringify(result));
    if (role === 'operator') assert.equal(result.error.code, 'UNATTENDED_REFUSED');
    config.atomicJson(path.join(f.directory, 'config.json'), { version: 1, vaults: [{ ...f.vault, role, readOnly: true }] });
    const before = snapshot(f.vault.path);
    const refused = writeOperation('capture', { name: 'Refused', content: 'Read-only wins.', batch: 'own-authority', authorization: input.authorization }, { directory: f.directory });
    assert.equal(refused.error.code, 'READ_ONLY_VAULT'); assert.deepEqual(snapshot(f.vault.path), before);
  }
});
