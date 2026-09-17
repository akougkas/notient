/**
 * `agent.events` RPC handler.
 *
 * Drains the `agent_event` ledger that `AgentEventStore` writes for watched
 * bus events. The wire shape is a curated, persisted, long-pollable channel:
 * a client passes the highest id it has already seen as `since`, and the
 * handler returns every newer row up to `limit`, plus a fresh cursor.
 *
 * The watched event set is AgentEventStore's canonical subscription list.
 * The store persists rows for the three `swarm:*` discoveries plus
 * `indexer:note-indexed`, `indexer:tombstoned`, `indexer:error`, and
 * `indexer:warn`. The long-poll subscribes to the canonical persisted-event
 * set so indexing and deletion activity wakes the waiter, not just swarm
 * activity.
 *
 * Long-poll path: when the first read returns no rows AND `longPollMs > 0`,
 * the handler subscribes to every watched bus event. The first event to fire
 * wins. The handler then waits a brief flush interval so the store's own
 * bus subscriber finishes its INSERT, re-reads the ledger, and returns. On
 * expiry, it returns `{ events: [], cursor: since, longPollExpired: true }`.
 *
 * Listener cleanup: every long-poll path goes through a try/finally that
 * invokes the unsubscribe functions returned by `bus.on`. There is no path
 * through the long-poll branch that leaves listeners attached.
 */

import type { EventBus } from "../../core/events/eventBus";
import type { EventOf } from "../../core/events/types";
import {
  AGENT_EVENT_TYPES,
  type AgentEventCursor,
  type AgentEventStore,
  type AgentEventType,
  parseAgentEventRecordId,
} from "../../core/services/agentEventStore";
import { type MethodHandler, RpcError } from "../rpc";

export interface AgentEventsHandlerDeps {
  agentEventStore: AgentEventStore;
  bus: EventBus;
}

export interface AgentEventsRequest {
  limit?: number;
  longPollMs?: number;
  since?: AgentEventCursor;
  snapshotSinceMs?: number;
  types?: AgentEventType[];
}

export interface AgentEventRecord {
  id: string;
  ts: number;
  type: AgentEventType;
  payload: unknown;
}

export interface AgentEventsResponse {
  events: AgentEventRecord[];
  cursor: AgentEventCursor;
  longPollExpired: boolean;
}

export type AgentEventsHandler = MethodHandler;

export const AGENT_EVENTS_DEFAULT_LIMIT = 100;
export const AGENT_EVENTS_MAX_LIMIT = 1000;
export const AGENT_EVENTS_DEFAULT_LONG_POLL_MS = 30_000;
export const AGENT_EVENTS_MAX_LONG_POLL_MS = 60_000;

/**
 * Window between the bus event firing and re-reading the ledger. The store
 * inserts its row synchronously in the same `bus.emit` call (see EventBus.emit
 * and AgentEventStore.record), so this delay only guards against a future
 * change that makes the store's subscriber asynchronous. 50ms is short enough
 * that callers do not feel it as latency and long enough that any near-future
 * async insert path would settle before the re-read.
 */
const FLUSH_INTERVAL_MS = 50;

interface CursorEventsParams {
  mode: "cursor";
  since: AgentEventCursor;
  limit: number;
  longPollMs: number;
}

interface SnapshotEventsParams {
  mode: "snapshot";
  sinceTs: number;
  limit: number;
  types: AgentEventType[];
}

type ParsedEventsParams = CursorEventsParams | SnapshotEventsParams;

export interface CreateAgentEventsHandlerOptions extends AgentEventsHandlerDeps {
  /** Test seam. Defaults to the 50ms guard documented on FLUSH_INTERVAL_MS. */
  flushIntervalMs?: number;
}

export function createAgentEventsHandler(
  options: CreateAgentEventsHandlerOptions,
): AgentEventsHandler {
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  return async ({ params }) => {
    const parsed = parseEventsParams(params);
    return await runEvents(options, parsed, flushIntervalMs);
  };
}

async function runEvents(
  deps: AgentEventsHandlerDeps,
  parsed: ParsedEventsParams,
  flushIntervalMs: number,
): Promise<Record<string, unknown>> {
  if (parsed.mode === "snapshot") {
    const snapshot = await deps.agentEventStore.snapshot(
      parsed.sinceTs,
      parsed.types,
      parsed.limit,
    );
    const response: AgentEventsResponse = {
      events: snapshot.events,
      cursor: snapshot.cursor,
      longPollExpired: false,
    };
    return { ok: true, ...response };
  }
  const firstRead = await deps.agentEventStore.since(parsed.since, parsed.limit);
  if (firstRead.length > 0) {
    return buildResponse({
      events: firstRead,
      since: parsed.since,
      longPollExpired: false,
    });
  }
  if (parsed.longPollMs === 0) {
    return buildResponse({
      events: [],
      since: parsed.since,
      longPollExpired: false,
    });
  }
  const fired = await waitForWatchedFire(deps.bus, parsed.longPollMs);
  if (!fired) {
    return buildResponse({
      events: [],
      since: parsed.since,
      longPollExpired: true,
    });
  }
  await delay(flushIntervalMs);
  const followUp = await deps.agentEventStore.since(parsed.since, parsed.limit);
  return buildResponse({
    events: followUp,
    since: parsed.since,
    longPollExpired: false,
  });
}

interface BuildResponseOptions {
  events: AgentEventRecord[];
  since: AgentEventCursor;
  longPollExpired: boolean;
}

function buildResponse(options: BuildResponseOptions): Record<string, unknown> {
  const cursor = options.events.at(-1)?.id ?? options.since;
  const response: AgentEventsResponse = {
    events: options.events,
    cursor,
    longPollExpired: options.longPollExpired,
  };
  return { ok: true, ...response };
}

/**
 * Subscribes to every watched event type and resolves to true on the first
 * fire, or false on timeout. Listener cleanup is unconditional: the finally
 * block runs every unsubscribe whether the race resolves via fire or
 * timeout, so concurrent or repeated calls cannot accumulate dead handlers
 * on the bus.
 */
async function waitForWatchedFire(bus: EventBus, longPollMs: number): Promise<boolean> {
  const unsubscribes: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (fired: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(fired);
      };
      for (const eventType of AGENT_EVENT_TYPES) {
        const unsubscribe = bus.on(eventType, makeFireOnce(settle));
        unsubscribes.push(unsubscribe);
      }
      timer = setTimeout(() => settle(false), longPollMs);
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
}

/**
 * Builds a one-shot bus handler. Because the EventBus invokes every handler
 * registered for a type, the subscribed handlers race on the same `settle`
 * latch and the first one wins. The handler ignores the event payload because
 * the rich row lands in `agent_events` via AgentEventStore's own subscriber;
 * this handler only signals that a fresh row exists to be read.
 */
function makeFireOnce(settle: (fired: boolean) => void) {
  return (_event: EventOf<AgentEventType>): void => {
    settle(true);
  };
}

function parseEventsParams(params: Record<string, unknown>): ParsedEventsParams {
  if (params.snapshotSinceMs !== undefined) {
    if (params.since !== undefined || params.longPollMs !== undefined) {
      throw new RpcError(
        "INVALID_PARAMS",
        "snapshotSinceMs cannot be combined with since or longPollMs",
      );
    }
    return {
      mode: "snapshot",
      sinceTs: parseSnapshotSinceMs(params.snapshotSinceMs),
      limit: parseLimit(params.limit),
      types: parseEventTypes(params.types),
    };
  }
  const since = parseSince(params.since);
  const limit = parseLimit(params.limit);
  const longPollMs = parseLongPollMs(params.longPollMs);
  return { mode: "cursor", since, limit, longPollMs };
}

function parseSnapshotSinceMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new RpcError("INVALID_PARAMS", "snapshotSinceMs must be a non-negative integer");
  }
  return raw;
}

function parseEventTypes(raw: unknown): AgentEventType[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RpcError("INVALID_PARAMS", "snapshot types must be a non-empty array");
  }
  const allowed = new Set<string>(AGENT_EVENT_TYPES);
  const types: AgentEventType[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new RpcError("INVALID_PARAMS", `unknown agent event type ${String(value)}`);
    }
    const type = value as AgentEventType;
    if (!types.includes(type)) types.push(type);
  }
  return types;
}

function parseSince(raw: unknown): AgentEventCursor {
  if (raw === undefined || raw === null) return null;
  try {
    return parseAgentEventRecordId(raw).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RpcError("INVALID_PARAMS", `since: ${message}`);
  }
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return AGENT_EVENTS_DEFAULT_LIMIT;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    raw > AGENT_EVENTS_MAX_LIMIT
  ) {
    throw new RpcError(
      "INVALID_PARAMS",
      `limit must be an integer between 1 and ${AGENT_EVENTS_MAX_LIMIT}`,
    );
  }
  return raw;
}

function parseLongPollMs(raw: unknown): number {
  if (raw === undefined || raw === null) return AGENT_EVENTS_DEFAULT_LONG_POLL_MS;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > AGENT_EVENTS_MAX_LONG_POLL_MS
  ) {
    throw new RpcError(
      "INVALID_PARAMS",
      `longPollMs must be an integer between 0 and ${AGENT_EVENTS_MAX_LONG_POLL_MS}`,
    );
  }
  return raw;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
