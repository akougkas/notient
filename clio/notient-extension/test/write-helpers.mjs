import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicJson } from '../lib/config.mjs';
import { revision, vaultId } from '../lib/paths.mjs';

export function writerFixture(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'notient-write-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'vault');
  const directory = path.join(temporary, 'state/notient');
  mkdirSync(root);
  const vault = { id: vaultId(root), path: root, role: 'operator', readOnly: false };
  atomicJson(path.join(directory, 'config.json'), { version: 1, vaults: [vault] });
  return { temporary, vault, directory };
}

export function put(f, name, bytes) { const filename = path.join(f.vault.path, name); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, bytes); }

export function snapshot(root) {
  const files = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) files[path.relative(root, filename)] = revision(readFileSync(filename));
    }
  }
  visit(root);
  return files;
}

export function testPlan(f, { id = 'journal-test-001', files, ...rest } = {}) {
  const before = Buffer.from('# Before\r\n\r\nOriginal bytes.');
  const after = Buffer.from('# Before\r\n\r\nChanged bytes.');
  return {
    id, tool: 'revise', operation: 'replace', requestDigest: revision('request'), planHash: revision('plan'),
    batch: 'journal-tests', authorization: { origin: 'operator', request: 'Replace the sentence.' },
    createdAt: new Date().toISOString(), source: 'One.md',
    files: files ?? [{ path: 'One.md', role: 'note', before, after, mode: 0o600 }],
    log: { path: 'Notient/Log/2026-10.md', line: '- {}' }, ...rest,
  };
}

export function memoryGit() {
  let published = false;
  return {
    recognize: () => published,
    checkBase: () => {},
    prepare: record => { record.git.commit = 'a'.repeat(40); },
    publish: () => { published = true; },
    reconcileIndex: () => true,
  };
}
