import type { Database } from "../db/database";
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
  database: Database;
  bus: EventBus;
}

interface PersistedRow {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

/**
 * Append-only ledger of swarm discoveries. The store self-subscribes to the
 * four `swarm:*` bus events on construction so external clients (Phase D1
 * `notient events --since <cursor>`) can drain a consistent stream from
 * SQLite without each producer threading a separate writer.
 */
export class AgentEventStore {
  private readonly database: Database;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: AgentEventStoreOptions) {
    this.database = options.database;
    const { bus } = options;
    this.unsubscribes.push(
      bus.on("swarm:contradiction_discovered", ({ type: _t, ...payload }) => {
        this.record("swarm:contradiction_discovered", payload);
      }),
      bus.on("swarm:cluster_emerged", ({ type: _t, ...payload }) => {
        this.record("swarm:cluster_emerged", payload);
      }),
      bus.on("swarm:claim_advanced", ({ type: _t, ...payload }) => {
        this.record("swarm:claim_advanced", payload);
      }),
      bus.on("swarm:link_proposed", ({ type: _t, ...payload }) => {
        this.record("swarm:link_proposed", payload);
      }),
    );
  }

  record(type: AgentEventType, payload: unknown): { id: number; ts: number } {
    const ts = Date.now();
    const serialized = JSON.stringify(payload ?? null);
    this.database.run("INSERT INTO agent_events (ts, type, payload) VALUES (?, ?, ?);", [
      ts,
      type,
      serialized,
    ]);
    const idRow = this.database.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    const id = idRow?.id ?? 0;
    return { id, ts };
  }

  since(cursor: number, limit: number): AgentEventRow[] {
    const rows = this.database.query<PersistedRow>(
      "SELECT id, ts, type, payload FROM agent_events WHERE id > ? ORDER BY id ASC LIMIT ?;",
      [cursor, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      type: row.type as AgentEventType,
      payload: parsePayload(row.payload),
    }));
  }

  latestId(): number {
    const rows = this.database.query<{ max_id: number | null }>(
      "SELECT MAX(id) AS max_id FROM agent_events;",
    );
    return rows[0]?.max_id ?? 0;
  }

  countSince(cursor: number): number {
    const rows = this.database.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_events WHERE id > ?;",
      [cursor],
    );
    return rows[0]?.n ?? 0;
  }

  dispose(): void {
    while (this.unsubscribes.length > 0) {
      const off = this.unsubscribes.pop();
      off?.();
    }
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
