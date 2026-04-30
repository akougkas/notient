/**
 * `notient proposals list|approve|reject` CLI verbs.
 *
 * M1 operator approval surface: gives operators a non-SurrealQL path to
 * decide on linker proposals. Mirrors `links sync`'s short-lived SurrealDB
 * connection plus an inline `ApprovalService` instance. The reconcile path
 * is idempotent (Locked Decision 2 in `writeback.ts`), so racing the daemon
 * is safe.
 *
 * Verbs:
 *   - list     enumerates every pending edge (state 1) across the six
 *              writeback-capable tables. Source/target paths are joined in
 *              from `note.path` so the operator can recognize what they are
 *              approving without a second query.
 *   - approve  flips one edge through the three-state contract by delegating
 *              to `ApprovalService.approveEdge`.
 *   - reject   deletes one edge by delegating to `ApprovalService.rejectEdge`.
 *              `--reason` is recorded in stdout/json output only; the
 *              service does not persist a rejection reason today.
 *
 * Idempotent error semantics: an unknown id (or one that has already moved
 * past state 1) prints `proposal not found or already applied` and exits 0,
 * matching `selectEdge` returning null. The CLI never throws when the row
 * was simply not there for it to act on.
 */

import { rename, unlink, writeFile } from "node:fs/promises";
import { type RecordId, StringRecordId, type Surreal } from "surrealdb";
import {
  ApprovalService,
  WRITEBACK_EDGE_TABLES,
  type WritebackEdgeTable,
} from "../../core/approvals/approvalService";
import { EventBus } from "../../core/events/eventBus";
import type { AtomicFs } from "../../core/utils/atomicWrite";
import type { Emitter } from "../output";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface ProposalsListOptions {
  vaultPath: string;
  emitter: Emitter;
  asJson: boolean;
  notePath?: string;
  agent?: string;
  limit?: number;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to `process.stdout.write`. The runtime never threads
   * this from the dispatcher; tests override it to capture output.
   */
  writeStdout?: (line: string) => void;
}

export interface ProposalsApproveOptions {
  vaultPath: string;
  vaultRoot: string;
  emitter: Emitter;
  id: string;
  clientIdentity?: string;
}

export interface ProposalsRejectOptions {
  vaultPath: string;
  vaultRoot: string;
  emitter: Emitter;
  id: string;
  reason?: string;
  clientIdentity?: string;
}

interface PendingRow {
  id: RecordId;
  table: WritebackEdgeTable;
  source: string | null;
  target: string | null;
  agent: string | null;
  confidence: number;
}

interface EdgeWithPathsRow {
  id: RecordId;
  fromPath: string | null;
  toPath: string | null;
  agent: string | null;
  confidence: number;
}

const cliFs: AtomicFs = {
  writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
    await writeFile(path, new Uint8Array(data));
  },
  rename: async (from: string, to: string): Promise<void> => {
    await rename(from, to);
  },
  remove: async (path: string): Promise<void> => {
    await unlink(path).catch(() => {
      // missing-file is not an error for cleanup
    });
  },
};

async function readFileText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/**
 * Detects the writeback-capable table from a SurrealDB record id of the
 * shape `{table}:{recordId}`. Returns `null` when the prefix does not
 * match any of the six writeback edge tables.
 */
export function tableFromEdgeId(id: string): WritebackEdgeTable | null {
  const colonIndex = id.indexOf(":");
  if (colonIndex <= 0) return null;
  const prefix = id.slice(0, colonIndex);
  if ((WRITEBACK_EDGE_TABLES as ReadonlyArray<string>).includes(prefix)) {
    return prefix as WritebackEdgeTable;
  }
  return null;
}

export async function runProposalsListCommand(options: ProposalsListOptions): Promise<number> {
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const rows = await collectPendingEdges(opened.db, {
      notePath: options.notePath,
      agent: options.agent,
    });
    // Each table's rows arrive newest-first via ORDER BY created_at DESC; the
    // outer concatenation does not re-sort across tables. The CLI keeps the
    // per-table grouping so the operator sees correlated proposals together.
    const limited = options.limit !== undefined ? rows.slice(0, options.limit) : rows;
    if (options.asJson) {
      const writeStdout =
        options.writeStdout ??
        ((line: string) => {
          process.stdout.write(line);
        });
      writeStdout(
        `${JSON.stringify(
          limited.map((row) => ({
            id: row.id.toString(),
            table: row.table,
            source: row.source,
            target: row.target,
            agent: row.agent,
            confidence: row.confidence,
          })),
        )}\n`,
      );
    } else {
      for (const row of limited) {
        options.emitter.emit({
          type: "proposals:list",
          id: row.id.toString(),
          table: row.table,
          source: row.source,
          target: row.target,
          agent: row.agent,
          confidence: row.confidence,
        });
      }
      if (limited.length === 0) {
        options.emitter.emit({ type: "proposals:list:empty" });
      }
    }
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals list failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

export async function runProposalsApproveCommand(
  options: ProposalsApproveOptions,
): Promise<number> {
  if (options.id.length === 0) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: "proposals approve requires an id",
    });
    return 2;
  }
  const table = tableFromEdgeId(options.id);
  if (table === null) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_ID",
      message: `proposals approve: id '${options.id}' has no writeback-capable table prefix`,
    });
    return 2;
  }
  let recordId: StringRecordId;
  try {
    recordId = new StringRecordId(options.id);
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_ID",
      message: `proposals approve: id '${options.id}' is not a valid SurrealDB record id (${
        error instanceof Error ? error.message : String(error)
      })`,
    });
    return 2;
  }
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    if (!(await edgeRowExists(opened.db, table, recordId))) {
      options.emitter.emit({
        type: "proposals:not_found",
        id: options.id,
        message: "proposal not found or already applied",
      });
      return 0;
    }
    const service = new ApprovalService({
      db: opened.db,
      bus: new EventBus(),
      vaultRoot: options.vaultRoot,
      fs: cliFs,
      readFile: readFileText,
    });
    await service.approveEdge({ id: recordId as unknown as RecordId, table });
    options.emitter.emit({ type: "proposals:approved", id: options.id, table });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals approve failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

export async function runProposalsRejectCommand(options: ProposalsRejectOptions): Promise<number> {
  if (options.id.length === 0) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: "proposals reject requires an id",
    });
    return 2;
  }
  const table = tableFromEdgeId(options.id);
  if (table === null) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_ID",
      message: `proposals reject: id '${options.id}' has no writeback-capable table prefix`,
    });
    return 2;
  }
  let recordId: StringRecordId;
  try {
    recordId = new StringRecordId(options.id);
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INVALID_ID",
      message: `proposals reject: id '${options.id}' is not a valid SurrealDB record id (${
        error instanceof Error ? error.message : String(error)
      })`,
    });
    return 2;
  }
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    if (!(await edgeRowExists(opened.db, table, recordId))) {
      options.emitter.emit({
        type: "proposals:not_found",
        id: options.id,
        message: "proposal not found or already applied",
      });
      return 0;
    }
    const service = new ApprovalService({
      db: opened.db,
      bus: new EventBus(),
      vaultRoot: options.vaultRoot,
      fs: cliFs,
      readFile: readFileText,
    });
    await service.rejectEdge({ id: recordId as unknown as RecordId, table });
    const event: Record<string, unknown> = {
      type: "proposals:rejected",
      id: options.id,
      table,
    };
    if (options.reason !== undefined) {
      event.reason = options.reason;
    }
    options.emitter.emit(event as { type: string; [key: string]: unknown });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals reject failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}

async function collectPendingEdges(
  db: Surreal,
  filters: { notePath?: string; agent?: string },
): Promise<PendingRow[]> {
  const out: PendingRow[] = [];
  for (const table of WRITEBACK_EDGE_TABLES) {
    const conditions: string[] = ["approved = false"];
    const bindings: Record<string, unknown> = {};
    if (filters.agent !== undefined) {
      conditions.push("agent = $agent");
      bindings.agent = filters.agent;
    }
    if (filters.notePath !== undefined) {
      conditions.push("(in.path = $path OR out.path = $path)");
      bindings.path = filters.notePath;
    }
    // SurrealDB 3.x requires every ORDER BY field in the projection.
    const sql = `SELECT id, in.path AS fromPath, out.path AS toPath, agent, confidence, created_at FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC;`;
    const [rows] = await db
      .query<[EdgeWithPathsRow[]]>(sql, bindings)
      .collect<[EdgeWithPathsRow[]]>();
    for (const row of rows) {
      out.push({
        id: row.id,
        table,
        source: row.fromPath,
        target: row.toPath,
        agent: row.agent,
        confidence: row.confidence,
      });
    }
  }
  return out;
}

async function edgeRowExists(
  db: Surreal,
  table: WritebackEdgeTable,
  id: StringRecordId,
): Promise<boolean> {
  const sql = `SELECT id FROM ${table} WHERE id = $id AND approved = false LIMIT 1;`;
  const [rows] = await db
    .query<[Array<{ id: RecordId }>]>(sql, { id })
    .collect<[Array<{ id: RecordId }>]>();
  return rows.length > 0;
}
