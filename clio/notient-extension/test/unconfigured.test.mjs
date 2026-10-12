import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writerFixture, snapshot } from './write-helpers.mjs';
import { writeOperation, commandStatusSnapshot } from '../lib/write.mjs';
import { statusSnapshot } from '../lib/status.mjs';

test('R10 absent registration gives exit-zero setup guidance for status and all write tools', t => {
  const f = writerFixture(t); unlinkSync(path.join(f.directory, 'config.json'));
  const before = snapshot(f.temporary);
  const authorization = { origin: 'operator', request: 'Do requested work.' };
  const inputs = {
    status: { vault: 'unregistered' },
    capture: { name: 'New', content: 'Text', batch: 'unconfigured', authorization },
    revise: { operation: 'replace', path: 'One.md', revision: 'a'.repeat(64), oldText: 'One', newText: 'Two', batch: 'unconfigured', authorization },
    undo: { opId: 'unregistered-op', batch: 'unconfigured', authorization },
  };
  for (const [name, input] of Object.entries(inputs)) {
    input.vault = 'unregistered';
    const command = spawnSync(process.execPath, [fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url)), JSON.stringify(input)], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) } });
    assert.equal(command.status, 0, command.stdout);
    const value = JSON.parse(command.stdout);
    assert.equal(value.configured, false);
    assert.equal(value.unavailable, 'not-configured');
    assert.match(value.setupHint, /node .*bin\/setup\.mjs"? --vault/);
    const direct = name === 'status' ? commandStatusSnapshot(f.directory, input) : writeOperation(name, input, { directory: f.directory });
    assert.equal(direct.configured, false);
  }
  const runtime = statusSnapshot(f.directory, { runtime: true });
  assert.equal(runtime.configured, false); assert.equal(runtime.vaultCount, 0); assert.deepEqual(runtime.vaults, []);
  assert.deepEqual(snapshot(f.temporary), before);
});
