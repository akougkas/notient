/**
 * `notient backup` CLI verb.
 *
 * Spawns `surreal export` against the running per-vault daemon and writes a
 * records-only SurrealQL dump to a private file. Schema/access definitions,
 * runtime metadata, derived indexes, unresolved staging, and persisted agent
 * grants never enter the backup. The command propagates the child process's
 * exit code verbatim.
 *
 * Default `--out` path is
 * `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql`. Operators who
 * pass `--out` get the literal path written.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import type { Emitter } from "../output";
import { verifyGraphSnapshot } from "./graphSnapshot";
import {
  type AcquireGraphMaintenanceOptions,
  type GraphMaintenanceLease,
  acquireGraphMaintenanceLease,
} from "./maintenanceLease";
import {
  BACKUP_FILE_HEADER,
  createBackupAuthenticator,
  formatBackupAuthTrailer,
  formatBackupEmbeddingManifest,
} from "./surrealBackupFormat";
import {
  buildSurrealDataInvocation,
  parseDaemonPortFile,
  parseSurrealCliExitCode,
} from "./surrealCli";
import { writeRecordsOnlyExport } from "./surrealRecordExport";

export interface BackupOptions {
  vaultPath: string;
  outPath?: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export interface BackupDependencies {
  acquireMaintenance(options: AcquireGraphMaintenanceOptions): Promise<GraphMaintenanceLease>;
}

const DEFAULT_BACKUP_DEPENDENCIES: BackupDependencies = {
  acquireMaintenance: acquireGraphMaintenanceLease,
};

interface BackupBuildResult {
  exitCode: number;
  failure: string | null;
  stagingPath: string | null;
}

interface SequentialWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
}

/**
 * Returns an ISO-8601 timestamp safe for filesystem paths. The colons in
 * the standard form break Windows path semantics and confuse shell tab
 * completion on POSIX, so they collapse to dashes.
 */
function timestampFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runBackupCommand(
  options: BackupOptions,
  dependencies: BackupDependencies = DEFAULT_BACKUP_DEPENDENCIES,
): Promise<number> {
  const port = await readBackupDaemonPort(options);
  if (port === null) return 1;
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));
  const outPath =
    options.outPath ??
    join(vaultStateDir(options.vaultPath), "backups", `${timestampFilename()}.surql`);

  let lease: GraphMaintenanceLease;
  try {
    lease = await dependencies.acquireMaintenance({
      vaultPath: options.vaultPath,
      operation: "backup",
      ...(options.clientIdentity === undefined ? {} : { clientIdentity: options.clientIdentity }),
    });
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "BACKUP_FAILED",
      message: `could not enter exclusive daemon maintenance: ${formatError(error)}`,
    });
    return 1;
  }

  let build: BackupBuildResult;
  try {
    build = await runMaintainedBackup(options, port, secret, outPath);
  } catch (error) {
    build = { exitCode: 1, failure: formatError(error), stagingPath: null };
  }
  const releaseFailure = await releaseBackupMaintenance(lease);
  return finishBackupCommand(options, outPath, build, releaseFailure);
}

async function readBackupDaemonPort(options: BackupOptions): Promise<number | null> {
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

async function releaseBackupMaintenance(lease: GraphMaintenanceLease): Promise<string | null> {
  try {
    const released = await lease.release();
    return released.vaultChanged
      ? "Markdown changed while the exclusive backup was running; the private staging artifact was discarded. Retry after the editor is idle."
      : null;
  } catch (error) {
    return `daemon maintenance release failed: ${formatError(error)}`;
  }
}

async function finishBackupCommand(
  options: BackupOptions,
  outPath: string,
  build: BackupBuildResult,
  releaseFailure: string | null,
): Promise<number> {
  if (releaseFailure !== null || build.failure !== null || build.stagingPath === null) {
    if (build.stagingPath !== null) await rm(build.stagingPath, { force: true }).catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "BACKUP_FAILED",
      message: releaseFailure ?? build.failure ?? "backup staging failed",
    });
    return releaseFailure === null ? build.exitCode : 1;
  }

  try {
    await publishStagedBackup(build.stagingPath, outPath);
  } catch (error) {
    await rm(build.stagingPath, { force: true }).catch(() => {});
    options.emitter.emit({
      type: "error",
      code: "BACKUP_FAILED",
      message:
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? `backup refused: output path already exists: ${outPath}`
          : `backup publication failed: ${formatError(error)}`,
    });
    return 1;
  }

  options.emitter.emit({ type: "backup-success", path: outPath });
  return 0;
}

async function runMaintainedBackup(
  options: BackupOptions,
  port: number,
  secret: string,
  outPath: string,
): Promise<BackupBuildResult> {
  const embedding = await readBackupEmbeddingManifest(options, port, secret);
  if (embedding.failure !== null) {
    return {
      exitCode: 1,
      failure: embedding.failure,
      stagingPath: null,
    };
  }

  const stagingPath = join(dirname(outPath), `.notient-backup-${randomUUID()}.tmp`);
  // The operator-selected path remains untouched until the maintenance lease
  // has released cleanly. All in-flight work belongs to this unguessable,
  // private same-directory staging inode.
  const output = await createBackupStaging(stagingPath);
  if (output.failure !== null) {
    return { exitCode: 1, failure: output.failure, stagingPath: null };
  }

  let result = await writeStagedBackup(options, port, secret, embedding.manifest, output.handle);
  const closeFailure = await closeBackupOutput(output.handle);
  if (closeFailure !== null) result = { exitCode: 1, failure: closeFailure };

  if (result.failure !== null) {
    await rm(stagingPath, { force: true }).catch(() => {});
    return { ...result, stagingPath: null };
  }
  return { exitCode: 0, failure: null, stagingPath };
}

type EmbeddingManifestResult =
  | { manifest: Awaited<ReturnType<typeof verifyGraphSnapshot>>; failure: null }
  | { manifest?: never; failure: string };

async function readBackupEmbeddingManifest(
  options: BackupOptions,
  port: number,
  secret: string,
): Promise<EmbeddingManifestResult> {
  try {
    const manifest = await verifyGraphSnapshot({
      vaultPath: options.vaultPath,
      port,
      secret,
      recoverImportedRuns: false,
    });
    return { manifest, failure: null };
  } catch (error) {
    return {
      failure: `backup requires an exact, complete Markdown/index snapshot: ${formatError(error)}`,
    };
  }
}

type BackupOutput = Awaited<ReturnType<typeof open>>;

type BackupStagingResult =
  | { failure: null; handle: BackupOutput }
  | { failure: string; handle?: never };

async function createBackupStaging(stagingPath: string): Promise<BackupStagingResult> {
  try {
    await mkdir(dirname(stagingPath), { recursive: true, mode: 0o700 });
    return { failure: null, handle: await open(stagingPath, "wx", 0o600) };
  } catch (error) {
    return { failure: `backup staging creation failed: ${formatError(error)}` };
  }
}

interface BackupExportResult {
  exitCode: number;
  failure: string | null;
}

async function writeStagedBackup(
  options: BackupOptions,
  port: number,
  secret: string,
  embeddingManifest: Awaited<ReturnType<typeof verifyGraphSnapshot>>,
  output: BackupOutput,
): Promise<BackupExportResult> {
  // `surreal export` shells out to the HTTP transport, not the WebSocket
  // RPC endpoint; the same `surreal start` process accepts both on the
  // bound port. The daemon's port file records the port without scheme
  // so we reuse it verbatim.
  const invocation = buildSurrealDataInvocation({
    operation: "export",
    port,
    secret,
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
  });
  try {
    const authenticator = createBackupAuthenticator(secret);
    const writeAuthenticated = async (text: string): Promise<void> => {
      const bytes = Buffer.from(text);
      await writeAll(output, bytes);
      authenticator.update(bytes);
    };
    await writeAuthenticated(BACKUP_FILE_HEADER);
    await writeAuthenticated(formatBackupEmbeddingManifest(embeddingManifest));
    const child = Bun.spawn(invocation.argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: invocation.env,
    });
    const [stderrResult, exitResult, filterResult] = await Promise.allSettled([
      new Response(child.stderr).text(),
      child.exited,
      writeRecordsOnlyExport(child.stdout, { write: writeAuthenticated }).catch((error) => {
        try {
          child.kill();
        } catch {
          // The exporter already exited.
        }
        throw error;
      }),
    ]);
    const exportResult = evaluateSurrealExport(stderrResult, exitResult, filterResult);
    if (exportResult.failure !== null) return exportResult;
    await assertEmbeddingIdentityUnchanged(options, port, secret, embeddingManifest);
    await writeAll(output, Buffer.from(formatBackupAuthTrailer(authenticator.digest("hex"))));
    await output.sync();
    return { exitCode: 0, failure: null };
  } catch (error) {
    return { exitCode: 1, failure: formatError(error) };
  }
}

function evaluateSurrealExport(
  stderrResult: PromiseSettledResult<string>,
  exitResult: PromiseSettledResult<number>,
  filterResult: PromiseSettledResult<void>,
): BackupExportResult {
  if (stderrResult.status === "rejected") {
    return {
      exitCode: 1,
      failure: `surreal export stderr read failed: ${formatError(stderrResult.reason)}`,
    };
  }
  if (exitResult.status === "rejected") {
    return { exitCode: 1, failure: formatError(exitResult.reason) };
  }
  const exitCode = parseSurrealCliExitCode(exitResult.value);
  if (exitCode !== 0) {
    const stderrText = stderrResult.value.trim();
    return {
      exitCode,
      failure: stderrText.length > 0 ? stderrText : `surreal export exited ${exitCode}`,
    };
  }
  if (filterResult.status === "rejected") {
    return { exitCode: 1, failure: formatError(filterResult.reason) };
  }
  return { exitCode: 0, failure: null };
}

async function assertEmbeddingIdentityUnchanged(
  options: BackupOptions,
  port: number,
  secret: string,
  initial: Awaited<ReturnType<typeof verifyGraphSnapshot>>,
): Promise<void> {
  const final = await verifyGraphSnapshot({
    vaultPath: options.vaultPath,
    port,
    secret,
    recoverImportedRuns: false,
  });
  if (final.model !== initial.model || final.dimension !== initial.dimension) {
    throw new Error("embedding identity changed while the backup export was running");
  }
}

async function closeBackupOutput(output: BackupOutput): Promise<string | null> {
  try {
    await output.close();
    return null;
  } catch (error) {
    return `backup output close failed: ${formatError(error)}`;
  }
}

/** Persist every byte even when the underlying FileHandle performs short writes. */
export async function writeAll(writer: SequentialWriter, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await writer.write(bytes, offset, bytes.byteLength - offset, null);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.byteLength - offset
    ) {
      throw new Error("backup output write made no forward progress");
    }
    offset += bytesWritten;
  }
}

async function publishStagedBackup(stagingPath: string, outPath: string): Promise<void> {
  // A same-directory hard link is one atomic, no-clobber publication step.
  // The final pathname either remains absent or names the fully fsynced inode.
  await link(stagingPath, outPath);
  await rm(stagingPath, { force: true }).catch(() => {});
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
