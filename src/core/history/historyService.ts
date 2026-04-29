/**
 * Universal undo service. Every Notient mutation lands a row in the
 * SurrealDB `history` table keyed by `kind`. `undo(historyId)` looks up
 * the row, dispatches to the inverter registered for that kind, executes
 * the inverse mutation, and hard-deletes the row on success.
 *
 * Phase 4 Task 4 migrated the storage backend from SQLite to SurrealDB.
 * The row format and `kind`/`target`/`before`/`after`/`client_identity`/
 * `created_at` semantics are unchanged; only the storage layer differs.
 * `before` and `after` are JSON-stringified at insert time because
 * SurrealDB 3.x does not accept `option<any>` for arbitrary nested
 * payloads; the producer and consumer agree on `JSON.parse` at read time.
 *
 * The `history` table has no `undone_at` column, so idempotency is
 * achieved by hard delete. A second undo of the same id returns
 * `{ ok: false, error: "history row not found" }`.
 *
 * `undoLast()` is atomic: the inverter runs first; if it throws the
 * history row is left intact. Only after a successful inverter does the
 * row get deleted.
 */

import { type RecordId, StringRecordId, type Surreal } from "surrealdb";
import type {
  HistoryKind,
  HistoryRetention,
  HistoryRow,
  InverterRegistry,
  RecordHistoryInput,
  UndoResult,
} from "./types";

export interface HistoryServiceOptions {
  db: Surreal;
  inverters: InverterRegistry;
  retention: HistoryRetention;
  now?: () => number;
}

interface HistoryRecordRow {
  id: RecordId<"history">;
  kind: string;
  target: string;
  before: string | null | undefined;
  after: string | null | undefined;
  created_at: string | Date;
  client_identity: string | null | undefined;
}

export class HistoryService {
  private readonly db: Surreal;
  private readonly inverters: InverterRegistry;
  private readonly retention: HistoryRetention;
  private readonly now: () => number;

  constructor(options: HistoryServiceOptions) {
    this.db = options.db;
    this.inverters = options.inverters;
    this.retention = options.retention;
    this.now = options.now ?? (() => Date.now());
  }

  async record(input: RecordHistoryInput): Promise<string> {
    const beforeJson = input.before === null ? null : JSON.stringify(input.before);
    const afterJson = input.after === null ? null : JSON.stringify(input.after);
    const clientIdentity = input.clientIdentity ?? "human";
    // The schema stamps `created_at` via DEFAULT time::now(); we pass an
    // explicit value so tests with an injected `now` see a deterministic
    // timestamp on the row. Production calls inject `Date.now()`.
    const createdAtIso = new Date(this.now()).toISOString();
    // SurrealDB's `option<string>` field rejects a JS `null` binding; the
    // null sentinel must be omitted from CONTENT so the field stays NONE.
    // Build the CONTENT body conditionally on whether before/after are
    // present.
    const setClauses: string[] = [
      "kind: $kind",
      "target: $target",
      "client_identity: $clientIdentity",
      "created_at: <datetime>$createdAt",
    ];
    const bindings: Record<string, unknown> = {
      kind: input.kind,
      target: input.target,
      clientIdentity,
      createdAt: createdAtIso,
    };
    if (beforeJson !== null) {
      setClauses.push("before: $before");
      bindings.before = beforeJson;
    }
    if (afterJson !== null) {
      setClauses.push("after: $after");
      bindings.after = afterJson;
    }
    const sql = `CREATE history CONTENT { ${setClauses.join(", ")} } RETURN id;`;
    const [rows] = await this.db
      .query<[Array<{ id: RecordId<"history"> }>]>(sql, bindings)
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    const created = rows[0];
    if (created === undefined) {
      throw new Error("HistoryService.record: SurrealDB returned no row");
    }
    return created.id.toString();
  }

  async getRecent(limit = 50): Promise<HistoryRow[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }
    // SurrealDB 3.x requires every ORDER BY field to appear in the
    // projection. `id` is the lexicographic tiebreaker for rows that
    // share a `created_at` (rapid-succession inserts in tests with an
    // injected static clock).
    const sql =
      "SELECT id, kind, target, before, after, created_at, client_identity FROM history ORDER BY created_at DESC, id DESC LIMIT $limit;";
    const [rows] = await this.db
      .query<[HistoryRecordRow[]]>(sql, { limit: Math.floor(limit) })
      .collect<[HistoryRecordRow[]]>();
    return rows.map((row) => mapRow(row));
  }

  async undo(historyId: string): Promise<UndoResult> {
    const recordId = parseHistoryId(historyId);
    if (recordId === null) {
      return { ok: false, error: "history row not found" };
    }
    const [rows] = await this.db
      .query<[HistoryRecordRow[]]>(
        "SELECT id, kind, target, before, after, created_at, client_identity FROM history WHERE id = $id;",
        { id: recordId },
      )
      .collect<[HistoryRecordRow[]]>();
    const raw = rows[0];
    if (raw === undefined) {
      return { ok: false, error: "history row not found" };
    }
    const kind = raw.kind as HistoryKind;
    const inverter = this.inverters[kind];
    if (!inverter) {
      return { ok: false, error: `no inverter for ${kind}` };
    }
    const before = parseHistoryPayload(raw.before);
    const after = parseHistoryPayload(raw.after);
    try {
      // Atomicity: the inverter runs to completion BEFORE the row is
      // deleted. If the inverter throws, no DELETE issues, the row stays
      // in the table, and the caller sees the inverter error.
      await inverter(raw.target, before, after);
      await this.db.query("DELETE $id;", { id: recordId }).collect();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async undoLast(): Promise<UndoResult> {
    const recent = await this.getRecent(1);
    if (recent.length === 0) {
      return { ok: false, error: "no history" };
    }
    return this.undo(recent[0].id);
  }

  /**
   * Prune rows so the table holds at most `retention.max` rows globally
   * and at most `retention.maxPerTarget` rows per target. Newest rows
   * (by `created_at` DESC) are retained.
   */
  async prune(): Promise<void> {
    if (this.retention.max > 0) {
      await this.deleteBeyondGlobalRetention(this.retention.max);
    }
    if (this.retention.maxPerTarget > 0) {
      await this.deleteBeyondPerTargetRetention(this.retention.maxPerTarget);
    }
  }

  private async deleteBeyondGlobalRetention(keep: number): Promise<void> {
    // SurrealDB 3.x has no LIMIT/OFFSET on DELETE; select the ids of the
    // rows to drop and delete them one at a time.
    const [rows] = await this.db
      .query<[PruneRow[]]>(
        "SELECT id, created_at FROM history ORDER BY created_at DESC, id DESC START $start;",
        { start: keep },
      )
      .collect<[PruneRow[]]>();
    await this.deleteRowsById(rows);
  }

  private async deleteBeyondPerTargetRetention(keep: number): Promise<void> {
    const targets = await this.distinctTargets();
    for (const target of targets) {
      const [rows] = await this.db
        .query<[PruneRow[]]>(
          "SELECT id, created_at FROM history WHERE target = $target ORDER BY created_at DESC, id DESC START $start;",
          { target, start: keep },
        )
        .collect<[PruneRow[]]>();
      await this.deleteRowsById(rows);
    }
  }

  private async distinctTargets(): Promise<string[]> {
    const [response] = await this.db
      .query<[unknown[]]>("SELECT VALUE target FROM history GROUP BY target;")
      .collect<[unknown[]]>();
    // SurrealDB returns either an array of strings (when SELECT VALUE on
    // a single field collapses to scalars) or an array of objects with a
    // `target` property depending on server version. Normalise.
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const entry of response) {
      const value = typeof entry === "string" ? entry : (entry as { target?: string }).target;
      if (value === undefined || seen.has(value)) continue;
      seen.add(value);
      targets.push(value);
    }
    return targets;
  }

  private async deleteRowsById(rows: PruneRow[]): Promise<void> {
    for (const row of rows) {
      await this.db.query("DELETE $id;", { id: row.id }).collect();
    }
  }
}

interface PruneRow {
  id: RecordId<"history">;
  created_at: string | Date;
}

function mapRow(row: HistoryRecordRow): HistoryRow {
  const createdAt =
    row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(row.created_at);
  return {
    id: row.id.toString(),
    kind: row.kind as HistoryKind,
    target: row.target,
    before: parseHistoryPayload(row.before),
    after: parseHistoryPayload(row.after),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    clientIdentity: row.client_identity ?? "human",
  };
}

function parseHistoryPayload(raw: string | null | undefined): unknown | null {
  // SurrealDB returns NONE-valued option<string> fields as undefined; the
  // legacy SQLite mirror emitted nulls for the same case. Normalize both
  // shapes to null so consumers see one stable absent-payload sentinel.
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseHistoryId(historyId: string): StringRecordId | null {
  if (historyId.length === 0) return null;
  if (!historyId.startsWith("history:")) return null;
  try {
    return new StringRecordId(historyId);
  } catch {
    return null;
  }
}
