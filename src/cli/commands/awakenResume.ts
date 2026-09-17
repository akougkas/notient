/**
 * `notient awaken --resume` thin-client handler.
 *
 * Calls the daemon's `awaken.resume` RPC. The daemon selects the resumable
 * row, moves it to `running`, and starts a tracked worker. Starting a fresh
 * worker is required because a paused worker exits and closes its live-query
 * subscription.
 *
 * Failure modes surfaced via stderr:
 *   - `no resumable awaken run found` (no `paused` or `failed` row).
 *   - `a different run is already active` (a separate `running` row
 *     exists for the same vault).
 *   - daemon connect failure (typically "daemon is not running").
 */

import { type AwakenControlClientOptions, runAwakenControl } from "./awakenPause";

export interface AwakenResumeOptions extends AwakenControlClientOptions {}

export async function runAwakenResume(options: AwakenResumeOptions): Promise<number> {
  return await runAwakenControl(options, "resume");
}
