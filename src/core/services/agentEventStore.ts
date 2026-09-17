/**
 * Append-only ledger of operator-relevant bus events. The store self-subscribes
 * on construction so external clients (`notient events --since <cursor>`) can
 * drain a consistent stream from SurrealDB without each producer threading a
 * separate writer.
 *
 * Subscribed event set (kept narrow to bound ledger growth):
 *   - swarm:contradiction_discovered, swarm:claim_advanced, and
 *     swarm:link_proposed.
 *   - indexer:note-indexed, indexer:tombstoned, indexer:error, and
 *     indexer:warn (index completion, deletion, and diagnostics).
 *
 * Indexer events deliberately exclude `indexer:tier1-done`, `indexer:tier2-done`,
 * `indexer:tier3-done`, and `indexer:progress`. The tier-done events are
 * intermediate signals that fire alongside the per-note terminal
 * `indexer:note-indexed`; persisting all four would multiply ledger rows by
 * roughly 4x per note. `indexer:progress` is also too noisy. Operators get
 * per-note completion and deletion plus failures and dropped-ref warnings,
 * which is enough for the single-pane operator stream without inflating the
 * row count.
 *
 * Each event's native record id contains a UUIDv7. The ids are unique,
 * time-sortable, and serve directly as opaque cursors, so concurrent writers
 * never coordinate through a sequence allocator. A null cursor means the
 * beginning of the retained ledger.
 *
 * Async write semantics: `record` returns a Promise. Bus subscribers
 * fire-and-forget the write because `EventBus.emit` is sync. Every started
 * write is tracked until settlement; shutdown first unsubscribes via
 * `dispose()`, then awaits `drain()` before closing SurrealDB. The 50ms flush
 * guard in `agentEvents.ts` still accommodates the normal read-after-emit
 * window for long-poll clients.
 *
 * Each successful write drops rows beyond the configured retained window.
 */

import type { RecordId, Surreal } from "surrealdb";
import { unwrapNativeValue, wrapNativeValue } from "../db/nativeValue";
import {
  createUuidRecordId,
  parseStoredUuidRecordId,
  parseUuidRecordId,
  stringifyUuidRecordId,
} from "../db/recordId";
import { withSurrealRetry } from "../db/retry";
import type { EventBus } from "../events/eventBus";
import type { EventType } from "../events/types";

/** Canonical bus-event set persisted in and exposed from the agent ledger. */
export const AGENT_EVENT_TYPES = [
  "chat:usage",
  "job:changed",
  "swarm:contradiction_discovered",
  "swarm:claim_advanced",
  "swarm:link_proposed",
  "indexer:note-indexed",
  "indexer:tombstoned",
  "indexer:error",
  "indexer:warn",
] as const satisfies readonly EventType[];

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export type AgentEventCursor = string | null;

export class EventCursorExpiredError extends Error {
  constructor() {
    super("event cursor is unavailable or expired; refresh current state before resubscribing");
  }
}

export interface AgentEventRow {
  id: string;
  ts: number;
  type: AgentEventType;
  payload: unknown;
}

export interface AgentEventSnapshot {
  /** Newest record captured before the snapshot query began. */
  cursor: AgentEventCursor;
  events: AgentEventRow[];
}

export interface AgentEventStoreOptions {
  db: Surreal;
  bus: EventBus;
  /**
   * Required row-count cap on the `agent_event` ledger. Production supplies
   * a positive safe integer from
   * `<vault>/.notient/config.json` under `agentEvents.maxRows`.
   */
  maxRows: number;
}

interface PersistedRow {
  id: RecordId<"agent_event">;
  ts_ms: number;
  kind: string;
  payload: unknown;
}

interface CreatedRow {
  id: RecordId<"agent_event">;
  ts_ms: number;
}

export class AgentEventStore {
  private readonly db: Surreal;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly inFlightWrites = new Set<Promise<unknown>>();
  private readonly maxRows: number;
  private acceptingWrites = true;
  private writeTail: Promise<unknown> = Promise.resolve();
  private lastTimestamp: number | null = null;

  constructor(options: AgentEventStoreOptions) {
    assertPositiveSafeInteger(options.maxRows, "AgentEventStore maxRows");
    this.db = options.db;
    this.maxRows = options.maxRows;
    const { bus } = options;
    for (const eventType of AGENT_EVENT_TYPES) {
      this.unsubscribes.push(
        bus.on(eventType, ({ type: _type, ...payload }) => {
          this.safeRecord(eventType, payload);
        }),
      );
    }
  }

  /**
   * Bus subscriptions must never surface a rejection: an unhandled promise
   * from a ledger write took the daemon down mid-awaken once. Failures are
   * logged as a structured line and dropped.
   */
  private safeRecord(type: AgentEventType, payload: unknown): void {
    void this.record(type, payload).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ type: "agent_event:record_failed", kind: type, message })}\n`,
      );
    });
  }

  record(type: AgentEventType, payload: unknown): Promise<{ id: string; ts: number }> {
    if (!this.acceptingWrites) {
      return Promise.reject(new Error("AgentEventStore.record: store is disposed"));
    }
    const canonical = parseAgentEventType(type);
    // A cursor is committed before the next is allocated. Otherwise a fast
    // later write can become visible first and be skipped on reconnect.
    const write = this.writeTail.catch(() => {}).then(() => this.persist(canonical, payload));
    this.writeTail = write;
    this.inFlightWrites.add(write);
    void write.then(
      () => this.inFlightWrites.delete(write),
      () => this.inFlightWrites.delete(write),
    );
    return write;
  }

  private async persist(
    type: AgentEventType,
    payload: unknown,
  ): Promise<{ id: string; ts: number }> {
    const tsMs = Date.now();
    const eventKey = await this.nextKey();
    // A retry keeps the same record id. The existence guard therefore
    // recognizes a row whose commit landed even when its response was lost,
    // before attempting another CREATE.
    const sql = [
      "BEGIN;",
      "IF !record::exists($rowId) {",
      "  CREATE ONLY $rowId CONTENT { kind: $kind, payload: $payload, ts_ms: $tsMs };",
      "};",
      "COMMIT;",
      "SELECT id, ts_ms FROM $rowId;",
    ].join("\n");
    const results: unknown = await withSurrealRetry(
      ({ idempotencyKey }) =>
        this.db
          .query(sql, {
            kind: type,
            payload: wrapNativeValue(payload ?? null),
            rowId: createUuidRecordId("agent_event", idempotencyKey),
            tsMs,
          })
          .collect(),
      { idempotencyKey: eventKey },
    );
    const rows = readFinalStatementRows(results, "record");
    if (rows.length !== 1) {
      throw new Error(`agent event storage integrity: record returned ${rows.length} rows`);
    }
    const created = parseCreatedRow(rows[0], tsMs);
    await this.maybeSweep();
    return { id: storedAgentEventId(created.id), ts: created.ts_ms };
  }

  private async nextKey(): Promise<string> {
    if (this.lastTimestamp === null) {
      const latest = await this.latestId();
      this.lastTimestamp =
        latest === null ? 0 : Number.parseInt(latest.slice(14, 22) + latest.slice(23, 27), 16);
    }
    // Logical milliseconds keep UUIDv7 cursors ordered through wall-clock
    // rollback and process restart, without changing the existing id format.
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    const prefix = timestamp.toString(16).padStart(12, "0");
    return `${prefix.slice(0, 8)}-${prefix.slice(8)}-${Bun.randomUUIDv7().slice(14)}`;
  }

  /** A missing retained cursor requires an explicit client refresh. Checking
   * and reading in one transaction avoids a sweep between the two operations. */
  async resume(cursor: AgentEventCursor, limit: number): Promise<AgentEventRow[]> {
    assertPositiveSafeInteger(limit, "AgentEventStore resume limit");
    if (cursor === null) return this.since(null, limit);
    const result: unknown = await this.db
      .query(
        [
          "BEGIN;",
          "LET $retained = record::exists($cursor);",
          "LET $events = (SELECT id, kind, payload, ts_ms FROM agent_event WHERE id > $cursor ORDER BY id ASC LIMIT $limit);",
          "RETURN { retained: $retained, events: $events };",
          "COMMIT;",
        ].join("\n"),
        { cursor: parseAgentEventRecordId(cursor), limit },
      )
      .collect();
    const page = Array.isArray(result)
      ? result.find((entry) => isRecord(entry) && "retained" in entry)
      : undefined;
    if (!isRecord(page) || !Array.isArray(page.events))
      throw new Error("agent event resume returned an invalid page");
    if (page.retained !== true) throw new EventCursorExpiredError();
    return page.events.map(toAgentEventRow);
  }

  /**
   * Trim every row older than the newest retained window.
   */
  private async maybeSweep(): Promise<void> {
    const result: unknown = await this.db
      .query("SELECT id FROM agent_event ORDER BY id DESC START $keep;", {
        keep: this.maxRows,
      })
      .collect();
    const expired = readSingleStatementRows(result, "retention sweep");
    for (const raw of expired) {
      const id = parseStoredIdRow(raw, "retention sweep");
      await this.db.query("DELETE $id;", { id }).collect();
    }
  }

  async since(cursor: AgentEventCursor, limit: number): Promise<AgentEventRow[]> {
    assertPositiveSafeInteger(limit, "AgentEventStore since limit");
    const sql =
      cursor === null
        ? "SELECT id, kind, payload, ts_ms FROM agent_event ORDER BY id ASC LIMIT $limit;"
        : "SELECT id, kind, payload, ts_ms FROM agent_event WHERE id > $cursor ORDER BY id ASC LIMIT $limit;";
    const bindings: Record<string, unknown> = { limit };
    if (cursor !== null) bindings.cursor = parseAgentEventRecordId(cursor);
    const result: unknown = await this.db.query(sql, bindings).collect();
    const rows = readSingleStatementRows(result, "since");
    return rows.map(toAgentEventRow);
  }

  /**
   * Return the newest matching rows in a wall-clock window, ordered oldest to
   * newest for immediate rendering. The global cursor is captured first and
   * bounds the query, so a caller can continue with `since(cursor)` without
   * either replaying the snapshot or losing events written during the read.
   */
  async snapshot(
    sinceTs: number,
    types: readonly AgentEventType[],
    limit: number,
  ): Promise<AgentEventSnapshot> {
    assertNonNegativeSafeInteger(sinceTs, "AgentEventStore snapshot sinceTs");
    assertPositiveSafeInteger(limit, "AgentEventStore snapshot limit");
    const canonicalTypes = parseAgentEventTypes(types);
    const cursor = await this.latestId();
    if (cursor === null || canonicalTypes.length === 0) {
      return { cursor, events: [] };
    }
    const result: unknown = await this.db
      .query(
        [
          "SELECT id, kind, payload, ts_ms FROM agent_event",
          "WHERE ts_ms >= $sinceTs AND id <= $cursor AND kind INSIDE $types",
          "ORDER BY id DESC LIMIT $limit;",
        ].join(" "),
        {
          cursor: parseAgentEventRecordId(cursor),
          sinceTs,
          types: canonicalTypes,
          limit,
        },
      )
      .collect();
    const rows = readSingleStatementRows(result, "snapshot");
    const events = rows.reverse().map(toAgentEventRow);
    return { cursor, events };
  }

  async latestId(): Promise<AgentEventCursor> {
    const result: unknown = await this.db
      .query("SELECT id FROM agent_event ORDER BY id DESC LIMIT 1;")
      .collect();
    const rows = readSingleStatementRows(result, "latest id");
    if (rows.length > 1) {
      throw new Error(`agent event storage integrity: latest id returned ${rows.length} rows`);
    }
    return rows.length === 0 ? null : storedAgentEventId(parseStoredIdRow(rows[0], "latest id"));
  }

  async countSince(cursor: AgentEventCursor): Promise<number> {
    const sql =
      cursor === null
        ? "SELECT count() AS n FROM agent_event GROUP ALL;"
        : "SELECT count() AS n FROM agent_event WHERE id > $cursor GROUP ALL;";
    const bindings = cursor === null ? {} : { cursor: parseAgentEventRecordId(cursor) };
    const result: unknown = await this.db.query(sql, bindings).collect();
    const rows = readSingleStatementRows(result, "count");
    if (rows.length === 0) return 0;
    if (rows.length !== 1) {
      throw new Error(`agent event storage integrity: count returned ${rows.length} rows`);
    }
    return parseCountRow(rows[0]);
  }

  dispose(): void {
    this.acceptingWrites = false;
    while (this.unsubscribes.length > 0) {
      const off = this.unsubscribes.pop();
      off?.();
    }
  }

  /** Wait for every write that started before `dispose()` to settle. */
  async drain(): Promise<void> {
    while (this.inFlightWrites.size > 0) {
      await Promise.allSettled([...this.inFlightWrites]);
    }
  }
}

function toAgentEventRow(raw: unknown): AgentEventRow {
  if (!isRecord(raw)) {
    throw new Error("agent event storage integrity: persisted event row is not an object");
  }
  const row = raw as unknown as PersistedRow;
  const id = storedAgentEventId(row.id);
  assertNonNegativeSafeInteger(row.ts_ms, `agent event ${id} timestamp`);
  return {
    id,
    ts: row.ts_ms,
    type: parseAgentEventType(row.kind),
    payload: unwrapNativeValue(row.payload, `agent event ${id} payload`),
  };
}

function parseCreatedRow(raw: unknown, expectedTs: number): CreatedRow {
  if (!isRecord(raw)) {
    throw new Error("agent event storage integrity: created row is not an object");
  }
  const id = parseStoredIdRow(raw, "created row");
  assertNonNegativeSafeInteger(raw.ts_ms, "agent event created timestamp");
  if (raw.ts_ms !== expectedTs) {
    throw new Error("agent event storage integrity: created timestamp does not match the write");
  }
  return { id, ts_ms: raw.ts_ms };
}

function parseStoredIdRow(raw: unknown, label: string): RecordId<"agent_event"> {
  if (!isRecord(raw)) {
    throw new Error(`agent event storage integrity: ${label} row is not an object`);
  }
  try {
    return parseStoredUuidRecordId(raw.id, "agent_event", `${label} id`);
  } catch {
    throw new Error(
      `agent event storage integrity: ${label} id must be a native agent_event UUID record id`,
    );
  }
}

function parseCountRow(raw: unknown): number {
  if (!isRecord(raw)) {
    throw new Error("agent event storage integrity: count row is not an object");
  }
  assertNonNegativeSafeInteger(raw.n, "agent event count");
  return raw.n;
}

function parseAgentEventType(raw: unknown): AgentEventType {
  if (typeof raw !== "string" || !AGENT_EVENT_TYPES.includes(raw as AgentEventType)) {
    throw new Error("agent event storage integrity: kind is not a supported event type");
  }
  return raw as AgentEventType;
}

function parseAgentEventTypes(raw: readonly AgentEventType[]): AgentEventType[] {
  if (!Array.isArray(raw)) {
    throw new Error("AgentEventStore snapshot types must be an array");
  }
  return raw.map(parseAgentEventType);
}

function readSingleStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(
      `agent event storage integrity: ${operation} returned an invalid statement envelope`,
    );
  }
  return raw[0];
}

function readFinalStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `agent event storage integrity: ${operation} returned an invalid statement envelope`,
    );
  }
  const final = raw[raw.length - 1];
  if (!Array.isArray(final)) {
    throw new Error(
      `agent event storage integrity: ${operation} returned an invalid final statement`,
    );
  }
  return final;
}

function assertPositiveSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(raw: unknown, label: string): asserts raw is number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function storedAgentEventId(raw: unknown): string {
  try {
    return stringifyUuidRecordId(raw, "agent_event", "agent event storage id");
  } catch {
    throw new Error(
      "agent event storage integrity failure: id must be a native agent_event UUID record id",
    );
  }
}

export function parseAgentEventRecordId(raw: unknown): RecordId<"agent_event"> {
  return parseUuidRecordId(raw, "agent_event", "event cursor");
}
