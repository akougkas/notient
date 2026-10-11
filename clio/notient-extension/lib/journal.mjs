import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

export function journalStatus(directory, id) {
  const root = path.join(directory, 'journal', id);
  if (!existsSync(root)) return { pending: [], recoveryResults: [], recoveryAvailable: false };
  const pending = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filename = path.join(root, entry.name);
    if (lstatSync(filename).size > 1024 * 1024) throw new Error('Journal entry exceeds 1 MiB.');
    const item = JSON.parse(readFileSync(filename, 'utf8'));
    if (!['committed', 'reverted', 'aborted'].includes(item.state)) pending.push({ id: item.id ?? entry.name, state: item.state ?? 'unknown' });
  }
  return { pending: pending.slice(0, 100), pendingCount: pending.length, recoveryResults: [], recoveryAvailable: false };
}

export function spoolCount(directory) {
  const root = path.join(directory, 'spool');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()).length : 0;
}
