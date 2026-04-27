import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "../../core/settings/types";
import type { Emitter } from "../output";

export interface InitOptions {
  vaultPathArg: string;
  cwd: string;
  emitter: Emitter;
  /** Absolute path to the bundled sql-wasm.wasm. Phase A: a known fixture under node_modules/sql.js/dist/. */
  sqlWasmSource: string;
  stateFilePath?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const vaultPath = isAbsolute(options.vaultPathArg)
    ? options.vaultPathArg
    : resolve(options.cwd, options.vaultPathArg);
  const notientDir = join(vaultPath, ".notient");
  await mkdir(notientDir, { recursive: true });
  await copyFile(options.sqlWasmSource, join(notientDir, "sql-wasm.wasm"));
  await writeFile(
    join(notientDir, "config.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2),
    "utf-8",
  );
  const stateFile = options.stateFilePath ?? join(homedir(), ".config", "notient", "state.json");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastVault: vaultPath }, null, 2), "utf-8");
  options.emitter.emit({ type: "init:done", vault: vaultPath });
}
