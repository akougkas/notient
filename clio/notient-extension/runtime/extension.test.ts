import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createExtensionTestHost } from '@iowarp/clio-coder/extensions/testing';
import { atomicJson, indexPath } from '../lib/config.mjs';
import { vaultId, revision } from '../lib/paths.mjs';
import { refreshIndex } from '../lib/index.mjs';

test('read-only runtime registers status, log and session observations', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'notient-runtime-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = temporary;
  const host = await createExtensionTestHost(fileURLToPath(new URL('../', import.meta.url)));
  try {
    const status = await host.command('status');
    assert.match(status.text, /0 registered vaults/);
    assert.equal(status.panel?.title, 'Sentient Notes');
    assert.equal((await host.command('log')).panel?.title, 'Notient log');
    const opened = await host.observe({ event: 'session_open', reason: 'startup' });
    assert.match(opened?.status?.text ?? '', /Notient/);
    const closed = await host.observe({ event: 'session_close', reason: 'exit' });
    assert.match(closed?.status?.text ?? '', /0 vaults/);
  } finally {
    await host.dispose();
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime shows real index, pending journal and five log lines without writing', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'notient-runtime-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(temporary, 'state');
  const directory = path.join(process.env.XDG_STATE_HOME, 'notient');
  const vaultPath = path.join(temporary, 'vault');
  const vault = { id: vaultId(vaultPath), path: vaultPath, role: 'operator', readOnly: true };
  mkdirSync(path.join(vaultPath, 'Notient/Log'), { recursive: true });
  writeFileSync(path.join(vaultPath, 'One.md'), '# One\n\nStorage evidence.\n');
  writeFileSync(path.join(vaultPath, 'Notient/Log/2026-10.md'), '# Log\n\n' + Array.from({ length: 8 }, (_, i) => `operation ${i}`).join('\n') + '\n');
  atomicJson(path.join(directory, 'config.json'), { version: 1, vaults: [vault] });
  atomicJson(path.join(directory, 'journal', vault.id, 'pending.json'), { id: 'pending', state: 'intent' });
  refreshIndex(vault, directory);
  const before = revision(readFileSync(indexPath(directory, vault)));
  const host = await createExtensionTestHost(fileURLToPath(new URL('../', import.meta.url)));
  try {
    const result = await host.command('log');
    assert.match(result.text, /2 notes/);
    assert.match(result.status?.text ?? '', /1 pending recovery/);
    assert.equal(result.status?.tone, 'warning');
    assert.match(result.text, /operation 3/);
    assert.match(result.text, /operation 7/);
    assert.doesNotMatch(result.text, /operation 2/);
    assert.equal(revision(readFileSync(indexPath(directory, vault))), before);
  } finally {
    await host.dispose();
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime reports missing FTS5 with the Node version and unknown note count', async t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'notient-runtime-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(temporary, 'state');
  const directory = path.join(process.env.XDG_STATE_HOME, 'notient');
  const vaultPath = path.join(temporary, 'vault');
  const vault = { id: vaultId(vaultPath), path: vaultPath, role: 'operator', readOnly: true };
  mkdirSync(vaultPath);
  atomicJson(path.join(directory, 'config.json'), { version: 1, vaults: [vault] });
  const before = revision(readFileSync(path.join(directory, 'config.json')));
  const host = await createExtensionTestHost(fileURLToPath(new URL('../', import.meta.url)));
  t.mock.method(DatabaseSync.prototype, 'exec', () => { throw new Error('no such module: fts5'); });
  try {
    const result = await host.command('status');
    assert.ok(result.text?.includes(`FTS5 unavailable on Node ${process.version}.`));
    assert.ok(result.text?.includes('Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes.'));
    assert.match(result.text ?? '', /note count unavailable/);
    assert.doesNotMatch(result.text ?? '', /0 notes/);
    assert.equal(result.status?.tone, 'warning');
    assert.match(result.status?.text ?? '', /FTS5 unavailable/);
    assert.equal(revision(readFileSync(path.join(directory, 'config.json'))), before);
  } finally {
    await host.dispose();
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});
