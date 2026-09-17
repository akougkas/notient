/**
 * `notient awaken` command entrypoint.
 *
 * Default invocation starts a fresh awaken run through the owning daemon.
 * The four control flags route to focused RPC clients:
 *
 *   - `--pause`  -> runAwakenPause   (daemon RPC: awaken.pause)
 *   - `--cancel` -> runAwakenCancel  (daemon RPC: awaken.cancel)
 *   - `--resume` -> runAwakenResume  (daemon RPC: awaken.resume)
 *   - `--status` -> runAwakenStatus  (daemon RPC snapshot)
 *
 * The CLI never invokes `runAwakenWorker` directly for the control flags;
 * the daemon owns every worker-spawning or worker-stopping command.
 *
 * `--tier <csv>` is parsed into a strict tier-id array and forwarded as the
 * `tier` RPC parameter; malformed input fails before any daemon call.
 */

import { parseUuidRecordId } from "../../core/db/recordId";
import { readTierCsv, readTierFilter } from "../../core/indexer/tierFilter";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { AwakenRunResult } from "../../daemon/wire";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { runAwakenCancel } from "./awakenCancel";
import { runAwakenPause } from "./awakenPause";
import { runAwakenResume } from "./awakenResume";
import { runAwakenStatus } from "./awakenStatus";

export type AwakenControlMode = "pause" | "resume" | "cancel" | "status";

export interface AwakenCommandOptions {
  vaultPath: string;
  since?: number;
  /**
   * Tier filter forwarded as the `tier` RPC parameter. Defaults to
   * `[1, 2, 3]` when omitted. Callers must run a supplied raw `--tier`
   * value through `parseTierCsv` before reaching the wire.
   */
  tier?: number[];
  /**
   * When true, the daemon creates the `awaken_run` row, kicks the worker
   * off in the background, and returns the runId immediately. The CLI
   * then exits without streaming per-note progress; consumers poll via
   * `awaken --status` for run progress and reach for `--pause`,
   * `--resume`, or `--cancel` to drive the control plane.
   */
  background?: true;
  emitter: Emitter;
  clientIdentity?: string;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
  /**
   * Control-plane mode selected by the dispatcher. When omitted the command
   * starts a fresh awaken run via the daemon RPC handler.
   */
  mode?: AwakenControlMode;
}

export async function runAwakenCommand(options: AwakenCommandOptions): Promise<number> {
  if (options.mode === "pause") {
    return await runAwakenPause({
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
    });
  }
  if (options.mode === "cancel") {
    return await runAwakenCancel({
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
    });
  }
  if (options.mode === "resume") {
    return await runAwakenResume({
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
    });
  }
  if (options.mode === "status") {
    return await runAwakenStatus({
      vaultPath: options.vaultPath,
      clientIdentity: options.clientIdentity,
    });
  }
  return await startFreshAwaken(options);
}

/**
 * Parses a `--tier` CSV value into a sorted, de-duplicated array of valid
 * tier ids. Omission selects the full ladder. Any supplied empty, bare,
 * mixed-validity, or out-of-range value is an error.
 */
export function parseTierCsv(raw: string | boolean | undefined): number[] {
  return readTierCsv(raw);
}

/** Parse the documented ISO-8601 instant/date form without Date.parse aliases. */
export function parseAwakenSince(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    throw new Error("INVALID_PARAMS: --since requires an ISO-8601 date or timestamp");
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      raw,
    );
  if (match === null || !hasValidIsoFields(match)) {
    throw new Error("INVALID_PARAMS: --since requires an ISO-8601 date or timestamp");
  }
  const parsed = Date.parse(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("INVALID_PARAMS: --since must resolve to a non-negative timestamp");
  }
  return parsed;
}

function hasValidIsoFields(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  const zone = match[8];
  if (zone === undefined || zone === "Z") return true;
  const zoneHour = Number(zone.slice(1, 3));
  const zoneMinute = Number(zone.slice(4, 6));
  return zoneHour < 14 ? zoneMinute <= 59 : zoneHour === 14 && zoneMinute === 0;
}

async function startFreshAwaken(options: AwakenCommandOptions): Promise<number> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  let client: ClientHandle | undefined;
  let terminal: AwakenRunTerminal | undefined;
  let failure: Error | undefined;
  try {
    const params = buildAwakenRunParams(options);
    const connector = options.connect ?? connectClient;
    client = await connector({
      socketPath,
      vaultPath: options.vaultPath,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    });
    terminal = await readAwakenRunTerminal(client, params, options.emitter);
  } catch (error) {
    failure = asError(error);
  }
  failure = await closeAwakenClient(client, failure);
  if (failure !== undefined || terminal === undefined) {
    return emitAwakenFailure(
      options.emitter,
      failure?.message ?? "awaken.run returned no terminal frame",
    );
  }
  if (terminal.type === "error") {
    options.emitter.emit({ ...terminal.frame, type: "rpc:error" });
    return 1;
  }
  options.emitter.emit({ id: terminal.id, ...terminal.result, type: "rpc:result" });
  return 0;
}

function buildAwakenRunParams(options: AwakenCommandOptions): Record<string, unknown> {
  const tier = parseCanonicalTierOption(options.tier);
  const since = parseSinceOption(options.since);
  if (options.background !== undefined && options.background !== true) {
    throw new Error("background must be true when supplied");
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(tier === undefined ? {} : { tier }),
    ...(options.background === true ? { background: true } : {}),
  };
}

async function closeAwakenClient(
  client: ClientHandle | undefined,
  primary: Error | undefined,
): Promise<Error | undefined> {
  if (client === undefined) return primary;
  try {
    await client.close();
    return primary;
  } catch (error) {
    const closeFailure = asError(error);
    return primary === undefined
      ? new Error(`daemon connection close failed: ${closeFailure.message}`)
      : new Error(
          `${primary.message}; daemon connection close also failed: ${closeFailure.message}`,
        );
  }
}

type AwakenRunTerminal =
  | { type: "result"; id: string; result: AwakenRunResult }
  | { type: "error"; frame: RpcResponseFrame };

interface AwakenRunStreamState {
  requestId?: string;
  acknowledged: boolean;
  terminal?: RpcResponseFrame;
}

async function readAwakenRunTerminal(
  client: ClientHandle,
  params: Record<string, unknown>,
  emitter: Emitter,
): Promise<AwakenRunTerminal> {
  const state: AwakenRunStreamState = { acknowledged: false };
  for await (const frame of client.call("awaken.run", params)) {
    acceptAwakenRunFrame(state, frame, emitter);
  }
  if (state.terminal === undefined) throw new Error("awaken.run returned no result");
  if (state.terminal.type === "error") {
    assertAwakenErrorFrame(state.terminal);
    return { type: "error", frame: state.terminal };
  }
  return {
    type: "result",
    id: state.terminal.id,
    result: decodeAwakenRunResult(state.terminal),
  };
}

function acceptAwakenRunFrame(
  state: AwakenRunStreamState,
  frame: RpcResponseFrame,
  emitter: Emitter,
): void {
  const frameId = readFrameId(frame);
  if (state.requestId !== undefined && state.requestId !== frameId) {
    throw malformedAwakenRun("response ids changed within one stream");
  }
  state.requestId = frameId;
  if (frame.type === "ack") {
    acceptAwakenRunAck(state, frame);
    emitter.emit({ ...frame, type: "rpc:ack" });
    return;
  }
  if (frame.type === "event") {
    if (state.terminal !== undefined)
      throw malformedAwakenRun("received an event after termination");
    if (!state.acknowledged) throw malformedAwakenRun("received an event before ack");
    if (typeof frame.event !== "string" || frame.event.length === 0) {
      throw malformedAwakenRun("event name must be a nonblank string");
    }
    emitter.emit({ ...frame, type: "rpc:event" });
    return;
  }
  if (frame.type !== "result" && frame.type !== "error") {
    throw malformedAwakenRun("unknown response frame type");
  }
  if (!state.acknowledged) throw malformedAwakenRun("received a terminal frame before ack");
  if (state.terminal !== undefined) throw malformedAwakenRun("received duplicate terminal frames");
  state.terminal = frame;
}

function acceptAwakenRunAck(state: AwakenRunStreamState, frame: RpcResponseFrame): void {
  if (state.terminal !== undefined) throw malformedAwakenRun("received an ack after termination");
  if (state.acknowledged) throw malformedAwakenRun("received duplicate ack frames");
  assertExactKeys(frame, ["id", "type", "method"]);
  if (frame.method !== "awaken.run") throw malformedAwakenRun("ack method mismatch");
  state.acknowledged = true;
}

function decodeAwakenRunResult(frame: RpcResponseFrame): AwakenRunResult {
  const background = frame.background === true;
  const expected = background
    ? ["id", "type", "ok", "queued", "tier", "runId", "status", "background"]
    : ["id", "type", "ok", "queued", "tier", "runId", "status", "processed", "failed"];
  assertExactKeys(frame, expected);
  if (frame.ok !== true) throw malformedAwakenRun("result ok marker must be true");
  const queued = readCounter(frame.queued, "queued");
  const tier = parseCanonicalTierOption(frame.tier);
  if (tier === undefined) throw malformedAwakenRun("result tier is required");
  const runId = readRunId(frame.runId);
  const common = { ok: true as const, queued, tier, runId };
  if (background) {
    if (frame.status !== "running") throw malformedAwakenRun("background status must be running");
    return { ...common, status: "running", background: true };
  }
  if (frame.status !== "paused" && frame.status !== "cancelled" && frame.status !== "completed") {
    throw malformedAwakenRun("foreground status is invalid");
  }
  const processed = readCounter(frame.processed, "processed");
  const failed = readCounter(frame.failed, "failed");
  if (processed + failed > queued) {
    throw malformedAwakenRun("processed + failed cannot exceed queued");
  }
  return { ...common, status: frame.status, processed, failed };
}

function assertAwakenErrorFrame(frame: RpcResponseFrame): void {
  assertExactKeys(frame, ["id", "type", "code", "message", "detail"]);
  if (
    typeof frame.code !== "string" ||
    frame.code.length === 0 ||
    typeof frame.message !== "string" ||
    frame.message.length === 0 ||
    !isRecord(frame.detail)
  ) {
    throw malformedAwakenRun("error frame is malformed");
  }
}

function parseCanonicalTierOption(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  let tier: number[];
  try {
    tier = readTierFilter(value);
  } catch (error) {
    throw malformedAwakenRun(error instanceof Error ? error.message : "tier is invalid");
  }
  if (
    !Array.isArray(value) ||
    value.length !== tier.length ||
    value.some((entry, index) => entry !== tier[index])
  ) {
    throw malformedAwakenRun("tier must be a sorted, unique subset of 1, 2, and 3");
  }
  return tier;
}

function parseSinceOption(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformedAwakenRun("since must be a non-negative integer timestamp");
  }
  return value as number;
}

function readRunId(value: unknown): string {
  if (typeof value !== "string") throw malformedAwakenRun("runId must be a string");
  try {
    return parseUuidRecordId(value, "awaken_run", "runId").toString();
  } catch {
    throw malformedAwakenRun("runId must be a canonical awaken_run UUID");
  }
}

function readCounter(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformedAwakenRun(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function readFrameId(frame: RpcResponseFrame): string {
  if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.trim() !== frame.id) {
    throw malformedAwakenRun("frame id must be a canonical nonblank string");
  }
  return frame.id;
}

function assertExactKeys(frame: RpcResponseFrame, expected: readonly string[]): void {
  const keys = Object.keys(frame);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw malformedAwakenRun("response frame contains missing or unsupported fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedAwakenRun(reason: string): Error {
  return new Error(`awaken.run returned a malformed response: ${reason}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`non-Error failure: ${String(error)}`);
}

function emitAwakenFailure(emitter: Emitter, message: string): 1 {
  emitter.emit({ type: "error", code: "INTERNAL", message: `awaken: ${message}` });
  return 1;
}
