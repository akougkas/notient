import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writerFixture, put } from './write-helpers.mjs';
import { git } from '../lib/git.mjs';
import { openGarden } from '../lib/garden-store.mjs';

export function gardenFixture(t, files = { '0-inbox/A.md': '# A\n\nAuthored alpha evidence.\n' }) {
  const f = writerFixture(t);
  for (const [name, text] of Object.entries(files)) put(f, name, text);
  git(f.vault.path, ['init', '-q']); git(f.vault.path, ['config', 'user.name', 'Fixture']); git(f.vault.path, ['config', 'user.email', 'fixture@example.invalid']);
  if (Object.keys(files).length) { git(f.vault.path, ['add', '--', ...Object.keys(files)]); git(f.vault.path, ['commit', '-qm', 'Fixture baseline']); }
  return f;
}

export async function gardenTool(f, name, input, { imports = [] } = {}) {
  const child = spawn(process.execPath, [...imports.flatMap(filename => ['--import', filename]), fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url)), JSON.stringify({ vault: f.vault.id, ...input })], { env: { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [status] = await once(child, 'exit'); return { status, value: JSON.parse(stdout), stderr };
}

export const beginGarden = (f, runId = 'garden-fixture-001') => gardenTool(f, 'garden', { action: 'begin', runId, request: 'Tend this fixture with bounded additive work and proposals.' });
export function editGarden(f, action) { const db = openGarden(f.directory, f.vault, true); try { action(db); } finally { db.close(); } }
