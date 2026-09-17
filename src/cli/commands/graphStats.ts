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
import { EDGE_TABLES, isEdgeSource } from "../../core/db/edgeTables";
import {
  isExactRecord,
  readAggregateCount,
  readSingleStatementRows,
} from "../../core/db/queryResult";
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
  let rows: StatsRow[] | undefined;
  let failure: unknown;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    rows = await collectStats(opened.db);
  } catch (error) {
    failure = error;
  }
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      failure = combineErrors(failure, error);
    }
  }
  if (failure !== undefined || rows === undefined) {
    const error = failure ?? new Error("graph stats completed without a result");
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `graph stats failed: ${formatError(error)}`,
    });
    return 1;
  }
  try {
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
      message: `graph stats failed: ${formatError(error)}`,
    });
    return 1;
  }
}

async function collectStats(db: Surreal): Promise<StatsRow[]> {
  const rows: StatsRow[] = [];
  for (const table of ENTITY_TABLES) {
    const sql = `SELECT count() AS count FROM ${table} GROUP ALL;`;
    const result: unknown = await db.query(sql).collect();
    const count = readAggregateCount(result, `graph stats ${table}`);
    rows.push({ table, source: "-", count });
  }
  for (const table of EDGE_TABLES) {
    const sql = `SELECT source, count() AS count FROM ${table} GROUP BY source;`;
    const result: unknown = await db.query(sql).collect();
    const groupedRows = readSingleStatementRows(result, `graph stats ${table}`);
    if (groupedRows.length === 0) {
      rows.push({ table, source: "-", count: 0 });
      continue;
    }
    const sources = new Set<string>();
    const decoded = groupedRows.map((entry) => {
      if (!isExactRecord(entry, ["source", "count"])) {
        throw new Error(`graph stats ${table} storage integrity: invalid grouped count row`);
      }
      if (!isEdgeSource(entry.source)) {
        throw new Error(`graph stats ${table} storage integrity: invalid provenance source`);
      }
      if (
        typeof entry.count !== "number" ||
        !Number.isSafeInteger(entry.count) ||
        entry.count <= 0
      ) {
        throw new Error(
          `graph stats ${table} storage integrity: grouped count must be a positive safe integer`,
        );
      }
      if (sources.has(entry.source)) {
        throw new Error(`graph stats ${table} storage integrity: duplicate provenance source`);
      }
      sources.add(entry.source);
      return { table, source: entry.source, count: entry.count };
    });
    decoded.sort((left, right) => left.source.localeCompare(right.source));
    for (const entry of decoded) {
      rows.push(entry);
    }
  }
  return rows;
}

function combineErrors(primary: unknown, closeError: unknown): Error {
  if (primary === undefined) {
    return new Error(`database connection close failed: ${formatError(closeError)}`);
  }
  return new Error(
    `${formatError(primary)}; database connection close also failed: ${formatError(closeError)}`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
