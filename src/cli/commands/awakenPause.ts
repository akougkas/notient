/**
 * `notient awaken --pause` thin-client handler.
 *
 * Spec: Phase 4 plan §Task 9. Connects to the daemon's SurrealDB instance
 * via the per-vault port file, looks up the current run via the Task 7 DAL,
 * and flips its status to `paused`. The daemon's awaken worker observes the
 * status change through the `subscribeToStatus` live query and stops
 * between notes (Task 8 invariant).
 *
 * Locked invariants:
 *   - No-op with exit 1 and a stderr message when no current run exists.
 *   - Never calls `runAwakenWorker` directly; the CLI is a thin client over
 *     the DAL.
 */

import { findCurrent, updateStatus } from "../../core/awaken/awakenRun";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface AwakenPauseOptions {
  vaultPath: string;
  stderr?: (line: string) => void;
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runAwakenPause(options: AwakenPauseOptions): Promise<number> {
  const stderr = options.stderr ?? defaultStderr;
  let connection: { close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const current = await findCurrent(opened.db);
    if (current === null) {
      stderr("no current awaken run; nothing to pause");
      return 1;
    }
    await updateStatus(opened.db, current.id, "paused");
    return 0;
  } catch (error) {
    stderr(`awaken --pause: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}
