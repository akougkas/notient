import {
  AGENT_EVENT_TYPES,
  type AgentEventType,
  parseAgentEventRecordId,
} from "../../core/services/agentEventStore";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface EventsCommandOptions {
  vaultPath: string;
  since: string | null;
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
  emitter: Emitter;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

async function drainEventsCall(options: DrainEventsCallOptions): Promise<number> {
  for await (const frame of options.frames) {
    if (frame.type === "result") {
      renderResult(decodeEventsResult(frame), options.writeStdout);
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

function renderResult(result: EventsResult, writeStdout: (line: string) => void): void {
  for (const event of result.events) {
    writeStdout(JSON.stringify(event));
  }
  writeStdout(JSON.stringify({ type: "events:cursor", cursor: result.cursor }));
}

interface EventResultRow {
  id: string;
  ts: number;
  type: AgentEventType;
  payload: unknown;
}

interface EventsResult {
  events: EventResultRow[];
  cursor: string | null;
  longPollExpired: boolean;
}

const AGENT_EVENT_TYPE_SET = new Set<string>(AGENT_EVENT_TYPES);

function decodeEventsResult(frame: Record<string, unknown>): EventsResult {
  if (frame.ok !== true) throw malformedEventsResult("ok must be true");
  if (!Array.isArray(frame.events)) throw malformedEventsResult("events must be an array");
  const cursor = decodeCursor(frame.cursor, "cursor");
  if (typeof frame.longPollExpired !== "boolean") {
    throw malformedEventsResult("longPollExpired must be a boolean");
  }
  return {
    events: frame.events.map((event, index) => decodeEvent(event, index)),
    cursor,
    longPollExpired: frame.longPollExpired,
  };
}

function decodeEvent(raw: unknown, index: number): EventResultRow {
  if (!isRecord(raw)) throw malformedEventsResult(`events[${index}] must be an object`);
  const id = decodeCursor(raw.id, `events[${index}].id`);
  if (id === null) throw malformedEventsResult(`events[${index}].id must not be null`);
  if (typeof raw.ts !== "number" || !Number.isSafeInteger(raw.ts) || raw.ts < 0) {
    throw malformedEventsResult(`events[${index}].ts must be a non-negative integer`);
  }
  if (typeof raw.type !== "string" || !AGENT_EVENT_TYPE_SET.has(raw.type)) {
    throw malformedEventsResult(`events[${index}].type is not a persisted agent event type`);
  }
  if (!("payload" in raw)) throw malformedEventsResult(`events[${index}].payload is required`);
  return { id, ts: raw.ts, type: raw.type as AgentEventType, payload: raw.payload };
}

function decodeCursor(raw: unknown, label: string): string | null {
  if (raw === null) return null;
  try {
    return parseAgentEventRecordId(raw).toString();
  } catch {
    throw malformedEventsResult(`${label} must be null or a canonical agent_event UUID record id`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedEventsResult(reason: string): Error {
  return new Error(`agent.events returned a malformed result: ${reason}`);
}

export function parseEventsSince(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return parseAgentEventRecordId(value).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`INVALID_PARAMS: ${message}`);
  }
}

export function parseEventsPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`INVALID_PARAMS: --${label} must be a positive integer`);
  }
  return parsed;
}

export function parseEventsLongPollMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("INVALID_PARAMS: --long-poll-ms must be a non-negative integer");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error("INVALID_PARAMS: --long-poll-ms must be a non-negative integer");
  }
  return parsed;
}
