/**
 * `notient nuke` CLI verb.
 *
 * Spec: Phase 5 plan §Task 10. Stops the daemon, removes the per-vault
 * data directory, and starts the daemon back up so the bootstrap
 * applies the schema to a fresh RocksDB. Idempotent: running on a
 * vault whose data directory is already gone succeeds without error.
 *
 * Confirmation contract:
 *   - With `--yes`: proceeds unconditionally.
 *   - Without `--yes` and TTY stdin: reads `y`/`yes` from stdin.
 *   - Without `--yes` and non-TTY stdin: refuses with exit 2 so a
 *     scripted invocation can not silently destroy a vault.
 */

import { rm } from "node:fs/promises";
import { vaultDataDir } from "../../core/vault/identity";
import type { Emitter } from "../output";
import {
  type DaemonStartHook,
  type DaemonStopHook,
  defaultDaemonStartHook,
  defaultDaemonStopHook,
} from "./daemonControl";

export interface NukeOptions {
  vaultPath: string;
  yes: boolean;
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to `process.stdin`. The runtime never threads a
   * substitute; tests inject a `Readable` that yields the expected
   * confirmation byte.
   */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /**
   * Test seam for daemon control. Defaults stop the daemon over the
   * unix socket and start it via `bun run` against the daemon entry.
   */
  stopDaemon?: DaemonStopHook;
  startDaemon?: DaemonStartHook;
}

export async function runNukeCommand(options: NukeOptions): Promise<number> {
  if (!options.yes) {
    const stdin = options.stdin ?? process.stdin;
    const isTty = Boolean(stdin.isTTY);
    if (!isTty) {
      process.stderr.write(
        "nuke refused: stdin is not a TTY and --yes was not passed. Re-run with --yes to confirm.\n",
      );
      return 2;
    }
    const confirmed = await readConfirmation(stdin);
    if (!confirmed) {
      options.emitter.emit({ type: "nuke-aborted" });
      return 1;
    }
  }

  const stopDaemon = options.stopDaemon ?? defaultDaemonStopHook;
  const startDaemon = options.startDaemon ?? defaultDaemonStartHook;

  // Daemon stop is best-effort: if the daemon is already down, the data
  // dir wipe and start steps still need to run.
  await stopDaemon({ vaultPath: options.vaultPath }).catch(() => {});

  const dataDir = vaultDataDir(options.vaultPath);
  await rm(dataDir, { recursive: true, force: true });

  await startDaemon({ vaultPath: options.vaultPath });

  options.emitter.emit({ type: "nuke-success", dataDir });
  return 0;
}

async function readConfirmation(stdin: NodeJS.ReadableStream): Promise<boolean> {
  process.stderr.write(
    "This will erase all SurrealDB data for this vault. Type 'yes' to confirm: ",
  );
  return await new Promise<boolean>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex).trim().toLowerCase();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      resolve(line === "y" || line === "yes");
    };
    const onEnd = (): void => {
      stdin.removeListener("data", onData);
      resolve(false);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}
