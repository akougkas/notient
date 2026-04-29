/**
 * `notient awaken --resume` thin-client handler.
 *
 * Spec: Phase 4 plan §Task 9. Locked decision: the CLI never invokes the
 * worker loop directly for `--resume`. Instead it flips the latest
 * resumable run's status from `paused` (or `failed`) back to `running`.
 * The daemon's awaken worker subscribes to status changes via
 * `subscribeToStatus` (Task 7 DAL) and continues the loop on its own.
 *
 * If no resumable run exists the call is a no-op with exit 1. If the
 * SurrealDB connection itself fails (typically because the daemon is not
 * running) the helper surfaces a clear stderr message and exits 1.
 */

import { findLatestResumable, updateStatus } from "../../core/awaken/awakenRun";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface AwakenResumeOptions {
  vaultPath: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runAwakenResume(options: AwakenResumeOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  let connection: { close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const resumable = await findLatestResumable(opened.db);
    if (resumable === null) {
      stderr("no resumable awaken run found");
      return 1;
    }
    await updateStatus(opened.db, resumable.id, "running");
    stdout(
      JSON.stringify({
        type: "awaken:resumed",
        runId: resumable.id.toString(),
        processed: resumable.processed,
        failed: resumable.failed,
        total: resumable.total,
      }),
    );
    return 0;
  } catch (error) {
    stderr(`awaken --resume: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}
