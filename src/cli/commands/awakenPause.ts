/**
 * `notient awaken --pause` thin-client handler.
 *
 * Calls the daemon's `awaken.pause` RPC so the process that owns the in-memory
 * background-worker registry also owns the status transition. A pause cannot
 * report success while untracked work continues to drain.
 *
 * Locked invariants:
 *   - No-op with exit 1 and a stderr message when no current run exists.
 *   - Never calls `runAwakenWorker` directly; the CLI is a thin client over
 *     the daemon RPC.
 */

import { parseUuidRecordId } from "../../core/db/recordId";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type {
  AwakenCancelResult,
  AwakenControlResult,
  AwakenPauseResult,
  AwakenResumeResult,
} from "../../daemon/wire";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";

export interface AwakenControlClientOptions {
  vaultPath: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  clientIdentity?: string;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

export interface AwakenPauseOptions extends AwakenControlClientOptions {}

export type AwakenControlVerb = "pause" | "resume" | "cancel";

const CONTROL_DESCRIPTORS = {
  pause: {
    method: "awaken.pause",
    outputType: "awaken:paused",
    status: "paused",
    draining: true,
  },
  resume: {
    method: "awaken.resume",
    outputType: "awaken:resumed",
    status: "running",
    draining: false,
  },
  cancel: {
    method: "awaken.cancel",
    outputType: "awaken:cancelled",
    status: "cancelled",
    draining: true,
  },
} as const;

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function runAwakenPause(options: AwakenPauseOptions): Promise<number> {
  return await runAwakenControl(options, "pause");
}

/**
 * One exact RPC reader for all awaken control verbs. The daemon owns the
 * state transition; the CLI prints success only after both the terminal
 * frame and connection close have completed without an integrity failure.
 */
export async function runAwakenControl(
  options: AwakenControlClientOptions,
  verb: AwakenControlVerb,
): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const descriptor = CONTROL_DESCRIPTORS[verb];
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  let client: ClientHandle | undefined;
  let result: AwakenControlResult | undefined;
  let failure: Error | undefined;
  try {
    const connector = options.connect ?? connectClient;
    client = await connector({
      socketPath,
      vaultPath: options.vaultPath,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    });
    result = await readAwakenControlResult(client, verb);
  } catch (error) {
    failure = asError(error);
  }
  if (client !== undefined) {
    try {
      await client.close();
    } catch (error) {
      const closeFailure = asError(error);
      failure =
        failure === undefined
          ? new Error(`daemon connection close failed: ${closeFailure.message}`)
          : new Error(
              `${failure.message}; daemon connection close also failed: ${closeFailure.message}`,
            );
    }
  }
  if (failure !== undefined || result === undefined) {
    stderr(`awaken --${verb}: ${failure?.message ?? `${descriptor.method} returned no result`}`);
    return 1;
  }

  const output: Record<string, unknown> = {
    type: descriptor.outputType,
    runId: result.runId,
    processed: result.processed,
    failed: result.failed,
    total: result.total,
    status: result.status,
  };
  if ("draining" in result) output.draining = result.draining;
  stdout(JSON.stringify(output));
  return 0;
}

async function readAwakenControlResult(
  client: ClientHandle,
  verb: AwakenControlVerb,
): Promise<AwakenControlResult> {
  const descriptor = CONTROL_DESCRIPTORS[verb];
  const state: ControlStreamState = { acknowledged: false };
  for await (const frame of client.call(descriptor.method, {})) {
    acceptControlFrame(state, frame, verb, descriptor.method);
  }
  if (state.terminal === undefined) throw new Error(`${descriptor.method} returned no result`);
  if (state.terminal.type === "error") throw decodeRpcError(state.terminal, verb);
  return decodeAwakenControlResult(state.terminal, verb);
}

interface ControlStreamState {
  requestId?: string;
  acknowledged: boolean;
  terminal?: RpcResponseFrame;
}

function acceptControlFrame(
  state: ControlStreamState,
  frame: RpcResponseFrame,
  verb: AwakenControlVerb,
  method: string,
): void {
  const frameId = readFrameId(frame);
  if (state.requestId !== undefined && frameId !== state.requestId) {
    throw malformedControl(verb, "response ids changed within one stream");
  }
  state.requestId = frameId;
  if (frame.type === "ack") {
    acceptControlAck(state, frame, verb, method);
    return;
  }
  if (frame.type === "event") {
    throw malformedControl(verb, "control methods cannot emit event frames");
  }
  if (frame.type !== "result" && frame.type !== "error") {
    throw malformedControl(verb, "unknown response frame type");
  }
  if (!state.acknowledged) throw malformedControl(verb, "received a terminal frame before ack");
  if (state.terminal !== undefined) {
    throw malformedControl(verb, "received duplicate terminal frames");
  }
  state.terminal = frame;
}

function acceptControlAck(
  state: ControlStreamState,
  frame: RpcResponseFrame,
  verb: AwakenControlVerb,
  method: string,
): void {
  if (state.terminal !== undefined) {
    throw malformedControl(verb, "received a frame after termination");
  }
  if (state.acknowledged) throw malformedControl(verb, "received duplicate ack frames");
  assertExactKeys(frame, ["id", "type", "method"], verb);
  if (frame.method !== method) throw malformedControl(verb, "ack method mismatch");
  state.acknowledged = true;
}

function decodeAwakenControlResult(
  frame: RpcResponseFrame,
  verb: AwakenControlVerb,
): AwakenControlResult {
  const descriptor = CONTROL_DESCRIPTORS[verb];
  const keys = ["id", "type", "ok", "runId", "processed", "failed", "total", "status"];
  if (descriptor.draining) keys.push("draining");
  assertExactKeys(frame, keys, verb);
  if (frame.ok !== true || frame.status !== descriptor.status) {
    throw malformedControl(verb, "result status or ok marker is invalid");
  }
  if (typeof frame.runId !== "string") {
    throw malformedControl(verb, "runId must be a canonical awaken_run UUID");
  }
  let runId: string;
  try {
    runId = parseUuidRecordId(frame.runId, "awaken_run", "runId").toString();
  } catch {
    throw malformedControl(verb, "runId must be a canonical awaken_run UUID");
  }
  const processed = readCounter(frame.processed, "processed", verb);
  const failed = readCounter(frame.failed, "failed", verb);
  const total = readCounter(frame.total, "total", verb);
  if (processed + failed > total) {
    throw malformedControl(verb, "processed + failed cannot exceed total");
  }
  const counters = { ok: true as const, runId, processed, failed, total };
  if (verb === "pause") {
    if (typeof frame.draining !== "boolean")
      throw malformedControl(verb, "draining must be boolean");
    return { ...counters, status: "paused", draining: frame.draining } satisfies AwakenPauseResult;
  }
  if (verb === "cancel") {
    if (typeof frame.draining !== "boolean")
      throw malformedControl(verb, "draining must be boolean");
    return {
      ...counters,
      status: "cancelled",
      draining: frame.draining,
    } satisfies AwakenCancelResult;
  }
  return { ...counters, status: "running" } satisfies AwakenResumeResult;
}

function decodeRpcError(frame: RpcResponseFrame, verb: AwakenControlVerb): Error {
  assertExactKeys(frame, ["id", "type", "code", "message", "detail"], verb);
  if (
    typeof frame.code !== "string" ||
    frame.code.length === 0 ||
    typeof frame.message !== "string" ||
    frame.message.length === 0 ||
    !isRecord(frame.detail)
  ) {
    throw malformedControl(verb, "error frame is malformed");
  }
  return new Error(`${frame.code}: ${frame.message}`);
}

function readCounter(value: unknown, field: string, verb: AwakenControlVerb): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformedControl(verb, `${field} must be a non-negative integer`);
  }
  return value as number;
}

function readFrameId(frame: RpcResponseFrame): string {
  if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.trim() !== frame.id) {
    throw new Error("awaken control RPC returned an invalid frame id");
  }
  return frame.id;
}

function assertExactKeys(
  frame: RpcResponseFrame,
  expected: readonly string[],
  verb: AwakenControlVerb,
): void {
  const keys = Object.keys(frame);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw malformedControl(verb, "response frame contains missing or unsupported fields");
  }
}

function malformedControl(verb: AwakenControlVerb, reason: string): Error {
  return new Error(`awaken.${verb} returned a malformed response: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`non-Error failure: ${String(error)}`);
}
