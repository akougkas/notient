/**
 * `notient awaken` command entrypoint.
 *
 * Spec: Phase 4 plan §Task 9. Default invocation (no control flag) starts
 * a fresh awaken run by RPCing the daemon's `awaken.run` handler. The
 * four control flags route to thin DAL-only helpers that connect to the
 * daemon's SurrealDB instance directly:
 *
 *   - `--pause`  -> runAwakenPause   (findCurrent + updateStatus paused)
 *   - `--cancel` -> runAwakenCancel  (findCurrent + updateStatus cancelled)
 *   - `--resume` -> runAwakenResume  (findLatestResumable + updateStatus running)
 *   - `--status` -> runAwakenStatus  (1Hz NDJSON poll until terminal status)
 *
 * The CLI never invokes `runAwakenWorker` directly for the control flags;
 * the daemon's worker subscribes to status changes via the live query and
 * drives the loop on its own.
 */

import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { runAwakenCancel } from "./awakenCancel";
import { runAwakenPause } from "./awakenPause";
import { runAwakenResume } from "./awakenResume";
import { runAwakenStatus } from "./awakenStatus";

export type AwakenControlMode = "pause" | "resume" | "cancel" | "status";

export interface AwakenCommandOptions {
  vaultPath: string;
  batch?: number;
  since?: number;
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Control-plane mode selected by the dispatcher. When omitted the command
   * starts a fresh awaken run via the daemon RPC handler.
   */
  mode?: AwakenControlMode;
}

export async function runAwakenCommand(options: AwakenCommandOptions): Promise<number> {
  if (options.mode === "pause") {
    return await runAwakenPause({ vaultPath: options.vaultPath });
  }
  if (options.mode === "cancel") {
    return await runAwakenCancel({ vaultPath: options.vaultPath });
  }
  if (options.mode === "resume") {
    return await runAwakenResume({ vaultPath: options.vaultPath });
  }
  if (options.mode === "status") {
    return await runAwakenStatus({ vaultPath: options.vaultPath });
  }
  return await startFreshAwaken(options);
}

async function startFreshAwaken(options: AwakenCommandOptions): Promise<number> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  const params: Record<string, unknown> = {};
  if (options.batch !== undefined) params.batch = options.batch;
  if (options.since !== undefined) params.since = options.since;
  for await (const frame of client.call("awaken.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
  return 0;
}
