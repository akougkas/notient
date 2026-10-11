import type { ExtensionApiV2, ExtensionOutputV2 } from '@iowarp/clio-coder/extensions';
import { dataDirectory } from '../lib/config.mjs';
import { statusSnapshot } from '../lib/status.mjs';
import { unknownCoverageMessage } from '../lib/index.mjs';

function render(showLog = false): ExtensionOutputV2 {
  try {
    const snapshot = statusSnapshot(dataDirectory(), { runtime: true });
    const lines = [`Notient visits ${snapshot.vaultCount} registered vaults.`, `Memory spool: ${snapshot.spoolCount}.`];
    if (!snapshot.fts5) lines.push(`FTS5 unavailable on Node ${snapshot.nodeVersion}. ${unknownCoverageMessage}`);
    let pending = 0;
    for (const vault of snapshot.vaults) {
      if (vault.error) { lines.push(`${vault.name}: ${vault.error}`); continue; }
      pending += vault.journal.pendingCount ?? vault.journal.pending.length;
      const count = vault.index.notes === null ? 'note count unavailable' : `${vault.index.notes} notes`;
      lines.push(`${vault.name} (${vault.role}${vault.readOnly ? ', read-only' : ''}): ${count}; ${vault.index.freshness}; refreshed ${vault.index.refreshedAt ?? 'never'}.`);
      lines.push(`Pending recovery: ${vault.journal.pendingCount ?? vault.journal.pending.length}. Last commit: ${vault.lastCommit?.hash?.slice(0, 12) ?? 'unavailable'}.`);
      if (showLog) lines.push(...(vault.log.length ? vault.log : ['No Notient log entries.']));
    }
    const text = lines.join('\n').slice(0, 16000);
    return {
      text,
      status: { text: `Notient · ${snapshot.vaultCount} vaults · ${pending} pending recovery${snapshot.fts5 ? '' : ' · FTS5 unavailable'}`.slice(0, 160), tone: !snapshot.fts5 || pending || snapshot.vaults.some(v => v.error) ? 'warning' : 'neutral' },
      panel: { title: showLog ? 'Notient log' : 'Sentient Notes', view: { t: 'text', text: text.slice(0, 2000), wrap: 'wrap' } },
    };
  } catch (error) {
    const text = `Notient state unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1500);
    return { text, status: { text: 'Notient state unavailable', tone: 'warning' }, panel: { title: 'Notient', view: { t: 'text', text } } };
  }
}

export default function extension(api: ExtensionApiV2): void {
  api.handle('status', () => render());
  api.handle('log', () => render(true));
  api.on('session_open', () => render());
  api.on('session_close', () => render());
}
