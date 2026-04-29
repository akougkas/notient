/**
 * agent.events RPC handler (Phase D1 T6).
 *
 * Drains the `agent_events` ledger that AgentEventStore (T2) writes when any
 * of the four `swarm:*` discoveries fire on the bus. The wire shape is a
 * curated, persisted, long-pollable channel: a client passes the highest id
 * it has already seen as `since`, and the handler returns every newer row up
 * to `limit`, plus a fresh cursor.
 *
 * Long-poll path: when the first read returns no rows AND `longPollMs > 0`,
 * the handler subscribes to the four swarm bus events. The first event to
 * fire wins. The handler then waits a brief flush interval so the store's
 * own bus subscriber finishes its INSERT, re-reads the ledger, and returns.
 * On expiry, it returns `{ events: [], cursor: since, longPollExpired: true }`.
 *
 * Listener cleanup: every long-poll path goes through a try/finally that
 * invokes the four unsubscribe functions returned by `bus.on`. There is no
 * path through the long-poll branch that leaves listeners attached.
 */

import type { EventBus } from "../../core/events/eventBus";
import type { EventOf, EventType } from "../../core/events/types";
import type { AgentEventStore } from "../../core/services/agentEventStore";

export interface AgentEventsHandlerDeps {
  agentEventStore: AgentEventStore;
  bus: EventBus;
}

export interface AgentEventsRequest {
  since: number;
  clientIdentity?: string;
  limit?: number;
  longPollMs?: number;
}

export interface AgentEventRecord {
  id: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface AgentEventsResponse {
  events: AgentEventRecord[];
  cursor: number;
  longPollExpired: boolean;
}

export type AgentEventsHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

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

const SWARM_EVENT_TYPES = [
  "swarm:contradiction_discovered",
  "swarm:cluster_emerged",
  "swarm:claim_advanced",
  "swarm:link_proposed",
] as const satisfies readonly EventType[];

interface ParsedEventsParams {
  since: number;
  limit: number;
  longPollMs: number;
}

export interface CreateAgentEventsHandlerOptions extends AgentEventsHandlerDeps {
  /** Test seam. Defaults to the 50ms guard documented on FLUSH_INTERVAL_MS. */
  flushIntervalMs?: number;
}

export function createAgentEventsHandler(
  options: CreateAgentEventsHandlerOptions,
): AgentEventsHandler {
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  return async (params) => {
    const parsed = parseEventsParams(params);
    return await runEvents(options, parsed, flushIntervalMs);
  };
}

async function runEvents(
  deps: AgentEventsHandlerDeps,
  parsed: ParsedEventsParams,
  flushIntervalMs: number,
): Promise<Record<string, unknown>> {
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
  const fired = await waitForSwarmFire(deps.bus, parsed.longPollMs);
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
  since: number;
  longPollExpired: boolean;
}

function buildResponse(options: BuildResponseOptions): Record<string, unknown> {
  const cursor =
    options.events.length === 0
      ? options.since
      : options.events.reduce((highest, event) => Math.max(highest, event.id), options.since);
  const response: AgentEventsResponse = {
    events: options.events,
    cursor,
    longPollExpired: options.longPollExpired,
  };
  return { ok: true, ...response };
}

/**
 * Subscribes to the four swarm event types and resolves to true on the first
 * fire, or false on timeout. Listener cleanup is unconditional: the finally
 * block runs all four unsubscribes whether the race resolves via fire or
 * timeout, so concurrent or repeated calls cannot accumulate dead handlers
 * on the bus.
 */
async function waitForSwarmFire(bus: EventBus, longPollMs: number): Promise<boolean> {
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
      for (const eventType of SWARM_EVENT_TYPES) {
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
 * registered for a type, four subscribed handlers race on the same `settle`
 * latch and the first one wins. The handler ignores the event payload because
 * the rich row lands in `agent_events` via AgentEventStore's own subscriber;
 * this handler only signals that a fresh row exists to be read.
 */
function makeFireOnce(settle: (fired: boolean) => void) {
  return (_event: EventOf<(typeof SWARM_EVENT_TYPES)[number]>): void => {
    settle(true);
  };
}

function parseEventsParams(params: Record<string, unknown>): ParsedEventsParams {
  const since = parseSince(params.since);
  const limit = parseLimit(params.limit);
  const longPollMs = parseLongPollMs(params.longPollMs);
  return { since, limit, longPollMs };
}

function parseSince(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new Error("INVALID_PARAMS: since must be a non-negative integer");
  }
  return raw;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return AGENT_EVENTS_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("INVALID_PARAMS: limit must be a positive number");
  }
  return clamp(Math.floor(raw), 1, AGENT_EVENTS_MAX_LIMIT);
}

function parseLongPollMs(raw: unknown): number {
  if (raw === undefined || raw === null) return AGENT_EVENTS_DEFAULT_LONG_POLL_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error("INVALID_PARAMS: longPollMs must be a non-negative number");
  }
  return clamp(Math.floor(raw), 0, AGENT_EVENTS_MAX_LONG_POLL_MS);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
