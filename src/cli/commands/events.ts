import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface EventsCommandOptions {
  vaultPath: string;
  since: number;
  limit?: number;
  longPollMs?: number;
  noPoll?: boolean;
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to writing to process.stdout/stderr with a trailing
   * newline. The runtime never threads this from the dispatcher; only tests
   * override it to capture output without spawning real sockets.
   */
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export async function runEventsCommand(options: EventsCommandOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? defaultStdoutWriter;
  const writeStderr = options.writeStderr ?? defaultStderrWriter;
  const params = buildRequestParams(options);

  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  try {
    return await drainEventsCall({
      frames: client.call("agent.events", params),
      since: options.since,
      emitter: options.emitter,
      writeStdout,
      writeStderr,
    });
  } finally {
    await client.close();
  }
}

function defaultStdoutWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderrWriter(line: string): void {
  process.stderr.write(`${line}\n`);
}

function buildRequestParams(options: EventsCommandOptions): Record<string, unknown> {
  if (!Number.isFinite(options.since) || options.since < 0 || !Number.isInteger(options.since)) {
    throw new Error("INVALID_PARAMS: events requires --since <non-negative integer>");
  }
  const params: Record<string, unknown> = { since: options.since };
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.noPoll === true) {
    params.longPollMs = 0;
  } else if (options.longPollMs !== undefined) {
    params.longPollMs = options.longPollMs;
  }
  return params;
}

interface DrainEventsCallOptions {
  frames: AsyncIterable<Record<string, unknown>>;
  since: number;
  emitter: Emitter;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

async function drainEventsCall(options: DrainEventsCallOptions): Promise<number> {
  for await (const frame of options.frames) {
    if (frame.type === "result") {
      renderResult(frame, options.since, options.writeStdout);
      return 0;
    }
    if (frame.type === "error") {
      const message = typeof frame.message === "string" ? frame.message : "agent.events failed";
      const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
      options.writeStderr(JSON.stringify({ type: "error", code, message }));
      options.emitter.emit({ type: "error", code, message });
      return 1;
    }
  }
  options.writeStderr("agent.events returned no result frame");
  return 1;
}

function renderResult(
  frame: Record<string, unknown>,
  fallbackCursor: number,
  writeStdout: (line: string) => void,
): void {
  const events = Array.isArray(frame.events) ? frame.events : [];
  for (const event of events) {
    writeStdout(JSON.stringify(event));
  }
  const cursor = typeof frame.cursor === "number" ? frame.cursor : fallbackCursor;
  writeStdout(JSON.stringify({ type: "events:cursor", cursor }));
}

export function parseEventsSince(value: unknown): number {
  if (value === undefined || value === null || value === true || value === false) {
    throw new Error("INVALID_PARAMS: events requires --since <non-negative integer>");
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: events requires --since <non-negative integer>");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error("INVALID_PARAMS: events requires --since <non-negative integer>");
  }
  return parsed;
}

export function parseEventsPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  return Math.floor(parsed);
}

export function parseEventsLongPollMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: --long-poll-ms must be a non-negative integer");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("INVALID_PARAMS: --long-poll-ms must be a non-negative integer");
  }
  return Math.floor(parsed);
}
