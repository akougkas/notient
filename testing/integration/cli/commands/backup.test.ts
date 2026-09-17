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
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBackupCommand } from "../../../../src/cli/commands/backup";
import { makeEmitter } from "../../../../src/cli/output";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { sha256Hex } from "../../../../src/core/utils/sha256";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { acquireNoopMaintenanceLease } from "../../../helpers/maintenanceLease";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] backup CLI", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task10-backup-secret";
  const grantMarker = "backup-must-not-revive-this-grant";
  const unresolvedMarker = "backup-must-not-carry-unresolved-staging";
  const noteBody = "# Alpha\n\nComplete fixture.\n";

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
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
    await writeFile(path.join(vaultPath, "alpha.md"), noteBody, "utf8");
    const noteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: await sha256Hex(noteBody),
      wordCount: 5,
    });
    await connection.db
      .query(
        "UPDATE $noteId SET tier1_at = time::now(), tier2_at = time::now(), tier3_at = time::now(), linker_refresh_pending = false;",
        { noteId },
      )
      .collect();
    await connection.db
      .query(
        "CREATE ONLY $sessionId CONTENT { client: $client, granted_at: 1, expires_at: 9999999999999, allowed_folders: ['Private'], allowed_tools: ['notes.append'], max_writes: 1 }; CREATE wikilink_unresolved CONTENT { in: $noteId, raw_target: $rawTarget, source: 'wikilink' };",
        {
          sessionId: createUuidRecordId("agent_session"),
          client: grantMarker,
          noteId,
          rawTarget: unresolvedMarker,
        },
      )
      .collect();
    for (const table of ["agent_session", "wikilink_unresolved", "meta"]) {
      const [rows] = await connection.db
        .query<[Array<{ count: number }>]>(`SELECT count() AS count FROM ${table} GROUP ALL;`)
        .collect<[Array<{ count: number }>]>();
      expect(rows[0]?.count).toBeGreaterThan(0);
    }

    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), `${port}\n`, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });
  }, 30_000);

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
  }, 30_000);

  test("[smoke] backup writes a non-empty SurrealQL dump to the default path", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    const exitCode = await runBackupCommand(
      { vaultPath, emitter },
      { acquireMaintenance: acquireNoopMaintenanceLease },
    );
    if (exitCode !== 0) throw new Error(`backup failed: ${JSON.stringify(events)}`);
    expect(exitCode).toBe(0);
    const success = events.find((event) => event.type === "backup-success");
    expect(success).toBeDefined();
    const outPath = success?.path as string;
    expect(typeof outPath).toBe("string");
    const fileStat = await stat(outPath);
    expect(fileStat.size).toBeGreaterThan(0);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const text = await Bun.file(outPath).text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("alpha.md");
    // Lenient header check on the SurrealQL dump.
    expect(/^(--|BEGIN|DEFINE|UPDATE|INSERT|OPTION|REMOVE|USE)/i.test(text.slice(0, 256))).toBe(
      true,
    );
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\bDEFINE\s+ACCESS\b/i);
    expect(text).not.toMatch(/\bDEFINE\s+(?:TABLE|FIELD|INDEX)\b/i);
    expect(text).not.toMatch(/\bDEFINE\b/i);
    expect(text).not.toContain("conversation_memory");
    expect(text).not.toMatch(/\bmeta\b/);
    expect(text).not.toContain("-- TABLE DATA: agent_session");
    expect(text).not.toContain(grantMarker);
    expect(text).not.toContain("-- TABLE DATA: wikilink_unresolved");
    expect(text).not.toContain(unresolvedMarker);
  });

  test("[smoke] backup honours an explicit --out path", async () => {
    const explicit = path.join(tempDir, `explicit-${Date.now()}.surql`);
    const exitCode = await runBackupCommand(
      {
        vaultPath,
        outPath: explicit,
        emitter: makeEmitter({ mode: "json", write: () => {} }),
      },
      { acquireMaintenance: acquireNoopMaintenanceLease },
    );
    expect(exitCode).toBe(0);
    const fileStat = await stat(explicit);
    expect(fileStat.size).toBeGreaterThan(0);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  test("[smoke] backup refuses to overwrite an existing output", async () => {
    const explicit = path.join(tempDir, `existing-${Date.now()}.surql`);
    await writeFile(explicit, "operator-owned", { mode: 0o644 });
    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runBackupCommand(
      {
        vaultPath,
        outPath: explicit,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      { acquireMaintenance: acquireNoopMaintenanceLease },
    );

    expect(exitCode).toBe(1);
    expect(await Bun.file(explicit).text()).toBe("operator-owned");
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("BACKUP_FAILED");
    expect(String(events[0]?.message)).toContain("already exists");
  });

  test("[smoke] backup removes a dump invalidated by external Markdown drift", async () => {
    const explicit = path.join(tempDir, `drifted-${Date.now()}.surql`);
    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runBackupCommand(
      {
        vaultPath,
        outPath: explicit,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: async () => ({
          ...(await acquireNoopMaintenanceLease()),
          release: async () => ({ vaultChanged: true }),
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(await Bun.file(explicit).exists()).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("BACKUP_FAILED");
    expect(String(events[0]?.message)).toContain("Markdown changed");
  });

  test("[smoke] failure cleanup never deletes a concurrent final-path replacement", async () => {
    const explicit = path.join(tempDir, `replacement-${Date.now()}.surql`);
    const replacement = "operator replacement created while maintenance released";
    const events: Array<Record<string, unknown>> = [];
    const exitCode = await runBackupCommand(
      {
        vaultPath,
        outPath: explicit,
        emitter: makeEmitter({
          mode: "json",
          write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
      {
        acquireMaintenance: async () => ({
          ...(await acquireNoopMaintenanceLease()),
          release: async () => {
            await writeFile(explicit, replacement, { mode: 0o600, flag: "wx" });
            return { vaultChanged: true };
          },
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(await Bun.file(explicit).text()).toBe(replacement);
    expect(events).toHaveLength(1);
    expect(String(events[0]?.message)).toContain("Markdown changed");
    expect((await readdir(tempDir)).filter((name) => name.startsWith(".notient-backup-"))).toEqual(
      [],
    );
  });
});
