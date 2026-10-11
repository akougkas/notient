import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes } from './notient-extension/lib/vault.mjs';
import { vaultId, revision } from './notient-extension/lib/paths.mjs';
import { refreshIndex, searchIndex, indexSummary } from './notient-extension/lib/index.mjs';
import { indexPath } from './notient-extension/lib/config.mjs';

const requested = process.argv[2];
if (!requested || process.argv.length !== 3) throw new Error('Usage: node clio/measure-stage1.mjs <vault-path>');
const root = realpathSync(requested);
const vault = { id: vaultId(root), path: root, role: 'operator', readOnly: true };
const local = fileURLToPath(new URL('.local/', import.meta.url));
mkdirSync(local, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(path.join(local, `stage1-${vault.id}-`));
function fingerprint() {
  const notes = listNotes(root).notes.map(note => ({ path: note.path, hash: revision(readFileSync(path.join(root, note.path))) }));
  return { count: notes.length, sha256: revision(JSON.stringify(notes)) };
}
const before = fingerprint();
const indexExisted = existsSync(indexPath(directory, vault));
const initial = refreshIndex(vault, directory, { force: true });
const incremental = refreshIndex(vault, directory);
const durations = [];
let search;
for (let i = 0; i < 20; i++) {
  search = searchIndex(vault, directory, { query: 'storage', limit: 5 });
  durations.push(search.durationMs);
}
durations.sort((a, b) => a - b);
const after = fingerprint();
const output = {
  vault: root, registered: false, method: 'Direct read-only library measurement. Operator setup remains required.', indexDirectory: directory,
  indexExisted, before, after, markdownUnchanged: before.sha256 === after.sha256,
  initial, incremental, index: indexSummary(vault, directory),
  search: { query: 'storage', calls: durations.length, hits: search.hits.length, minMs: durations[0], medianMs: durations[10], p95Ms: durations[18], maxMs: durations[19], paths: [...new Set(search.hits.map(hit => hit.path))], stalePaths: search.stalePaths },
};
if (root === fileURLToPath(new URL('fixtures/toy-vault/', import.meta.url)).replace(/\/$/, '')) output.citedPassage = search.hits[0];
writeFileSync(path.join(directory, 'measurement.json'), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.markdownUnchanged || initial.errorCount || search.refreshRequired) process.exitCode = 1;
