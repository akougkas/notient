/**
 * `notient awaken --resume` thin-client handler.
 *
 * Spec: Phase 4 plan §Task 9. Originally the CLI flipped the row's status
 * to `running` directly through the daemon's SurrealDB, on the assumption
 * that the daemon's awaken worker subscribed to status changes via a live
 * query. That assumption breaks the moment the worker observes `paused`:
 * its `finally` block closes the live-query subscription and the worker
 * exits. A subsequent `--resume` would flip the row to `running` but no
 * worker was listening, so the row stayed at `running` indefinitely.
 *
 * The fix moves the resume into a daemon RPC (`awaken.resume`). The
 * handler picks the resumable row, flips it to `running`, and spawns a
 * fresh worker via the same fire-and-forget path `awaken --background`
 * uses. The CLI is now a thin client over that RPC.
 *
 * Failure modes surfaced via stderr:
 *   - `no resumable awaken run found` (no `paused` or `failed` row).
 *   - `a different run is already active` (a separate `running` row
 *     exists for the same vault).
 *   - daemon connect failure (typically "daemon is not running").
 */

import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";

export interface AwakenResumeOptions {
  vaultPath: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  clientIdentity?: string;
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface ResumeResultFrame {
  type: "result";
  ok?: boolean;
  runId?: string;
  processed?: number;
  failed?: number;
  total?: number;
  status?: string;
}

interface ResumeErrorFrame {
  type: "error";
  message?: string;
}

export async function runAwakenResume(options: AwakenResumeOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  let client: { close: () => Promise<void> } | undefined;
  try {
    const opened = await connectClient({
      socketPath,
      vaultPath: options.vaultPath,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    });
    client = opened;
    for await (const frame of opened.call("awaken.resume", {})) {
      if (frame.type === "result") {
        const result = frame as unknown as ResumeResultFrame;
        stdout(
          JSON.stringify({
            type: "awaken:resumed",
            runId: result.runId,
            processed: result.processed,
            failed: result.failed,
            total: result.total,
            status: result.status,
          }),
        );
        return 0;
      }
      if (frame.type === "error") {
        const errorFrame = frame as unknown as ResumeErrorFrame;
        stderr(`awaken --resume: ${errorFrame.message ?? "unknown error"}`);
        return 1;
      }
    }
    stderr("awaken --resume: daemon closed the stream without a result");
    return 1;
  } catch (error) {
    stderr(`awaken --resume: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (client !== undefined) {
      await client.close().catch(() => {});
    }
  }
}
