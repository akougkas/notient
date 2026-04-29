import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeDefaultConfigIfAbsent } from "../../core/config/configFile";
import { DEFAULT_SETTINGS } from "../../core/settings/types";
import type { Emitter } from "../output";

export interface InitOptions {
  vaultPathArg: string;
  cwd: string;
  emitter: Emitter;
  stateFilePath?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const vaultPath = isAbsolute(options.vaultPathArg)
    ? options.vaultPathArg
    : resolve(options.cwd, options.vaultPathArg);
  const notientDir = join(vaultPath, ".notient");
  await mkdir(notientDir, { recursive: true });
  await writeFile(
    join(notientDir, "config.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2),
    "utf-8",
  );

  // Phase 4 Task 10: write the per-vault TOML config alongside config.json
  // when none is present. Existing files are never overwritten so a follow-up
  // `notient init` cannot clobber the operator's edits. Daemon restart picks
  // up changes; there is no live reload by design.
  const configToml = await writeDefaultConfigIfAbsent(vaultPath);
  if (configToml.written) {
    options.emitter.emit({ type: "init:config_written", path: configToml.path });
  }

  const stateFile = options.stateFilePath ?? join(homedir(), ".config", "notient", "state.json");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastVault: vaultPath }, null, 2), "utf-8");
  options.emitter.emit({ type: "init:done", vault: vaultPath });
}
