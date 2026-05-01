/**
 * Phase 5 Task 9 graph dump CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/graphDump.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, hand-writes a per-vault
 * state directory under a tempdir-rooted `HOME`, seeds a fixture graph
 * (two notes, a wikilink, a linker proposal), and exercises the three
 * tier filters and three output formats end-to-end.
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
import { makeEmitter } from "../../../../src/cli/output";
import { type DumpedGraph, parseDumpFormat, parseDumpTier, runGraphDumpCommand } from "../../../../src/cli/commands/graphDump";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] graph dump CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task9-graphdump-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-graphdump-cli-"));
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
    const tables = [
      "supports",
      "contradicts",
      "extends",
      "exemplifies",
      "synthesizes",
      "related_to",
      "wikilink",
      "embed",
      "frontmatter_ref",
      "tagged",
      "contained_in",
      "under_heading",
      "mentions",
      "asserts",
      "asks",
      "chunk",
      "block",
      "note",
      "tag",
      "concept",
      "claim",
      "question",
    ];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  async function seedGraph(): Promise<{ alpha: RecordId<"note">; beta: RecordId<"note"> }> {
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
    // Tier 1 deterministic edge.
    await connection.db
      .query(
        "RELATE $from->wikilink->$to SET source = 'wikilink', class = 'EXTRACTED', confidence = 1.0;",
        { from: alpha, to: beta },
      )
      .collect();
    // Tier 3 inferred linker proposal.
    await connection.db
      .query(
        "RELATE $from->supports->$to SET source = 'linker', class = 'INFERRED', confidence = 0.7, agent = 'linker', approved = false;",
        { from: alpha, to: beta },
      )
      .collect();
    return { alpha, beta };
  }

  test("[smoke] tier 1 filter excludes INFERRED edges", async () => {
    await seedGraph();
    const stdoutLines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: temporarily replacing process.stdout.write for capture
    (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      stdoutLines.push(text);
      return true;
    };
    try {
      const exitCode = await runGraphDumpCommand({
        vaultPath,
        tier: 1,
        format: "json",
        emitter: makeEmitter({ mode: "json", write: () => {} }),
      });
      expect(exitCode).toBe(0);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring process.stdout.write after capture
      (process.stdout as any).write = originalWrite;
    }
    const captured = stdoutLines.join("");
    const parsed = JSON.parse(captured) as DumpedGraph;
    expect(parsed.tier).toBe(1);
    // Wikilink stays; supports drops at tier 1.
    const tables = parsed.edges.map((edge) => edge.table).sort();
    expect(tables).toEqual(["wikilink"]);
  });

  test("[smoke] tier 3 includes INFERRED edges and the json round-trip matches DB counts", async () => {
    await seedGraph();
    const outFile = path.join(tempDir, `dump-${Date.now()}.json`);
    const exitCode = await runGraphDumpCommand({
      vaultPath,
      tier: 3,
      format: "json",
      outPath: outFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(exitCode).toBe(0);
    const text = await Bun.file(outFile).text();
    const parsed = JSON.parse(text) as DumpedGraph;
    expect(parsed.tier).toBe(3);
    const tables = parsed.edges.map((edge) => edge.table).sort();
    expect(tables).toEqual(["supports", "wikilink"]);

    const [noteRows] = await connection.db
      .query<[Array<{ id: RecordId }>]>("SELECT id FROM note;")
      .collect<[Array<{ id: RecordId }>]>();
    expect(parsed.nodes.filter((node) => node.table === "note").length).toBe(noteRows.length);
  });

  test("[smoke] graphml format emits one edge element per row", async () => {
    await seedGraph();
    const outFile = path.join(tempDir, `dump-${Date.now()}.graphml`);
    const exitCode = await runGraphDumpCommand({
      vaultPath,
      tier: 3,
      format: "graphml",
      outPath: outFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(exitCode).toBe(0);
    const text = await Bun.file(outFile).text();
    expect(text).toContain("<graphml");
    expect(text).toContain('<graph edgedefault="directed">');
    const edgeMatches = text.match(/<edge /g) ?? [];
    expect(edgeMatches.length).toBe(2);
  });

  test("[smoke] cypher format produces one CREATE per node and edge", async () => {
    await seedGraph();
    const outFile = path.join(tempDir, `dump-${Date.now()}.cypher`);
    const exitCode = await runGraphDumpCommand({
      vaultPath,
      tier: 3,
      format: "cypher",
      outPath: outFile,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
    });
    expect(exitCode).toBe(0);
    const text = await Bun.file(outFile).text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    // 2 notes + 2 edges = 4 CREATE statements.
    expect(lines.length).toBe(4);
    expect(lines.every((line) => line.startsWith("CREATE "))).toBe(true);
  });
});
