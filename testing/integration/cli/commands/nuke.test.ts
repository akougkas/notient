/**
 * Phase 5 Task 10 nuke CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/nuke.test.ts`.
 *
 * Replaces the daemon stop/start hooks with helpers that drive a single
 * SurrealDB child process directly. This keeps the test free of the
 * full daemon (unix socket, watcher, kernel) while still exercising the
 * core invariants:
 *   - Confirmation refused when --yes is absent and stdin is non-TTY.
 *   - With --yes, the data dir is removed and a fresh dir is created on
 *     restart with the schema reapplied.
 *   - Idempotent on an already-empty data dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect as connectSurreal,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import {
  vaultDataDir,
  vaultPortPath,
  vaultSecretPath,
  vaultStateDir,
} from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { makeEmitter } from "../../../../src/cli/output";
import type { DaemonStartHook, DaemonStopHook } from "../../../../src/cli/commands/daemonControl";
import { runNukeCommand } from "../../../../src/cli/commands/nuke";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface DaemonState {
  handle: SurrealServerHandle | null;
  connection: SurrealConnection | null;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] nuke CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let state: DaemonState;
  const secret = "phase5-task10-nuke-secret";

  async function startDaemonProxy(): Promise<void> {
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
    state.handle = handle;
    state.connection = connection;
  }

  async function stopDaemonProxy(): Promise<void> {
    if (state.connection !== null) {
      await state.connection.close().catch(() => {});
      state.connection = null;
    }
    if (state.handle !== null) {
      await state.handle.stop().catch(() => {});
      state.handle = null;
    }
  }

  const stopHook: DaemonStopHook = async () => {
    await stopDaemonProxy();
  };
  const startHook: DaemonStartHook = async () => {
    await startDaemonProxy();
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-nuke-cli-"));
    const homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    vaultPath = path.join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });
    await mkdir(vaultStateDir(vaultPath), { recursive: true, mode: 0o700 });
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });

    state = { handle: null, connection: null };
    await startDaemonProxy();
  });

  afterEach(async () => {
    await stopDaemonProxy();
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("[smoke] nuke removes the data dir and the daemon restarts with empty schema", async () => {
    if (state.connection === null) throw new Error("setup error: no connection");
    await upsertNoteByPath(state.connection.db, {
      path: "doomed.md",
      sha: "sha-doomed",
      wordCount: 4,
    });
    const [before] = await state.connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(before[0]?.count ?? 0).toBe(1);

    const dataDir = vaultDataDir(vaultPath);
    const beforeStat = await stat(dataDir);
    expect(beforeStat.isDirectory()).toBe(true);

    const exitCode = await runNukeCommand({
      vaultPath,
      yes: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stopDaemon: stopHook,
      startDaemon: startHook,
    });
    expect(exitCode).toBe(0);

    if (state.connection === null) throw new Error("expected reconnected connection");
    const [after] = await state.connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(after[0]?.count ?? 0).toBe(0);
  }, 30_000);

  test("[smoke] nuke is idempotent on an already-empty data dir", async () => {
    await stopDaemonProxy();
    await rm(vaultDataDir(vaultPath), { recursive: true, force: true });

    const exitCode = await runNukeCommand({
      vaultPath,
      yes: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stopDaemon: stopHook,
      startDaemon: startHook,
    });
    expect(exitCode).toBe(0);
    expect(state.handle).not.toBeNull();
    expect(state.connection).not.toBeNull();
  }, 30_000);

  test("[smoke] nuke without --yes refuses on non-TTY stdin", async () => {
    // Build a Readable that explicitly reports isTTY = false.
    const { Readable } = await import("node:stream");
    const fakeStdin = Object.assign(Readable.from([]), {
      isTTY: false,
    }) as NodeJS.ReadableStream & {
      isTTY?: boolean;
    };
    const exitCode = await runNukeCommand({
      vaultPath,
      yes: false,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stopDaemon: stopHook,
      startDaemon: startHook,
      stdin: fakeStdin,
    });
    expect(exitCode).toBe(2);
    // The data dir should still exist because we refused before doing work.
    const fileStat = await stat(vaultDataDir(vaultPath));
    expect(fileStat.isDirectory()).toBe(true);
  });
});
