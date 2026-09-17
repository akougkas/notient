/**
 * `notient restore <path>` CLI verb.
 *
 * Spawns `surreal import` against the running per-vault daemon. Backup files
 * omit daemon-owned embedding metadata but carry its model/dimension identity
 * in the authenticated envelope. Restore requires the freshly bootstrapped
 * target to use that exact embedding space before importing any vectors. The
 * command refuses to overlay a restore on live data, so the operator must
 * `notient nuke` first.
 *
 * The non-empty refusal scans the entity tables, every edge table, and every
 * operational table that could conflict with a restore. Backups omit
 * unresolved-edge staging, `meta`, `conversation_memory`, and `agent_session`:
 * bootstrap owns runtime metadata, conversations rebuild their derived index,
 * unresolved rows rebuild from Markdown, and security grants never revive.
 */

import { readFile } from "node:fs/promises";
import { RESTORE_EMPTY_TABLES, RESTORE_ROLLBACK_TABLES } from "../../core/db/backupTables";
import { readAggregateCount } from "../../core/db/queryResult";
import { connect } from "../../core/db/surreal";
import type { SurrealConnection } from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";
import { armRestoreQuarantine, clearRestoreQuarantine } from "../../core/vault/restoreQuarantine";
import { readOrGenerateSecret } from "../../core/vault/secret";
import type { ClientHandle, RpcResponseFrame } from "../client";
import type { Emitter } from "../output";
import { assertCompatibleEmbeddingSnapshot, readEmbeddingSnapshot } from "./embeddingSnapshot";
import { verifyGraphSnapshot } from "./graphSnapshot";
import type { LinksSyncOptions } from "./linksSync";
import {
  type AcquireGraphMaintenanceOptions,
  type GraphMaintenanceLease,
  acquireGraphMaintenanceLease,
} from "./maintenanceLease";
import { type BackupEmbeddingManifest, stageVerifiedBackup } from "./surrealBackupFormat";
import {
  buildSurrealDataInvocation,
  parseDaemonPortFile,
  parseSurrealCliExitCode,
} from "./surrealCli";

export interface RestoreOptions {
  vaultPath: string;
  inputPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export interface RestoreDependencies {
  acquireMaintenance(options: AcquireGraphMaintenanceOptions): Promise<GraphMaintenanceLease>;
  syncLinks(options: LinksSyncOptions, client: ClientHandle): Promise<number>;
}

const DEFAULT_RESTORE_DEPENDENCIES: RestoreDependencies = {
  acquireMaintenance: acquireGraphMaintenanceLease,
  syncLinks: syncLinksWithinMaintenance,
};

export const TRACKED_TABLES: readonly string[] = RESTORE_EMPTY_TABLES;

interface RestoreAttempt {
  exitCode: number;
  databaseTouched: boolean;
}

export async function runRestoreCommand(
  options: RestoreOptions,
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES,
): Promise<number> {
  const port = await readRestoreDaemonPort(options);
  if (port === null) return 1;
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));

  let staged: Awaited<ReturnType<typeof stageVerifiedBackup>>;
  try {
    staged = await stageVerifiedBackup(options.inputPath, secret);
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `restore input authentication failed: ${formatError(error)}`,
    });
    return 1;
  }

  let lease: GraphMaintenanceLease;
  try {
    lease = await dependencies.acquireMaintenance({
      vaultPath: options.vaultPath,
      operation: "restore",
      ...(options.clientIdentity === undefined ? {} : { clientIdentity: options.clientIdentity }),
    });
  } catch (error) {
    await staged.cleanup().catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `could not enter exclusive daemon maintenance: ${formatError(error)}`,
    });
    return 1;
  }

  try {
    await armRestoreQuarantine(options.vaultPath);
  } catch (error) {
    await lease.release().catch(() => {});
    await staged.cleanup().catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `could not arm restore quarantine: ${formatError(error)}`,
    });
    return 1;
  }

  let attempt: RestoreAttempt = { exitCode: 1, databaseTouched: false };
  try {
    attempt = await restoreVerifiedBackup(
      options,
      dependencies,
      port,
      secret,
      staged.path,
      staged.embedding,
      lease.client,
    );
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `restore engine failed unexpectedly: ${formatError(error)}`,
    });
    // Once the privileged restore phase begins, an unexpected escape is
    // treated as potentially post-import. Rolling back an untouched empty
    // target is harmless; clearing quarantine around a touched target is not.
    attempt = { exitCode: 1, databaseTouched: true };
  } finally {
    try {
      attempt.exitCode = await finalizeRestoreAttempt(options, lease, port, secret, attempt);
    } finally {
      await staged.cleanup().catch(() => {});
    }
  }
  if (attempt.exitCode === 0) {
    options.emitter.emit({ type: "restore-success", path: options.inputPath });
  }
  return attempt.exitCode;
}

async function readRestoreDaemonPort(options: RestoreOptions): Promise<number | null> {
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
    return null;
  }
  try {
    return parseDaemonPortFile(portText);
  } catch {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `daemon is not running (invalid port file at ${portFile}). Run 'notient daemon start' first.`,
    });
    return null;
  }
}

interface RestoreRecovery {
  rebuildAllMarkdown: boolean;
  poisoned: boolean;
}

async function finalizeRestoreAttempt(
  options: RestoreOptions,
  lease: GraphMaintenanceLease,
  port: number,
  secret: string,
  attempt: RestoreAttempt,
): Promise<number> {
  const recovery = await recoverFailedRestore(options, lease, port, secret, attempt);
  if (recovery.poisoned) return attempt.exitCode;

  const releasedCleanly = await releaseRestoreMaintenance(
    options,
    lease,
    recovery.rebuildAllMarkdown,
  );
  if (!releasedCleanly) return 1;

  const safeToClear =
    attempt.exitCode === 0 || !attempt.databaseTouched || recovery.rebuildAllMarkdown;
  if (!safeToClear) return attempt.exitCode;
  return clearCompletedRestoreQuarantine(options, attempt.exitCode);
}

async function recoverFailedRestore(
  options: RestoreOptions,
  lease: GraphMaintenanceLease,
  port: number,
  secret: string,
  attempt: RestoreAttempt,
): Promise<RestoreRecovery> {
  if (!attempt.databaseTouched || attempt.exitCode === 0) {
    return { rebuildAllMarkdown: false, poisoned: false };
  }
  try {
    await rollbackImportedGeneration(port, secret);
    return { rebuildAllMarkdown: true, poisoned: false };
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `failed restore could not be rolled back while maintenance was held: ${formatError(error)}. Stop the daemon and run 'notient nuke --yes' before any other command.`,
    });
    await poisonFailedRestore(options, lease);
    return { rebuildAllMarkdown: false, poisoned: true };
  }
}

async function poisonFailedRestore(
  options: RestoreOptions,
  lease: GraphMaintenanceLease,
): Promise<void> {
  try {
    await lease.poison();
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `failed restore quarantine error: ${formatError(error)}`,
    });
  }
}

async function releaseRestoreMaintenance(
  options: RestoreOptions,
  lease: GraphMaintenanceLease,
  rebuildAllMarkdown: boolean,
): Promise<boolean> {
  try {
    const released = await lease.release(
      rebuildAllMarkdown ? { rebuildAllMarkdown: true } : undefined,
    );
    if (!released.vaultChanged) return true;
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message:
        "Markdown changed while the exclusive restore was running. The imported generation is not a valid restore; run 'notient nuke --yes' before retrying.",
    });
    return false;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `daemon maintenance release failed: ${formatError(error)}`,
    });
    return false;
  }
}

async function clearCompletedRestoreQuarantine(
  options: RestoreOptions,
  exitCode: number,
): Promise<number> {
  try {
    await clearRestoreQuarantine(options.vaultPath);
    return exitCode;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `restore completed but its durable quarantine marker could not be cleared: ${formatError(error)}`,
    });
    return 1;
  }
}

async function restoreVerifiedBackup(
  options: RestoreOptions,
  dependencies: RestoreDependencies,
  port: number,
  secret: string,
  stagedPath: string,
  backupEmbedding: BackupEmbeddingManifest,
  maintenanceClient: ClientHandle,
): Promise<RestoreAttempt> {
  let connection: SurrealConnection | undefined;
  let occupied: string | null = null;
  let preflightError: unknown;
  try {
    connection = await connect({
      url: `ws://127.0.0.1:${port}/rpc`,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    occupied = await findNonEmptyTable(connection, TRACKED_TABLES);
    if (occupied === null) {
      const currentEmbedding = await readEmbeddingSnapshot(connection.db);
      assertCompatibleEmbeddingSnapshot(backupEmbedding, currentEmbedding);
    }
  } catch (error) {
    preflightError = error;
  }
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      preflightError = combinePreflightErrors(preflightError, error);
    }
  }
  if (preflightError !== undefined) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: `pre-restore check failed: ${formatError(preflightError)}`,
    });
    return { exitCode: 1, databaseTouched: false };
  }
  if (occupied !== null) {
    options.emitter.emit({
      type: "error",
      code: "DB_NOT_EMPTY",
      message: `restore refused: table '${occupied}' is non-empty. Run 'notient nuke --vault ${options.vaultPath}' first to wipe the database, then retry.`,
    });
    return { exitCode: 2, databaseTouched: false };
  }

  // `surreal import` shells out to the HTTP transport, not WebSocket RPC.
  // See note in src/cli/commands/backup.ts for the rationale.
  const invocation = buildSurrealDataInvocation({
    operation: "import",
    port,
    secret,
    filePath: stagedPath,
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(invocation.argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: invocation.env,
    });
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: formatError(error),
    });
    return { exitCode: 1, databaseTouched: false };
  }
  let importResult: Awaited<ReturnType<typeof collectSurrealImportResult>>;
  try {
    importResult = await collectSurrealImportResult({
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: child.stderr as ReadableStream<Uint8Array>,
      exited: child.exited,
    });
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return { exitCode: 1, databaseTouched: true };
  }
  const exitCode = parseSurrealCliExitCode(importResult.exitCode);

  if (exitCode !== 0) {
    options.emitter.emit({
      type: "error",
      code: "RESTORE_FAILED",
      message:
        importResult.stderr.trim().length > 0
          ? importResult.stderr.trim()
          : `surreal import exited ${exitCode}`,
    });
    return { exitCode, databaseTouched: true };
  }

  return {
    exitCode: await finishRestore(options, dependencies, port, secret, maintenanceClient),
    databaseTouched: true,
  };
}

interface SurrealImportProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

/** Drain both child pipes concurrently so neither can backpressure the importer. */
export async function collectSurrealImportResult(
  child: SurrealImportProcess,
): Promise<{ exitCode: number; stderr: string }> {
  const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
    drainReadable(child.stdout),
    readBoundedText(child.stderr, 64 * 1_024),
    child.exited,
  ]);
  if (stdoutResult.status === "rejected") throw stdoutResult.reason;
  if (stderrResult.status === "rejected") throw stderrResult.reason;
  if (exitResult.status === "rejected") throw exitResult.reason;
  return { exitCode: exitResult.value, stderr: stderrResult.value };
}

async function drainReadable(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Intentionally discard importer stdout while continuing to drain it.
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (retained >= limit) continue;
      const slice = value.subarray(0, Math.min(value.byteLength, limit - retained));
      chunks.push(slice);
      retained += slice.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function finishRestore(
  options: RestoreOptions,
  dependencies: RestoreDependencies,
  port: number,
  secret: string,
  maintenanceClient: ClientHandle,
): Promise<number> {
  try {
    // Import happens after daemon bootstrap. Validate the restored graph
    // against canonical Markdown before any caller can mistake success for a
    // content restore, then terminalize process-owned rows that no surviving
    // worker can complete. Paused awaken checkpoints remain resumable.
    await verifyGraphSnapshot({
      vaultPath: options.vaultPath,
      port,
      secret,
      recoverImportedRuns: true,
    });
  } catch (error) {
    emitRestoreFailure(options.emitter, "post-import reconciliation failed", error);
    return 1;
  }

  // Restored write-ahead intents also missed startup reconciliation. Settle
  // them through the same daemon authority as an explicit `links sync`.
  const syncExitCode = await dependencies.syncLinks(
    {
      vaultPath: options.vaultPath,
      emitter: options.emitter,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    },
    maintenanceClient,
  );
  if (syncExitCode !== 0) return syncExitCode;

  try {
    // Intent replay may have changed Markdown and note SHA together. Require
    // the exact invariant once more before declaring the restore usable.
    await verifyGraphSnapshot({
      vaultPath: options.vaultPath,
      port,
      secret,
      recoverImportedRuns: false,
    });
  } catch (error) {
    emitRestoreFailure(options.emitter, "final snapshot verification failed", error);
    return 1;
  }

  return 0;
}

async function syncLinksWithinMaintenance(
  options: LinksSyncOptions,
  client: ClientHandle,
): Promise<number> {
  try {
    for await (const frame of client.call("links.sync", {})) {
      const exitCode = handleLinksSyncFrame(options, frame);
      if (exitCode !== null) return exitCode;
    }
    throw new Error("links.sync returned no result");
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `links sync failed: ${formatError(error)}`,
    });
    return 1;
  }
}

function handleLinksSyncFrame(options: LinksSyncOptions, frame: RpcResponseFrame): number | null {
  if (frame.type === "ack") return null;
  if (frame.type === "error") {
    const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
    const message = typeof frame.message === "string" ? frame.message : "unknown daemon error";
    options.emitter.emit({ type: "error", code, message: `links sync failed: ${message}` });
    return code === "INVALID_PARAMS" ? 2 : 1;
  }
  if (frame.type === "event") throw new Error("links.sync returned an unexpected event");
  const result = parseLinksSyncResult(frame);
  options.emitter.emit({ type: "links:sync", ...result });
  return result.failed === 0 ? 0 : 1;
}

function parseLinksSyncResult(frame: RpcResponseFrame): {
  replayed: number;
  abandoned: number;
  failed: number;
} {
  if (
    frame.ok !== true ||
    typeof frame.replayed !== "number" ||
    !Number.isSafeInteger(frame.replayed) ||
    frame.replayed < 0 ||
    typeof frame.failed !== "number" ||
    !Number.isSafeInteger(frame.failed) ||
    frame.failed < 0
  ) {
    throw new Error("links.sync returned invalid replay counters");
  }
  if (
    typeof frame.abandoned !== "number" ||
    !Number.isInteger(frame.abandoned) ||
    frame.abandoned < 0
  )
    throw new Error("links.sync returned an invalid abandoned count");
  return { replayed: frame.replayed, abandoned: frame.abandoned, failed: frame.failed };
}

function emitRestoreFailure(emitter: Emitter, phase: string, error: unknown): void {
  emitter.emit({
    type: "error",
    code: "RESTORE_FAILED",
    message: `${phase}: ${formatError(error)}. The imported database is not usable; run 'notient nuke --yes' before retrying.`,
  });
}

async function findNonEmptyTable(
  connection: SurrealConnection,
  tables: readonly string[],
): Promise<string | null> {
  for (const table of tables) {
    const sql = `SELECT count() AS count FROM ${table} GROUP ALL;`;
    const result: unknown = await connection.db.query(sql).collect();
    const count = readAggregateCount(result, `restore table ${table}`);
    if (count > 0) return table;
  }
  return null;
}

async function rollbackImportedGeneration(port: number, secret: string): Promise<void> {
  const connection = await connect({
    url: `ws://127.0.0.1:${port}/rpc`,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
  let failure: unknown;
  try {
    const statements = [
      "BEGIN TRANSACTION;",
      ...RESTORE_ROLLBACK_TABLES.map((table) => `DELETE ${table};`),
      "COMMIT TRANSACTION;",
    ];
    await connection.db.query(statements.join("\n")).collect();
    const occupied = await findNonEmptyTable(connection, RESTORE_EMPTY_TABLES);
    if (occupied !== null) {
      throw new Error(`restore rollback left table '${occupied}' non-empty`);
    }
  } catch (error) {
    failure = error;
  }
  try {
    await connection.close();
  } catch (error) {
    failure = combinePreflightErrors(failure, error);
  }
  if (failure !== undefined) throw failure;
}

function combinePreflightErrors(primary: unknown, closeError: unknown): Error {
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
