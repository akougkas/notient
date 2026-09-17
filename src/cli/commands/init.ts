import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_NOTIENT_CONFIG } from "../../core/settings/types";
import { normalizeVaultPath } from "../env";
import type { Emitter } from "../output";

export interface InitOptions {
  vaultPathArg: string;
  cwd: string;
  emitter: Emitter;
  stateFilePath?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const vaultPath = normalizeVaultPath(options.vaultPathArg, options.cwd);
  const notientDir = join(vaultPath, ".notient");
  await mkdir(notientDir, { recursive: true });
  const configPath = join(notientDir, "config.json");
  if (await writeDefaultSettingsIfAbsent(configPath)) {
    options.emitter.emit({ type: "init:config_written", path: configPath });
  }

  const stateFile = options.stateFilePath ?? join(homedir(), ".config", "notient", "state.json");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastVault: vaultPath }, null, 2), "utf-8");
  options.emitter.emit({ type: "init:done", vault: vaultPath });
}

async function writeDefaultSettingsIfAbsent(path: string): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(DEFAULT_NOTIENT_CONFIG, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
