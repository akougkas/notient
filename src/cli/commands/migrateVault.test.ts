/**
 * Phase 5 Task 10 migrate-vault CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/migrateVault.test.ts`.
 *
 * Drives the five-step contract end-to-end with a single SurrealDB child
 * process at a time. The injected stop/start hooks shut the source down
 * before the target comes up, mirroring production semantics: the
 * operator hands control of the data directory from the source vault-id
 * to the target vault-id.
 *
 * Two test cases:
 *   (a) Happy path: seed source, run migrate-vault, assert target has
 *       the same notes, source state dir is preserved, temp file is
 *       cleaned up.
 *   (b) Failure injection: import shell-out fails. Assert source is
 *       running, target data dir is gone, exit non-zero, temp file is
 *       preserved.
 *
 * The Step 4 failure is also covered: the start hook for the target
 * raises and the harness asserts source is restarted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../core/db/schemaApplier";
import {
  type SurrealConnection,
  connect as connectSurreal,
  upsertNoteByPath,
} from "../../core/db/surreal";
import {
  vaultDataDir,
  vaultPortPath,
  vaultSecretPath,
  vaultStateDir,
} from "../../core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { makeEmitter } from "../output";
import type { DaemonStartHook, DaemonStopHook } from "./daemonControl";
import {
  type ImportImpl,
  defaultExportImpl,
  defaultImportImpl,
  runMigrateVaultCommand,
} from "./migrateVault";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface DaemonRegistry {
  active: SurrealServerHandle | null;
  activeVault: string | null;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] migrate-vault CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let sourceVault: string;
  let targetVault: string;
  let registry: DaemonRegistry;
  const secret = "phase5-task10-migrate-secret";

  async function startVaultDaemon(vaultPath: string): Promise<void> {
    if (registry.active !== null) {
      throw new Error(
        `start: another daemon is already running for ${registry.activeVault}; stop it first`,
      );
    }
    await mkdir(vaultStateDir(vaultPath), { recursive: true, mode: 0o700 });
    const handle = await startSurreal({
      dataDir: vaultDataDir(vaultPath),
      secret,
      portFile: vaultPortPath(vaultPath),
      pidFile: path.join(vaultStateDir(vaultPath), "surreal.pid"),
      logLevel: "warn",
    });
    const connection = await connectSurreal({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
    await connection.close();
    registry.active = handle;
    registry.activeVault = vaultPath;
  }

  async function stopVaultDaemon(): Promise<void> {
    if (registry.active === null) return;
    await registry.active.stop().catch(() => {});
    registry.active = null;
    registry.activeVault = null;
  }

  const stopHook: DaemonStopHook = async () => {
    await stopVaultDaemon();
  };
  const startHook: DaemonStartHook = async (args) => {
    await startVaultDaemon(args.vaultPath);
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-migrate-cli-"));
    const homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    sourceVault = path.join(tempDir, "source-vault");
    targetVault = path.join(tempDir, "target-vault");
    await mkdir(sourceVault, { recursive: true });
    await mkdir(targetVault, { recursive: true });

    await mkdir(vaultStateDir(sourceVault), { recursive: true, mode: 0o700 });
    await writeFile(vaultSecretPath(sourceVault), secret, { mode: 0o600 });

    registry = { active: null, activeVault: null };
    await startVaultDaemon(sourceVault);

    const port = await readPort(sourceVault);
    if (port === null) throw new Error("setup error: source port file missing");
    const sourceConnection = await connectSurreal({
      url: `ws://127.0.0.1:${port}/rpc`,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    for (const name of ["alpha", "beta", "gamma"]) {
      await upsertNoteByPath(sourceConnection.db, {
        path: `${name}.md`,
        sha: `sha-${name}`,
        wordCount: 4,
      });
    }
    await sourceConnection.close();
  });

  afterEach(async () => {
    await stopVaultDaemon();
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("[smoke] happy path migrates note rows and preserves source state dir", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const tempRoot = path.join(tempDir, "tmp");
    await mkdir(tempRoot, { recursive: true });

    const exitCode = await runMigrateVaultCommand({
      sourceVaultPath: sourceVault,
      targetVaultPath: targetVault,
      tempDirOverride: tempRoot,
      stopDaemon: stopHook,
      startDaemon: startHook,
      emitter,
    });
    expect(exitCode).toBe(0);
    const success = events.find((event) => event.type === "migrate-vault-success");
    expect(success).toBeDefined();
    expect(success?.from).toBe(sourceVault);
    expect(success?.to).toBe(targetVault);
    expect(typeof success?.noteCount).toBe("number");
    expect(success?.noteCount).toBe(3);

    // Source state dir is preserved: the operator owns cleanup.
    const sourceStat = await stat(vaultStateDir(sourceVault));
    expect(sourceStat.isDirectory()).toBe(true);

    // Temp file is gone on full success.
    const tempEntries = await Bun.$`ls ${tempRoot}`.text();
    expect(tempEntries.includes("notient-migrate-")).toBe(false);

    // Target should be running with the imported notes.
    const targetPort = await readPort(targetVault);
    expect(targetPort).not.toBeNull();
    if (targetPort === null) return;
    const targetConn = await connectSurreal({
      url: `ws://127.0.0.1:${targetPort}/rpc`,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    const [rows] = await targetConn.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    await targetConn.close();
    expect(rows[0]?.count ?? 0).toBe(3);
  }, 60_000);

  test("[smoke] step 5 import failure rolls back target and preserves source + temp file", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const tempRoot = path.join(tempDir, "tmp");
    await mkdir(tempRoot, { recursive: true });

    const failingImport: ImportImpl = async () => ({
      exitCode: 1,
      stderr: "synthetic import failure for test",
    });

    const exitCode = await runMigrateVaultCommand({
      sourceVaultPath: sourceVault,
      targetVaultPath: targetVault,
      tempDirOverride: tempRoot,
      exportImpl: defaultExportImpl,
      importImpl: failingImport,
      stopDaemon: stopHook,
      startDaemon: startHook,
      emitter,
    });
    expect(exitCode).not.toBe(0);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.code).toBe("MIGRATE_IMPORT_FAILED");
    expect(errorEvent?.tempFile).toBeDefined();

    // Temp file is preserved on failure.
    const tempPath = errorEvent?.tempFile as string;
    const tempStat = await stat(tempPath);
    expect(tempStat.size).toBeGreaterThan(0);

    // Source must be running.
    expect(registry.activeVault).toBe(sourceVault);

    // Target data dir is gone after rollback.
    let targetExists = true;
    try {
      await stat(vaultDataDir(targetVault));
    } catch {
      targetExists = false;
    }
    expect(targetExists).toBe(false);
  }, 60_000);

  test("[smoke] step 4 target start failure restarts source", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const tempRoot = path.join(tempDir, "tmp");
    await mkdir(tempRoot, { recursive: true });

    let targetStartAttempted = false;
    const failingStart: DaemonStartHook = async (args) => {
      if (args.vaultPath === targetVault && !targetStartAttempted) {
        targetStartAttempted = true;
        throw new Error("synthetic target start failure for test");
      }
      await startVaultDaemon(args.vaultPath);
    };

    const exitCode = await runMigrateVaultCommand({
      sourceVaultPath: sourceVault,
      targetVaultPath: targetVault,
      tempDirOverride: tempRoot,
      stopDaemon: stopHook,
      startDaemon: failingStart,
      // No need to fail import; we never reach it.
      importImpl: defaultImportImpl,
      emitter,
    });
    expect(exitCode).not.toBe(0);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.code).toBe("MIGRATE_TARGET_START_FAILED");

    // Source is restarted.
    expect(registry.activeVault).toBe(sourceVault);

    // Temp file is preserved.
    const tempPath = errorEvent?.tempFile as string;
    const tempStat = await stat(tempPath);
    expect(tempStat.size).toBeGreaterThan(0);
  }, 60_000);
});

async function readPort(vaultPath: string): Promise<number | null> {
  try {
    const text = await Bun.file(vaultPortPath(vaultPath)).text();
    const port = Number(text.trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
