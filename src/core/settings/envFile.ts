import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { type EnvSource, mergeEnvSources } from "./envOverrides";

/**
 * Tiny dotenv-style parser. No dependency, no quoting beyond single and
 * double quotes, no variable expansion. Lines that do not match KEY=value
 * are ignored. Values may be:
 *
 *   KEY=value                  → bare value
 *   KEY="value with spaces"    → double-quoted value (quotes stripped)
 *   KEY='value with spaces'    → single-quoted value (quotes stripped)
 *   # comment                  → ignored
 *   KEY=                       → empty string
 *
 * Returns a flat Record. The caller decides what to do with collisions
 * against process.env.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidEnvKey(key)) continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    result[key] = value;
  }
  return result;
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Shared private deployment authority: saved vault keys win, including explicit
 * emptiness. The caller supplies a hidden-capable vault adapter, never an agent's. */
export async function readEnvSource(
  vault: Pick<VaultAdapter, "read">,
  processEnv: NodeJS.ProcessEnv,
): Promise<EnvSource> {
  const raw = await readOptionalVaultFile(vault, ".notient/.env");
  return mergeEnvSources(raw === null ? {} : parseEnvFile(raw), processEnv);
}

export async function readOptionalVaultFile(
  vault: Pick<VaultAdapter, "read">,
  path: string,
): Promise<string | null> {
  try {
    return await vault.read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
