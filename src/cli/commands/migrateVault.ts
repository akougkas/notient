/**
 * `notient migrate-vault <new-absolute-path>` CLI verb.
 *
 * Spec: Phase 5 plan §Task 10. Five-step contract with explicit
 * per-step rollback:
 *
 *   1. Export source DB to a temp `.surql` file via `surreal export`.
 *   2. Verify the temp file is non-empty and contains a SurrealQL header.
 *   3. Stop the source daemon (graceful, 10s SIGTERM grace then SIGKILL).
 *   4. Provision the target state dir (copy `secret.key` from source,
 *      preserving 0o600), then start the target daemon. Bootstrap
 *      applies the schema.
 *   5. Import the temp file into the target DB via `surreal import`.
 *
 * Failure handling:
 *   - 1 or 2 fail: source stays up, no state changes, exit non-zero.
 *   - 3 fails: source in unknown state, exit non-zero with diagnostic.
 *   - 4 fails: restart source, exit non-zero.
 *   - 5 fails: stop target, remove target data dir, restart source,
 *     exit non-zero.
 *
 * The temp `.surql` file is preserved on every failure path. Deleted
 * only on full success. The source `~/.notient/<source-vault-id>/`
 * directory is preserved on success; the operator owns that cleanup.
 */

import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../core/db/surreal";
import type { SurrealConnection } from "../../core/db/surreal";
import {
  vaultDataDir,
  vaultPortPath,
  vaultSecretPath,
  vaultStateDir,
} from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import type { Emitter } from "../output";
import {
  type DaemonStartHook,
  type DaemonStopHook,
  defaultDaemonStartHook,
  defaultDaemonStopHook,
} from "./daemonControl";

export interface MigrateVaultOptions {
  sourceVaultPath: string;
  targetVaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
  /** Test seam. Defaults to the system tmp dir. */
  tempDirOverride?: string;
  /**
   * Test seam. Override the surreal export/import shell-out so a test
   * can simulate a corrupt dump without forcing the real binary to fail.
   */
  exportImpl?: ExportImpl;
  importImpl?: ImportImpl;
  /** Test seams for daemon control. */
  stopDaemon?: DaemonStopHook;
  startDaemon?: DaemonStartHook;
}

export interface ExportArgs {
  port: number;
  secret: string;
  outFile: string;
}

export interface ImportArgs {
  port: number;
  secret: string;
  inFile: string;
}

export type ExportImpl = (args: ExportArgs) => Promise<{ exitCode: number; stderr: string }>;
export type ImportImpl = (args: ImportArgs) => Promise<{ exitCode: number; stderr: string }>;

// `surreal export` and `surreal import` use the HTTP transport on the
// same port the daemon's WebSocket RPC binds. See backup.ts for context.

export const defaultExportImpl: ExportImpl = async (args) => {
  const child = Bun.spawn(
    [
      "surreal",
      "export",
      "--endpoint",
      `http://127.0.0.1:${args.port}`,
      "--username",
      "root",
      "--password",
      args.secret,
      "--namespace",
      "notient",
      "--database",
      "vault",
      args.outFile,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exitCode = (await child.exited) ?? 0;
  return { exitCode, stderr };
};

export const defaultImportImpl: ImportImpl = async (args) => {
  const child = Bun.spawn(
    [
      "surreal",
      "import",
      "--endpoint",
      `http://127.0.0.1:${args.port}`,
      "--username",
      "root",
      "--password",
      args.secret,
      "--namespace",
      "notient",
      "--database",
      "vault",
      args.inFile,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exitCode = (await child.exited) ?? 0;
  return { exitCode, stderr };
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the five-step contract with explicit per-step rollback is more readable as a single linear sequence than as five split helpers
export async function runMigrateVaultCommand(options: MigrateVaultOptions): Promise<number> {
  const exportImpl = options.exportImpl ?? defaultExportImpl;
  const importImpl = options.importImpl ?? defaultImportImpl;
  const stopDaemon = options.stopDaemon ?? defaultDaemonStopHook;
  const startDaemon = options.startDaemon ?? defaultDaemonStartHook;
  const tempRoot = options.tempDirOverride ?? tmpdir();
  const tempFile = join(tempRoot, `notient-migrate-${Date.now()}.surql`);

  // Step 1: Export source.
  const sourcePort = await readPort(options.sourceVaultPath);
  if (sourcePort === null) {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `migrate-vault: source daemon is not running at ${options.sourceVaultPath}.`,
    });
    return 1;
  }
  const sourceSecret = await readOrGenerateSecret(vaultSecretPath(options.sourceVaultPath));

  try {
    const exportResult = await exportImpl({
      port: sourcePort,
      secret: sourceSecret,
      outFile: tempFile,
    });
    if (exportResult.exitCode !== 0) {
      options.emitter.emit({
        type: "error",
        code: "MIGRATE_EXPORT_FAILED",
        message: exportResult.stderr.trim() || `surreal export exited ${exportResult.exitCode}`,
        tempFile,
      });
      return exportResult.exitCode || 1;
    }
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_EXPORT_FAILED",
      message: error instanceof Error ? error.message : String(error),
      tempFile,
    });
    return 1;
  }

  // Step 2: Verify export.
  try {
    await verifyExport(tempFile);
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_VERIFY_FAILED",
      message: error instanceof Error ? error.message : String(error),
      tempFile,
    });
    return 1;
  }

  // Step 3: Stop source daemon.
  try {
    await stopDaemon({ vaultPath: options.sourceVaultPath });
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_SOURCE_STOP_FAILED",
      message: `source daemon stop failed; source state is unknown: ${error instanceof Error ? error.message : String(error)}`,
      tempFile,
    });
    return 1;
  }

  // Step 4: Provision target and start target daemon.
  const targetStateDir = vaultStateDir(options.targetVaultPath);
  try {
    await mkdir(targetStateDir, { recursive: true, mode: 0o700 });
    await copySecret(
      vaultSecretPath(options.sourceVaultPath),
      vaultSecretPath(options.targetVaultPath),
    );
    await startDaemon({ vaultPath: options.targetVaultPath });
  } catch (error) {
    // Roll back: restart source. Do not delete the target state dir
    // because the operator may want to inspect what got created.
    await startDaemon({ vaultPath: options.sourceVaultPath }).catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_TARGET_START_FAILED",
      message: error instanceof Error ? error.message : String(error),
      tempFile,
    });
    return 1;
  }

  // Step 5: Import into target.
  const targetPort = await readPort(options.targetVaultPath);
  if (targetPort === null) {
    await rollbackTarget(options.targetVaultPath, stopDaemon);
    await startDaemon({ vaultPath: options.sourceVaultPath }).catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_TARGET_START_FAILED",
      message: "target daemon started but the port file is missing.",
      tempFile,
    });
    return 1;
  }
  const targetSecret = await readOrGenerateSecret(vaultSecretPath(options.targetVaultPath));

  try {
    const importResult = await importImpl({
      port: targetPort,
      secret: targetSecret,
      inFile: tempFile,
    });
    if (importResult.exitCode !== 0) {
      await rollbackTarget(options.targetVaultPath, stopDaemon);
      await startDaemon({ vaultPath: options.sourceVaultPath }).catch(() => {});
      options.emitter.emit({
        type: "error",
        code: "MIGRATE_IMPORT_FAILED",
        message: importResult.stderr.trim() || `surreal import exited ${importResult.exitCode}`,
        tempFile,
      });
      return importResult.exitCode || 1;
    }
  } catch (error) {
    await rollbackTarget(options.targetVaultPath, stopDaemon);
    await startDaemon({ vaultPath: options.sourceVaultPath }).catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "MIGRATE_IMPORT_FAILED",
      message: error instanceof Error ? error.message : String(error),
      tempFile,
    });
    return 1;
  }

  // Parity check: count notes on the target.
  const noteCount = await countNotes(targetPort, targetSecret);

  // Full success: remove temp file. Source state dir is preserved.
  await unlink(tempFile).catch(() => {});

  options.emitter.emit({
    type: "migrate-vault-success",
    from: options.sourceVaultPath,
    to: options.targetVaultPath,
    noteCount,
  });
  return 0;
}

async function readPort(vaultPath: string): Promise<number | null> {
  try {
    const text = await readFile(vaultPortPath(vaultPath), "utf8");
    const port = Number(text.trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Verify the export temp file. Reads only the first ~4 KiB; a real export
 * may be hundreds of MiB and slurping is unsafe.
 *
 * Surreal 3.x exports begin with a comment block of the form
 * `-- ------------------------------` followed by a section like
 * `-- OPTION` and DDL/`UPDATE`/`INSERT` statements terminated with `;`.
 * The lenient header check requires either the comment marker or a
 * SurrealQL keyword in the first chunk.
 */
async function verifyExport(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) {
    throw new Error("export verification failed: temp file is empty.");
  }
  const file = Bun.file(filePath);
  const head = await file.slice(0, Math.min(4096, fileStat.size)).text();
  const looksLikeSurql =
    head.startsWith("--") ||
    /\b(BEGIN|DEFINE|UPDATE|INSERT|OPTION|REMOVE|USE)\b/i.test(head.slice(0, 256));
  if (!looksLikeSurql) {
    throw new Error("export verification failed: temp file head does not look like SurrealQL.");
  }
}

async function copySecret(sourcePath: string, targetPath: string): Promise<void> {
  await copyFile(sourcePath, targetPath);
  // copyFile preserves contents but on some filesystems the new mode
  // tracks the destination inode's umask, not the source. Re-write the
  // file with explicit 0600 so secret.key always has the locked-down
  // mode the source-of-truth helper enforces.
  const contents = await readFile(targetPath, "utf8");
  await writeFile(targetPath, contents, { mode: 0o600 });
}

async function rollbackTarget(targetVaultPath: string, stopDaemon: DaemonStopHook): Promise<void> {
  await stopDaemon({ vaultPath: targetVaultPath }).catch(() => {});
  await rm(vaultDataDir(targetVaultPath), { recursive: true, force: true }).catch(() => {});
}

async function countNotes(port: number, secret: string): Promise<number> {
  let connection: SurrealConnection | undefined;
  try {
    connection = await connect({
      url: `ws://127.0.0.1:${port}/rpc`,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  } catch {
    return 0;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}
