import { dataDirectory, selectVault, readConfig, notConfigured } from './config.mjs';

export async function withReadVault(tool, input, handler) {
  let vault;
  try {
    const directory = dataDirectory();
    if (!readConfig(directory).vaults.length) return { ...notConfigured(), tool };
    vault = selectVault(input.vault, directory);
    return await handler(vault, directory, input);
  } catch (error) {
    return { ok: false, tool, vault: vault?.id ?? null, error: { code: error.code ?? 'STRUCTURAL_UNAVAILABLE', message: error.message, retryable: error.retryable ?? false, paths: error.paths ?? [] } };
  }
}
