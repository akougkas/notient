/**
 * Phase 5 Task 9 graph stats CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/graphStats.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { makeEmitter } from "../output";
import { runGraphStatsCommand } from "./graphStats";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] graph stats CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task9-graphstats-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-graphstats-cli-"));
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
    const tables = ["wikilink", "supports", "note", "tag", "concept", "claim", "question"];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("[smoke] empty vault emits a row per entity and edge table with count 0", async () => {
    const lines: string[] = [];
    const exitCode = await runGraphStatsCommand({
      vaultPath,
      asJson: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as Array<{
      table: string;
      source: string;
      count: number;
    }>;
    // Seven entity tables + fifteen edge tables, each emitting at least one
    // row in the empty case.
    const tables = new Set(parsed.map((row) => row.table));
    expect(tables.has("note")).toBe(true);
    expect(tables.has("wikilink")).toBe(true);
    expect(tables.has("supports")).toBe(true);
    expect(parsed.every((row) => row.count === 0)).toBe(true);
  });

  test("[smoke] populated vault reports per-source counts", async () => {
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
        "RELATE $from->wikilink->$to SET source = 'wikilink', class = 'EXTRACTED', confidence = 1.0;",
        { from: alpha, to: beta },
      )
      .collect();
    await connection.db
      .query(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.7, agent = 'linker', approved = false;",
        { from: alpha, to: beta },
      )
      .collect();

    const lines: string[] = [];
    const exitCode = await runGraphStatsCommand({
      vaultPath,
      asJson: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as Array<{
      table: string;
      source: string;
      count: number;
    }>;
    const noteRow = parsed.find((row) => row.table === "note");
    expect(noteRow?.count).toBe(2);
    const wikilinkRow = parsed.find((row) => row.table === "wikilink" && row.source === "wikilink");
    expect(wikilinkRow?.count).toBe(1);
    const supportsRow = parsed.find((row) => row.table === "supports" && row.source === "linker");
    expect(supportsRow?.count).toBe(1);
  });

  test("[smoke] default fixed-width text output includes a header row", async () => {
    const lines: string[] = [];
    const exitCode = await runGraphStatsCommand({
      vaultPath,
      asJson: false,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/table\s*\|\s*source\s*\|\s*count/);
    expect(lines[1]).toMatch(/^-+\+-+\+-+$/);
    expect(lines.length).toBeGreaterThan(2);
  });
});

describe("graph stats module shape", () => {
  test("module exports the run function", () => {
    expect(typeof runGraphStatsCommand).toBe("function");
  });
});
