import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ResolveVaultOptions {
  flagVault: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  stateLoader: () => Promise<string | null>;
}

export async function resolveVault(options: ResolveVaultOptions): Promise<string> {
  if (options.flagVault) return absolutize(options.flagVault, options.cwd);

  const envValue = options.env.NOTIENT_VAULT;
  if (envValue) return absolutize(envValue, options.cwd);

  const climbed = await climbForVault(options.cwd);
  if (climbed) return climbed;

  const fromState = await options.stateLoader();
  if (fromState) return fromState;

  throw new Error("No vault. Run 'notient init <path>' first.");
}

async function climbForVault(start: string): Promise<string | null> {
  let current = start;
  while (true) {
    if (await isVaultRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function isVaultRoot(path: string): Promise<boolean> {
  return (await pathExists(join(path, ".notient"))) || (await pathExists(join(path, ".obsidian")));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function defaultStateLoader(): () => Promise<string | null> {
  const path = join(homedir(), ".config", "notient", "state.json");
  return async () => {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { lastVault?: string };
      return parsed.lastVault ?? null;
    } catch {
      return null;
    }
  };
}
