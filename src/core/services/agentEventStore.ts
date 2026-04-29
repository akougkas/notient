/**
 * Append-only ledger of swarm discoveries. The store self-subscribes to the
 * four `swarm:*` bus events on construction so external clients (Phase D1
 * `notient events --since <cursor>`) can drain a consistent stream from
 * SurrealDB without each producer threading a separate writer.
 *
 * Phase 4 Task 12 migrated the storage backend from SQLite to SurrealDB.
 * The wire-shape contract is unchanged: `record` returns `{ id, ts }`,
 * `since(cursor, limit)` returns rows whose id is strictly greater than
 * `cursor` in ascending order, `latestId` returns 0 when empty and the
 * highest id otherwise, and `countSince` returns the row count after the
 * cursor.
 *
 * Cursor strategy: SurrealDB has no AUTOINCREMENT, so each row carries a
 * `seq` field assigned monotonically inside a `BEGIN; ...; COMMIT;` block.
 * The bus emits events serially on a single thread, so concurrent writes
 * are not a real concern; the transaction is defense-in-depth against any
 * future producer that fans out the bus emit. `seq` is the wire id.
 *
 * Async write semantics: `record` returns a Promise. The four bus
 * subscribers fire-and-forget the write because `EventBus.emit` is sync.
 * The 50ms flush guard in `agentEvents.ts` accommodates the brief async
 * window between bus.emit and the resulting CREATE landing.
 */

import type { RecordId, Surreal } from "surrealdb";
import type { EventBus } from "../events/eventBus";

export type AgentEventType =
  | "swarm:contradiction_discovered"
  | "swarm:cluster_emerged"
  | "swarm:claim_advanced"
  | "swarm:link_proposed";

export interface AgentEventRow {
  id: number;
  ts: number;
  type: AgentEventType;
  payload: unknown;
}

export interface AgentEventStoreOptions {
  db: Surreal;
  bus: EventBus;
}

interface PersistedRow {
  id: RecordId<"agent_event">;
  seq: number;
  ts_ms: number;
  kind: string;
  payload: string | null | undefined;
}

interface CreatedRow {
  seq: number;
  ts_ms: number;
}

interface CountRow {
  n: number;
}

interface SeqRow {
  seq: number;
}

export class AgentEventStore {
  private readonly db: Surreal;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: AgentEventStoreOptions) {
    this.db = options.db;
    const { bus } = options;
    this.unsubscribes.push(
      bus.on("swarm:contradiction_discovered", ({ type: _t, ...payload }) => {
        void this.record("swarm:contradiction_discovered", payload);
      }),
      bus.on("swarm:cluster_emerged", ({ type: _t, ...payload }) => {
        void this.record("swarm:cluster_emerged", payload);
      }),
      bus.on("swarm:claim_advanced", ({ type: _t, ...payload }) => {
        void this.record("swarm:claim_advanced", payload);
      }),
      bus.on("swarm:link_proposed", ({ type: _t, ...payload }) => {
        void this.record("swarm:link_proposed", payload);
      }),
    );
  }

  async record(type: AgentEventType, payload: unknown): Promise<{ id: number; ts: number }> {
    const tsMs = Date.now();
    const serialized = JSON.stringify(payload ?? null);
    // Multi-statement query: SurrealDB returns one result slice per
    // statement. The CREATE result lands in the final slice; we read the
    // freshly-assigned seq + ts_ms back so the caller sees the same shape
    // the SQLite mirror returned (`{ id, ts }`).
    const sql = [
      "BEGIN;",
      "LET $next = (SELECT VALUE seq FROM agent_event ORDER BY seq DESC LIMIT 1)[0];",
      "LET $row = CREATE ONLY agent_event CONTENT { seq: ($next ?? 0) + 1, kind: $kind, payload: $payload, ts_ms: $tsMs };",
      "COMMIT;",
      "SELECT seq, ts_ms FROM agent_event WHERE ts_ms = $tsMs AND kind = $kind ORDER BY seq DESC LIMIT 1;",
    ].join("\n");
    const results = await this.db
      .query(sql, {
        kind: type,
        payload: serialized,
        tsMs,
      })
      .collect<unknown[]>();
    const lastSlice = results[results.length - 1];
    const rows = (Array.isArray(lastSlice) ? (lastSlice as CreatedRow[]) : []) as CreatedRow[];
    const created = rows[0];
    if (created === undefined) {
      throw new Error("AgentEventStore.record: SurrealDB returned no row");
    }
    return { id: created.seq, ts: created.ts_ms };
  }

  async since(cursor: number, limit: number): Promise<AgentEventRow[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const [rows] = await this.db
      .query<[PersistedRow[]]>(
        "SELECT id, seq, kind, payload, ts_ms FROM agent_event WHERE seq > $cursor ORDER BY seq ASC LIMIT $limit;",
        { cursor, limit: Math.floor(limit) },
      )
      .collect<[PersistedRow[]]>();
    return rows.map((row) => ({
      id: row.seq,
      ts: row.ts_ms,
      type: row.kind as AgentEventType,
      payload: parsePayload(row.payload),
    }));
  }

  async latestId(): Promise<number> {
    const [rows] = await this.db
      .query<[SeqRow[]]>("SELECT seq FROM agent_event ORDER BY seq DESC LIMIT 1;")
      .collect<[SeqRow[]]>();
    return rows[0]?.seq ?? 0;
  }

  async countSince(cursor: number): Promise<number> {
    const [rows] = await this.db
      .query<[CountRow[]]>("SELECT count() AS n FROM agent_event WHERE seq > $cursor GROUP ALL;", {
        cursor,
      })
      .collect<[CountRow[]]>();
    return rows[0]?.n ?? 0;
  }

  dispose(): void {
    while (this.unsubscribes.length > 0) {
      const off = this.unsubscribes.pop();
      off?.();
    }
  }
}

function parsePayload(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
