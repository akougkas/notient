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
 *
 * Phase 5 Task 11 adds `--tier <csv>` to the fresh-run path. The CSV is
 * parsed into a `number[]` of valid tier ids (1, 2, 3) and forwarded as
 * the `tier` RPC parameter; the daemon stores it as `awaken_run.tier_filter`
 * and gates per-note tier execution accordingly. Invalid tokens are
 * silently dropped; an empty result falls back to `[1, 2, 3]`.
 */

import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { runAwakenCancel } from "./awakenCancel";
import { runAwakenPause } from "./awakenPause";
import { runAwakenResume } from "./awakenResume";
import { runAwakenStatus } from "./awakenStatus";

export type AwakenControlMode = "pause" | "resume" | "cancel" | "status";

export const DEFAULT_TIER_FILTER: readonly number[] = [1, 2, 3];

export interface AwakenCommandOptions {
  vaultPath: string;
  batch?: number;
  since?: number;
  /**
   * Tier filter forwarded as the `tier` RPC parameter. Defaults to
   * `[1, 2, 3]` when omitted. Callers should run the raw `--tier` value
   * through `parseTierCsv` so invalid tokens are stripped before
   * reaching the wire.
   */
  tier?: number[];
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

/**
 * Parses a `--tier` CSV value into a sorted, de-duplicated array of
 * valid tier ids (1, 2, 3). Whitespace around tokens is trimmed; tokens
 * that do not match a valid tier are silently dropped. When the input
 * is empty, `undefined`, `true` (bare flag with no value), or yields an
 * empty result, the default `[1, 2, 3]` is returned so the daemon's
 * default behaviour is preserved.
 */
export function parseTierCsv(raw: string | boolean | undefined): number[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [...DEFAULT_TIER_FILTER];
  }
  const tokens = raw.split(",").map((token) => token.trim());
  const result = new Set<number>();
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (!/^\d+$/.test(token)) continue;
    const value = Number(token);
    if (value === 1 || value === 2 || value === 3) {
      result.add(value);
    }
  }
  if (result.size === 0) {
    return [...DEFAULT_TIER_FILTER];
  }
  return Array.from(result).sort((a, b) => a - b);
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
  if (options.tier !== undefined) params.tier = options.tier;
  for await (const frame of client.call("awaken.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
  return 0;
}
