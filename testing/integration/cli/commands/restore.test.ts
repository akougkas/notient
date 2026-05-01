/**
 * Phase 5 Task 10 restore CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/restore.test.ts`.
 *
 * Two test cases:
 *   - Empty target accepts a fixture .surql produced via `surreal export`.
 *   - Non-empty target refuses with exit 2 and a nuke-instruction message.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBackupCommand } from "../../../../src/cli/commands/backup";
import { runRestoreCommand } from "../../../../src/cli/commands/restore";
import { makeEmitter } from "../../../../src/cli/output";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] restore CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  let dumpFile: string;
  const secret = "phase5-task10-restore-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-restore-cli-"));
    const homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    vaultPath = path.join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    handle = await startSurreal({
      dataDir: path.join(tempDir, "surreal-data"),
      secret,
      portFile: path.join(tempDir, "surreal.port"),
      pidFile: path.join(tempDir, "surreal.pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);

    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), port, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });

    // Produce a fixture dump from a temporarily-seeded vault, then drop
    // the rows so each test starts with a known state.
    await upsertNoteByPath(connection.db, {
      path: "fixture.md",
      sha: "sha-fixture",
      wordCount: 7,
    });
    dumpFile = path.join(tempDir, "fixture.surql");
    const fixtureExit = await runBackupCommand({
      vaultPath,
      outPath: dumpFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(fixtureExit).toBe(0);
    await connection.db.query("DELETE note;").collect();
  });

  afterAll(async () => {
    if (connection !== undefined) await connection.close().catch(() => {});
    if (handle !== undefined) await handle.stop().catch(() => {});
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await connection.db.query("DELETE note;").collect();
  });

  test("[smoke] restore on an empty vault repopulates note rows", async () => {
    const before = await countNotes();
    expect(before).toBe(0);

    const exitCode = await runRestoreCommand({
      vaultPath,
      inputPath: dumpFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(exitCode).toBe(0);

    const after = await countNotes();
    expect(after).toBeGreaterThan(0);
  });

  test("[smoke] restore refuses with exit 2 when any tracked table is non-empty", async () => {
    await upsertNoteByPath(connection.db, {
      path: "occupied.md",
      sha: "sha-occupied",
      wordCount: 3,
    });

    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const exitCode = await runRestoreCommand({
      vaultPath,
      inputPath: dumpFile,
      emitter,
    });
    expect(exitCode).toBe(2);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe("DB_NOT_EMPTY");
    expect(String(errorEvent?.message)).toContain("notient nuke");
  });

  async function countNotes(): Promise<number> {
    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM note GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    return rows[0]?.count ?? 0;
  }
});
