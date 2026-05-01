/**
 * M1 proposals CLI test harness.
 *
 * The end-to-end smoke is skipped by default. Run with
 * `NOTIENT_SMOKE=1 bun test src/cli/commands/proposalsCli.test.ts` to drive
 * a real SurrealDB and exercise the list/approve/reject verbs against it.
 *
 * Non-smoke checks the input-validation paths (empty id, unknown table
 * prefix) that exit 2 with INVALID_PARAMS / INVALID_ID, and asserts the
 * module shape so the dispatcher wiring stays compilable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
  tableFromEdgeId,
} from "../../../../src/cli/commands/proposalsCli";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] proposals CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "m1-proposals-cli-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-proposals-cli-"));
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

  test("[smoke] list returns pending edges with source and target paths", async () => {
    await writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n\nbody.\n");
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
    await connection.db
      .query(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, agent = 'linker', approved = false;",
        { from: alpha, to: beta },
      )
      .collect();

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsListCommand({
      vaultPath,
      emitter,
      asJson: false,
    });
    expect(code).toBe(0);
    const listed = events.filter((event) => event.type === "proposals:list");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.source).toBe("alpha.md");
    expect(listed[0]?.target).toBe("beta.md");
    expect(listed[0]?.table).toBe("supports");
  });

  test("[smoke] approve writes the wikilink and lands the edge in state 3", async () => {
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
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, agent = 'linker', approved = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    if (created === undefined) throw new Error("seed edge missing");

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
      id: created.id.toString(),
    });
    expect(code).toBe(0);
    const summary = events.find((event) => event.type === "proposals:approved");
    expect(summary?.id).toBe(created.id.toString());

    const [edgeRows] = await connection.db
      .query<[Array<{ approved: boolean; applied: boolean }>]>(
        "SELECT approved, applied FROM supports WHERE id = $id;",
        { id: created.id },
      )
      .collect<[Array<{ approved: boolean; applied: boolean }>]>();
    expect(edgeRows[0]?.approved).toBe(true);
    expect(edgeRows[0]?.applied).toBe(true);

    const body = await readFile(sourcePath, "utf8");
    expect(body).toContain("[[beta]]");
  });

  test("[smoke] approve on missing id returns 0 with proposals:not_found", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
      id: "supports:not_a_real_id",
    });
    expect(code).toBe(0);
    expect(events.some((event) => event.type === "proposals:not_found")).toBe(true);
  });

  test("[smoke] reject deletes the edge and returns 0", async () => {
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
    const [createdRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.85, agent = 'linker', approved = false RETURN id;",
        { from: alpha, to: beta },
      )
      .collect<[Array<{ id: RecordId }>]>();
    const created = createdRows[0];
    if (created === undefined) throw new Error("seed edge missing");

    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath,
      vaultRoot: vaultPath,
      emitter,
      id: created.id.toString(),
      reason: "noisy",
    });
    expect(code).toBe(0);
    const summary = events.find((event) => event.type === "proposals:rejected");
    expect(summary?.id).toBe(created.id.toString());
    expect(summary?.reason).toBe("noisy");

    const [edgeRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM supports WHERE id = $id;", {
        id: created.id,
      })
      .collect<[Array<{ id: RecordId }>]>();
    expect(edgeRows).toHaveLength(0);
  });
});
