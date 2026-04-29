/**
 * `notient graph stats` CLI verb.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §11.1.
 *
 * Reports row counts for entity tables and per-source counts for edge
 * tables. Empty tables emit `count = 0` rather than being omitted so the
 * operator can see the schema is fully present even when a vault has not
 * been awakened yet.
 *
 * Default output is fixed-width text: `table | source | count`. The
 * `--json` flag (decoded by the dispatcher's `selectMode` helper) toggles
 * a JSON array instead.
 */

import type { Surreal } from "surrealdb";
import { EDGE_TABLES } from "../../core/db/edgeTables";
import type { Emitter } from "../output";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface GraphStatsOptions {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
  asJson?: boolean;
  /**
   * Test seam. Defaults to `process.stdout.write`. The runtime never threads
   * this from the dispatcher; tests override it to capture output.
   */
  writeStdout?: (line: string) => void;
}

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;

interface StatsRow {
  table: string;
  source: string;
  count: number;
}

export async function runGraphStatsCommand(options: GraphStatsOptions): Promise<number> {
  const writeStdout =
    options.writeStdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const rows = await collectStats(opened.db);
    if (options.asJson === true) {
      writeStdout(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const line of renderFixedWidth(rows)) {
      writeStdout(line);
    }
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `graph stats failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

async function collectStats(db: Surreal): Promise<StatsRow[]> {
  const rows: StatsRow[] = [];
  for (const table of ENTITY_TABLES) {
    const sql = `SELECT count() AS count FROM ${table} GROUP ALL;`;
    const [result] = await db
      .query<[Array<{ count: number }>]>(sql)
      .collect<[Array<{ count: number }>]>();
    const count = result[0]?.count ?? 0;
    rows.push({ table, source: "-", count });
  }
  for (const table of EDGE_TABLES) {
    const sql = `SELECT source, count() AS count FROM ${table} GROUP BY source;`;
    const [result] = await db
      .query<[Array<{ source: string; count: number }>]>(sql)
      .collect<[Array<{ source: string; count: number }>]>();
    if (result.length === 0) {
      rows.push({ table, source: "-", count: 0 });
      continue;
    }
    for (const entry of result) {
      rows.push({ table, source: entry.source ?? "-", count: entry.count });
    }
  }
  return rows;
}

function renderFixedWidth(rows: StatsRow[]): string[] {
  const tableWidth = Math.max(5, ...rows.map((row) => row.table.length));
  const sourceWidth = Math.max(6, ...rows.map((row) => row.source.length));
  const countWidth = Math.max(5, ...rows.map((row) => String(row.count).length));
  const header = `${"table".padEnd(tableWidth)} | ${"source".padEnd(sourceWidth)} | ${"count".padStart(countWidth)}`;
  const separator = `${"-".repeat(tableWidth)}-+-${"-".repeat(sourceWidth)}-+-${"-".repeat(countWidth)}`;
  const lines: string[] = [header, separator];
  for (const row of rows) {
    lines.push(
      `${row.table.padEnd(tableWidth)} | ${row.source.padEnd(sourceWidth)} | ${String(row.count).padStart(countWidth)}`,
    );
  }
  return lines;
}
