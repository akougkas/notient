/**
 * Phase 5 Task 10 backup CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/backup.test.ts`.
 *
 * Boots a real SurrealDB, applies the schema, hand-writes a per-vault
 * state directory under a tempdir-rooted `HOME`, seeds a single note,
 * runs `runBackupCommand`, and asserts the dump file is non-empty and
 * looks like SurrealQL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { makeEmitter } from "../../../../src/cli/output";
import { runBackupCommand } from "../../../../src/cli/commands/backup";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] backup CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task10-backup-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-backup-cli-"));
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
    await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });

    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), port, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });
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

  test("[smoke] backup writes a non-empty SurrealQL dump to the default path", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const exitCode = await runBackupCommand({ vaultPath, emitter });
    expect(exitCode).toBe(0);
    const success = events.find((event) => event.type === "backup-success");
    expect(success).toBeDefined();
    const outPath = success?.path as string;
    expect(typeof outPath).toBe("string");
    const fileStat = await stat(outPath);
    expect(fileStat.size).toBeGreaterThan(0);
    const text = await Bun.file(outPath).text();
    expect(text.length).toBeGreaterThan(0);
    // Lenient header check matching the verifier in migrate-vault.
    expect(/^(--|BEGIN|DEFINE|UPDATE|INSERT|OPTION|REMOVE|USE)/i.test(text.slice(0, 256))).toBe(
      true,
    );
  });

  test("[smoke] backup honours an explicit --out path", async () => {
    const explicit = path.join(tempDir, `explicit-${Date.now()}.surql`);
    const exitCode = await runBackupCommand({
      vaultPath,
      outPath: explicit,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(exitCode).toBe(0);
    const fileStat = await stat(explicit);
    expect(fileStat.size).toBeGreaterThan(0);
  });
});
