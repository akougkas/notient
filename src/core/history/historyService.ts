/**
 * Universal undo service. Every Notient mutation lands a row in the
 * `history` table keyed by `kind`. `undo(historyId)` looks up the row,
 * dispatches to the inverter registered for that kind, executes the
 * inverse mutation, and hard-deletes the row on success.
 *
 * The `history` table has no `undone_at` column, so idempotency is achieved
 * by hard delete. A second undo of the same id returns
 * `{ ok: false, error: "history row not found" }`.
 */

import type { Database } from "../db/database";
import type {
  HistoryKind,
  HistoryRetention,
  HistoryRow,
  InverterRegistry,
  RecordHistoryInput,
  UndoResult,
} from "./types";

export interface HistoryServiceOptions {
  db: Database;
  inverters: InverterRegistry;
  retention: HistoryRetention;
  now?: () => number;
}

export class HistoryService {
  private readonly db: Database;
  private readonly inverters: InverterRegistry;
  private readonly retention: HistoryRetention;
  private readonly now: () => number;

  constructor(options: HistoryServiceOptions) {
    this.db = options.db;
    this.inverters = options.inverters;
    this.retention = options.retention;
    this.now = options.now ?? (() => Date.now());
  }

  async record(input: RecordHistoryInput): Promise<number> {
    const beforeJson = input.before === null ? null : JSON.stringify(input.before);
    const afterJson = input.after === null ? null : JSON.stringify(input.after);
    this.db.run(
      "INSERT INTO history (kind, target, before, after, created_at) VALUES (?, ?, ?, ?, ?);",
      [input.kind, input.target, beforeJson, afterJson, this.now()],
    );
    const idRow = this.db.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    await this.db.persist();
    return idRow.id;
  }

  getRecent(limit = 50): HistoryRow[] {
    const rows = this.db.query<{
      id: number;
      kind: string;
      target: string;
      before: string | null;
      after: string | null;
      created_at: number;
    }>(
      "SELECT id, kind, target, before, after, created_at FROM history ORDER BY id DESC LIMIT ?;",
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as HistoryKind,
      target: row.target,
      before: parseHistoryPayload(row.before),
      after: parseHistoryPayload(row.after),
      createdAt: row.created_at,
    }));
  }

  async undo(historyId: number): Promise<UndoResult> {
    const rows = this.db.query<{
      id: number;
      kind: string;
      target: string;
      before: string | null;
      after: string | null;
      created_at: number;
    }>("SELECT id, kind, target, before, after, created_at FROM history WHERE id = ?;", [
      historyId,
    ]);
    if (rows.length === 0) {
      return { ok: false, error: "history row not found" };
    }
    const raw = rows[0];
    const kind = raw.kind as HistoryKind;
    const inverter = this.inverters[kind];
    if (!inverter) {
      return { ok: false, error: `no inverter for ${kind}` };
    }
    const before = parseHistoryPayload(raw.before);
    const after = parseHistoryPayload(raw.after);
    try {
      await inverter(raw.target, before, after);
      this.db.run("DELETE FROM history WHERE id = ?;", [historyId]);
      await this.db.persist();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async undoLast(): Promise<UndoResult> {
    const recent = this.getRecent(1);
    if (recent.length === 0) {
      return { ok: false, error: "no history" };
    }
    return this.undo(recent[0].id);
  }

  /**
   * Prune rows so the table holds at most `retention.max` rows globally
   * and at most `retention.maxPerTarget` rows per target. Intended to be
   * called from plugin start (Task 16 wiring).
   */
  async prune(): Promise<void> {
    this.db.run(
      `DELETE FROM history WHERE id IN (
        SELECT id FROM history ORDER BY id DESC LIMIT -1 OFFSET ?
      );`,
      [this.retention.max],
    );
    const targets = this.db.query<{ target: string }>("SELECT DISTINCT target FROM history;");
    for (const row of targets) {
      this.db.run(
        `DELETE FROM history WHERE id IN (
          SELECT id FROM history
          WHERE target = ?
          ORDER BY id DESC LIMIT -1 OFFSET ?
        );`,
        [row.target, this.retention.maxPerTarget],
      );
    }
    await this.db.persist();
  }
}

function parseHistoryPayload(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
