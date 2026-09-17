/** `notient awaken --status` reads run state through the owning vault daemon. */

import type { AwakenStatus } from "../../core/awaken/awakenRun";
import { parseUuidRecordId } from "../../core/db/recordId";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { AwakenStatusWire } from "../../daemon/wire";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";

export interface AwakenStatusOptions {
  vaultPath: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Keep polling the initially selected run until it reaches a terminal state. */
  follow?: boolean;
  clientIdentity?: string;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

const RPC_TIMEOUT_MS = 10_000;

interface StatusFrame {
  type: "awaken:status";
  runId: string;
  status: AwakenStatus;
  processed: number;
  failed: number;
  total: number;
  perSecond: number;
  etaSeconds: number | null;
}

interface PollContext {
  stdout: (line: string) => void;
  intervalMs: number;
  signal: AbortSignal | undefined;
  follow: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<AwakenStatus> = new Set(["completed", "cancelled", "failed"]);

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function runAwakenStatus(options: AwakenStatusOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  let client: ClientHandle | undefined;
  let exitCode: number | undefined;
  let failure: Error | undefined;
  try {
    const intervalMs = readPollInterval(options.pollIntervalMs);
    const connector = options.connect ?? connectClient;
    client = await connector({
      socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
      vaultPath: options.vaultPath,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    });
    exitCode = await pollUntilTerminal(client, {
      stdout,
      intervalMs,
      signal: options.signal,
      follow: options.follow === true,
    });
  } catch (error) {
    failure = asError(error);
  }
  failure = await closeStatusClient(client, failure);
  if (failure !== undefined || exitCode === undefined) {
    stderr(`awaken --status: ${failure?.message ?? "command ended without an exit status"}`);
    return 1;
  }
  return exitCode;
}

function readPollInterval(value: number | undefined): number {
  const intervalMs = value ?? 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error("pollIntervalMs must be a non-negative integer");
  }
  return intervalMs;
}

async function closeStatusClient(
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

async function pollUntilTerminal(client: ClientHandle, context: PollContext): Promise<number> {
  if (context.signal?.aborted === true) return 0;
  const initial = await readStatus(client);
  if (initial === null) {
    context.stdout(JSON.stringify({ type: "awaken:status", status: "none" }));
    return 0;
  }
  context.stdout(JSON.stringify(buildFrame(initial)));
  if (!context.follow || TERMINAL_STATUSES.has(initial.status)) return 0;

  while (true) {
    if (await sleepOrAbort(context.intervalMs, context.signal)) return 0;
    const row = await readStatus(client, initial.runId);
    if (row === null) {
      throw new Error(`awaken.status lost the locked run '${initial.runId}'`);
    }
    context.stdout(JSON.stringify(buildFrame(row)));
    if (TERMINAL_STATUSES.has(row.status)) return 0;
  }
}

async function readStatus(client: ClientHandle, runId?: string): Promise<AwakenStatusWire | null> {
  return await withTimeout(readStatusWithoutTimeout(client, runId), "awaken --status: daemon RPC");
}

async function readStatusWithoutTimeout(
  client: ClientHandle,
  runId?: string,
): Promise<AwakenStatusWire | null> {
  const params = runId === undefined ? {} : { runId };
  const state: StatusStreamState = { acknowledged: false };
  for await (const frame of client.call("awaken.status", params)) {
    acceptStatusFrame(state, frame);
  }
  if (state.terminal === undefined) throw new Error("awaken.status returned no result");
  if (state.terminal.type === "error") throw rpcFrameError(state.terminal);
  return decodeStatusResult(state.terminal);
}

function rpcFrameError(frame: RpcResponseFrame): Error {
  assertExactFrameKeys(frame, ["id", "type", "code", "message", "detail"]);
  if (
    typeof frame.code !== "string" ||
    frame.code.length === 0 ||
    typeof frame.message !== "string" ||
    frame.message.length === 0 ||
    !isRecord(frame.detail)
  ) {
    throw malformedStatus("error frame is malformed");
  }
  return new Error(`${frame.code}: ${frame.message}`);
}

interface StatusStreamState {
  requestId?: string;
  acknowledged: boolean;
  terminal?: RpcResponseFrame;
}

function acceptStatusFrame(state: StatusStreamState, frame: RpcResponseFrame): void {
  const frameId = readFrameId(frame);
  if (state.requestId !== undefined && state.requestId !== frameId) {
    throw malformedStatus("response ids changed within one stream");
  }
  state.requestId = frameId;
  if (frame.type === "ack") {
    if (state.terminal !== undefined) throw malformedStatus("received a frame after termination");
    if (state.acknowledged) throw malformedStatus("received duplicate ack frames");
    assertExactFrameKeys(frame, ["id", "type", "method"]);
    if (frame.method !== "awaken.status") throw malformedStatus("ack method mismatch");
    state.acknowledged = true;
    return;
  }
  if (frame.type === "event") throw malformedStatus("status cannot emit event frames");
  if (frame.type !== "result" && frame.type !== "error") {
    throw malformedStatus("unknown response frame type");
  }
  if (!state.acknowledged) throw malformedStatus("received a terminal frame before ack");
  if (state.terminal !== undefined) throw malformedStatus("received duplicate terminal frames");
  state.terminal = frame;
}

function decodeStatusResult(frame: RpcResponseFrame): AwakenStatusWire | null {
  assertExactFrameKeys(frame, ["id", "type", "ok", "run"]);
  if (frame.ok !== true) throw malformedStatus("result ok marker must be true");
  if (frame.run === null) return null;
  return parseStatusWire(frame.run);
}

function parseStatusWire(value: unknown): AwakenStatusWire {
  if (!isRecord(value)) throw malformedStatus("run must be an object or null");
  const row = value;
  const expectedKeys = ["runId", "status", "processed", "failed", "total", "startedAt"];
  if (!hasExactKeys(row, expectedKeys)) throw malformedStatus("run fields are not exact");
  const status = row.status;
  if (
    !isAwakenStatus(status) ||
    !isNonNegativeInteger(row.processed) ||
    !isNonNegativeInteger(row.failed) ||
    !isNonNegativeInteger(row.total) ||
    !isNonNegativeInteger(row.startedAt) ||
    row.processed + row.failed > row.total
  ) {
    throw malformedStatus("run status, counters, or timestamp is invalid");
  }
  if (typeof row.runId !== "string") throw malformedStatus("runId must be a string");
  let runId: string;
  try {
    runId = parseUuidRecordId(row.runId, "awaken_run", "runId").toString();
  } catch {
    throw malformedStatus("runId must be a canonical awaken_run UUID");
  }
  return {
    runId,
    status,
    processed: row.processed,
    failed: row.failed,
    total: row.total,
    startedAt: row.startedAt,
  };
}

function readFrameId(frame: RpcResponseFrame): string {
  if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.trim() !== frame.id) {
    throw malformedStatus("frame id must be a canonical nonblank string");
  }
  return frame.id;
}

function assertExactFrameKeys(frame: RpcResponseFrame, expected: readonly string[]): void {
  if (!hasExactKeys(frame, expected)) {
    throw malformedStatus("response frame contains missing or unsupported fields");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function malformedStatus(reason: string): Error {
  return new Error(`awaken.status returned an invalid response: ${reason}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`non-Error failure: ${String(error)}`);
}

function isAwakenStatus(value: unknown): value is AwakenStatus {
  return (
    value === "running" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "failed"
  );
}

function buildFrame(row: AwakenStatusWire): StatusFrame {
  const elapsedSeconds = (Date.now() - row.startedAt) / 1000;
  const perSecond = elapsedSeconds >= 1 && row.processed > 0 ? row.processed / elapsedSeconds : 0;
  const remaining = Math.max(row.total - row.processed, 0);
  const etaSeconds = perSecond > 0 && remaining > 0 ? remaining / perSecond : null;
  return {
    type: "awaken:status",
    runId: row.runId,
    status: row.status,
    processed: row.processed,
    failed: row.failed,
    total: row.total,
    perSecond,
    etaSeconds,
  };
}

function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(true);
    }
    if (signal === undefined) return;
    if (signal.aborted) {
      clearTimeout(timer);
      resolve(true);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
