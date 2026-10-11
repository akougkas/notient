import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExtensionTestHost } from '@iowarp/clio-coder/extensions/testing';

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
