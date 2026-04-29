/**
 * `notient awaken --cancel` thin-client handler.
 *
 * Spec: Phase 4 plan §Task 9. Mirrors `runAwakenPause` but writes the
 * terminal status `cancelled`, which stamps `finished_at` server-side via
 * the Task 7 DAL.
 *
 * Locked invariants:
 *   - No-op with exit 1 and a stderr message when no current run exists.
 *   - Never calls `runAwakenWorker` directly; the CLI is a thin client over
 *     the DAL.
 */

import { findCurrent, updateStatus } from "../../core/awaken/awakenRun";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface AwakenCancelOptions {
  vaultPath: string;
  stderr?: (line: string) => void;
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runAwakenCancel(options: AwakenCancelOptions): Promise<number> {
  const stderr = options.stderr ?? defaultStderr;
  let connection: { close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const current = await findCurrent(opened.db);
    if (current === null) {
      stderr("no current awaken run; nothing to cancel");
      return 1;
    }
    await updateStatus(opened.db, current.id, "cancelled");
    return 0;
  } catch (error) {
    stderr(`awaken --cancel: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}
