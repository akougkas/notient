/**
 * Phase 5 Task 9 links sync CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/linksSync.test.ts`.
 *
 * Seeds a state-2 row (`approved = true AND applied = false`), invokes
 * `runLinksSyncCommand`, and asserts the row reaches state 3 via the
 * inline ApprovalService.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import { runLinksSyncCommand } from "../../../../src/cli/commands/linksSync";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] links sync CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task9-linkssync-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-linkssync-cli-"));
    homeOverride = path.join(tempDir, "home");
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
    const tables = ["supports", "history", "daemon_write", "note"];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("[smoke] sync replays a pending writeback and returns replayed=1", async () => {
    const sourcePath = path.join(vaultPath, "alpha.md");
    await writeFile(sourcePath, "# Alpha\n\nbody.\n");
    await writeFile(path.join(vaultPath, "beta.md"), "# Beta\n");
    const alpha = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    const beta = await upsertNoteByPath(connection.db, {
      path: "beta.md",
      sha: "sha-beta",
      wordCount: 3,
    });
    // Seed an edge in state 2: approved = true, applied = false.
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.8, agent = 'linker', approved = true, applied = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    expect(created).toBeDefined();

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const exitCode = await runLinksSyncCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
    });
    expect(exitCode).toBe(0);
    const summary = events.find((event) => event.type === "links:sync");
    expect(summary?.replayed).toBe(1);
    expect(summary?.failed).toBe(0);

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: created?.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);
  });

  test("[smoke] sync with no pending rows returns replayed=0", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const exitCode = await runLinksSyncCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
    });
    expect(exitCode).toBe(0);
    const summary = events.find((event) => event.type === "links:sync");
    expect(summary?.replayed).toBe(0);
    expect(summary?.failed).toBe(0);
  });
});
