import { existsSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { indexSummary, openIndex } from './index.mjs';
import { journalStatus, spoolCount } from './journal.mjs';
import { lastCommit } from './git.mjs';
import { notePath } from './paths.mjs';

function logTail(vault) {
  const root = path.join(vault.path, 'Notient/Log');
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('Log directory cannot be a symbolic link.');
  const names = readdirSync(root).filter(name => /^\d{4}-\d{2}\.md$/.test(name)).sort().reverse().slice(0, 2);
  const lines = [];
  for (const name of names.reverse()) {
    const filename = notePath(vault.path, `Notient/Log/${name}`);
    const size = lstatSync(filename).size;
    const start = Math.max(0, size - 16384);
    const fd = openSync(filename, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(16384, size));
      readSync(fd, buffer, 0, buffer.length, start);
      const tail = buffer.toString('utf8').split(/\r?\n/);
      if (start) tail.shift();
      lines.push(...tail.filter(line => line.trim() && !line.startsWith('#')).map(line => line.slice(0, 1000)));
    } finally { closeSync(fd); }
  }
  return lines.slice(-5);
}

export function statusSnapshot(directory, { vault: selector, runtime = false } = {}) {
  const config = readConfig(directory);
  const selected = selector ? config.vaults.filter(v => v.id === selector || v.path === selector) : config.vaults;
  if (selector && !selected.length) throw new Error('Vault is not registered. Ask the operator to run setup.');
  const vaults = selected.map(vault => {
    try {
      let commit = null;
      if (runtime) {
        const db = openIndex(directory, vault);
        try { commit = JSON.parse(db?.prepare("SELECT value FROM meta WHERE key = 'lastCommit'").get()?.value ?? 'null'); }
        finally { db?.close(); }
      } else commit = lastCommit(vault.path);
      return { ...vault, name: path.basename(vault.path), index: indexSummary(vault, directory, !runtime), journal: journalStatus(directory, vault.id), lastCommit: commit, lastCommitSource: runtime ? 'last refresh snapshot' : 'git log', log: logTail(vault) };
    } catch (error) {
      return { ...vault, name: path.basename(vault.path), error: error.message };
    }
  });
  return { stage: 1, dataDirectory: directory, vaultCount: vaults.length, vaults, spoolCount: spoolCount(directory), recovery: 'Stage 1 observes journal state. Recovery and vault writes arrive in stage 2.' };
}
