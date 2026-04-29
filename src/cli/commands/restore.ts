/**
 * `notient restore <path>` CLI verb.
 *
 * Spec: Phase 5 plan §Task 10. Spawns `surreal import` against the
 * running per-vault daemon. Refuses to run if any tracked table is
 * non-empty so an operator can not overlay a restore on top of live
 * data; the operator must `notient nuke` first.
 *
 * The non-empty refusal scans the entity tables, every edge table, and
 * the operational tables (daemon_write, history, awaken_run, agent_run,
 * agent_event, agent_session). The list is the union of every table
 * defined in `src/core/db/schema.surql` excluding the unresolved-edge
 * staging tables (which the awaken pipeline drains and rebuilds on
 * every run, so a non-empty unresolved table is not a meaningful sign
 * of live data).
 */

import { readFile } from "node:fs/promises";
import { EDGE_TABLES } from "../../core/db/edgeTables";
import { connect } from "../../core/db/surreal";
import type { SurrealConnection } from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import type { Emitter } from "../output";

export interface RestoreOptions {
  vaultPath: string;
  inputPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;

const OPS_TABLES = [
  "daemon_write",
  "history",
  "awaken_run",
  "agent_event",
  "agent_session",
  "agent_run",
] as const;

export const TRACKED_TABLES: readonly string[] = [...ENTITY_TABLES, ...EDGE_TABLES, ...OPS_TABLES];

export async function runRestoreCommand(options: RestoreOptions): Promise<number> {
  const portFile = vaultPortPath(options.vaultPath);
  let portText: string;
  try {
    portText = await readFile(portFile, "utf8");
  } catch {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    });
    return 1;
  }
  const port = Number(portText.trim());
  if (!Number.isFinite(port) || port <= 0) {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    });
    return 1;
  }
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));

  let connection: SurrealConnection | undefined;
  try {
    connection = await connect({
      url: `ws://127.0.0.1:${port}/rpc`,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    const occupied = await findNonEmptyTable(connection, TRACKED_TABLES);
    if (occupied !== null) {
      options.emitter.emit({
        type: "error",
        code: "DB_NOT_EMPTY",
        message: `restore refused: table '${occupied}' is non-empty. Run 'notient nuke --vault ${options.vaultPath}' first to wipe the database, then retry.`,
      });
      return 2;
    }
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `pre-restore check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }

  // `surreal import` shells out to the HTTP transport, not WebSocket RPC.
  // See note in src/cli/commands/backup.ts for the rationale.
  const child = Bun.spawn(
    [
      "surreal",
      "import",
      "--endpoint",
      `http://127.0.0.1:${port}`,
      "--username",
      "root",
      "--password",
      secret,
      "--namespace",
      "notient",
      "--database",
      "vault",
      options.inputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderrText = await new Response(child.stderr).text();
  const exitCode = (await child.exited) ?? 0;

  if (exitCode !== 0) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message:
        stderrText.trim().length > 0 ? stderrText.trim() : `surreal import exited ${exitCode}`,
    });
    return exitCode;
  }

  options.emitter.emit({ type: "restore-success", path: options.inputPath });
  return 0;
}

async function findNonEmptyTable(
  connection: SurrealConnection,
  tables: readonly string[],
): Promise<string | null> {
  for (const table of tables) {
    const sql = `SELECT count() AS count FROM ${table} GROUP ALL;`;
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>(sql)
      .collect<[Array<{ count: number }>]>();
    const count = rows[0]?.count ?? 0;
    if (count > 0) return table;
  }
  return null;
}
