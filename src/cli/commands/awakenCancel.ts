/**
 * `notient awaken --cancel` thin-client handler.
 *
 * Calls the daemon's `awaken.cancel` RPC and writes the terminal status
 * `cancelled`, which stamps `finished_at` using the SurrealDB server clock.
 *
 * Locked invariants:
 *   - No-op with exit 1 and a stderr message when no current run exists.
 *   - Never calls `runAwakenWorker` directly; the CLI is a thin client over
 *     the daemon RPC.
 */

import { type AwakenControlClientOptions, runAwakenControl } from "./awakenPause";

export interface AwakenCancelOptions extends AwakenControlClientOptions {}

export async function runAwakenCancel(options: AwakenCancelOptions): Promise<number> {
  return await runAwakenControl(options, "cancel");
}
