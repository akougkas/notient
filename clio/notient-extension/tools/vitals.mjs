import { runCommand } from '../lib/command.mjs';
import { dataDirectory, selectVault, readConfig, notConfigured } from '../lib/config.mjs';
import { readVitals } from '../lib/vitals-read.mjs';

await runCommand('vitals', input => {
  const directory = dataDirectory();
  if (!readConfig(directory).vaults.length) return { ...notConfigured(), tool: 'vitals' };
  let vault;
  try { vault = selectVault(input.vault, directory); return readVitals(vault, directory, input); }
  catch (error) { return { ok: false, tool: 'vitals', vault: vault?.id ?? null, error: { code: error.code ?? 'STRUCTURAL_UNAVAILABLE', message: error.message, retryable: error.retryable ?? false, paths: error.paths ?? [] } }; }
});
