/**
 * Append-only ledger of operator-relevant bus events. The store self-subscribes
 * on construction so external clients (Phase D1 `notient events --since
 * <cursor>`) can drain a consistent stream from SurrealDB without each
 * producer threading a separate writer.
 *
 * Subscribed event set (kept narrow to bound ledger growth):
 *   - swarm:contradiction_discovered, swarm:cluster_emerged,
 *     swarm:claim_advanced, swarm:link_proposed (the original four).
 *   - indexer:note-indexed, indexer:error, indexer:warn (added so the
 *     `events` RPC surfaces vault-indexing progress).
 *
 * Indexer events deliberately exclude `indexer:tier1-done`, `indexer:tier2-done`,
 * `indexer:tier3-done`, and `indexer:progress`. The tier-done events are
 * intermediate signals that fire alongside the per-note terminal
 * `indexer:note-indexed`; persisting all four would multiply ledger rows by
 * roughly 4x per note. `indexer:progress` is also too noisy. Operators get
 * per-note completion plus failures and dropped-ref warnings, which is enough
 * for the single-pane operator stream without inflating the row count.
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
 * Async write semantics: `record` returns a Promise. Bus subscribers
 * fire-and-forget the write because `EventBus.emit` is sync. The 50ms
 * flush guard in `agentEvents.ts` accommodates the brief async window
 * between bus.emit and the resulting CREATE landing.
 *
 * Retention: when `maxRows` is supplied the store sweeps the table after
 * each successful CREATE under two conditions: every 1000th write
 * (`seq % 1000 === 0`) so steady-state vaults stay bounded with negligible
 * overhead, and every write past the cap (`seq > maxRows`) so a small cap
 * still trims promptly. The sweep is a single DELETE keyed on
 * `seq <= latestSeq - maxRows`; cursor consumers never observe sweep gaps
 * because `since(cursor, limit)` filters by `seq > cursor` and the assigned
 * seq always advances. A `maxRows` of zero or negative disables the sweep.
 */

import type { RecordId, Surreal } from "surrealdb";
import type { EventBus } from "../events/eventBus";

export type AgentEventType =
  | "swarm:contradiction_discovered"
  | "swarm:cluster_emerged"
  | "swarm:claim_advanced"
  | "swarm:link_proposed"
  | "indexer:note-indexed"
  | "indexer:error"
  | "indexer:warn";

export interface AgentEventRow {
  id: number;
  ts: number;
  type: AgentEventType;
  payload: unknown;
}

export interface AgentEventStoreOptions {
  db: Surreal;
  bus: EventBus;
  /**
   * Optional row-count cap on the `agent_event` ledger. The store sweeps
   * after each successful CREATE when `seq % 1000 === 0` or when the cap
   * has been exceeded. Values at or below zero disable the sweep; the
   * production wiring always supplies a positive integer sourced from
   * `<vault>/.notient/config.toml` under `[agent_events] max_rows`.
   */
  maxRows?: number;
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
  private readonly maxRows: number;

  constructor(options: AgentEventStoreOptions) {
    this.db = options.db;
    this.maxRows =
      typeof options.maxRows === "number" && Number.isFinite(options.maxRows) && options.maxRows > 0
        ? Math.floor(options.maxRows)
        : 0;
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
      bus.on("indexer:note-indexed", ({ type: _t, ...payload }) => {
        void this.record("indexer:note-indexed", payload);
      }),
      bus.on("indexer:error", ({ type: _t, ...payload }) => {
        void this.record("indexer:error", payload);
      }),
      bus.on("indexer:warn", ({ type: _t, ...payload }) => {
        void this.record("indexer:warn", payload);
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
    await this.maybeSweep(created.seq);
    return { id: created.seq, ts: created.ts_ms };
  }

  /**
   * Trim the ledger when the freshly-assigned seq triggers a sweep. Two
   * conditions fire the DELETE: every 1000th write keeps steady-state
   * growth bounded with negligible overhead, and any write past the cap
   * keeps small caps trimmed promptly. The DELETE is a single SurrealQL
   * statement filtered on `seq <= $cutoff` where the cutoff is
   * `latestSeq - maxRows`; consumers of `since(cursor, limit)` are unaffected
   * because that query filters by `seq > cursor` and seq always advances.
   */
  private async maybeSweep(latestSeq: number): Promise<void> {
    if (this.maxRows <= 0) return;
    const periodic = latestSeq % 1000 === 0;
    const overCap = latestSeq > this.maxRows;
    if (!periodic && !overCap) return;
    const cutoff = latestSeq - this.maxRows;
    if (cutoff <= 0) return;
    await this.db.query("DELETE agent_event WHERE seq <= $cutoff;", { cutoff }).collect();
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
