import { contentRevision } from "../../../../../src/api/notes";
import { GraphService } from "../../../../../src/core/graph/graphService";
import { STRUCTURAL_INDEX_VERSION } from "../../../../../src/core/markdown/types";
/**
 * Phase 5 Task 7 graph chat-tool smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/chat/tools/`.
 *
 * `graph.find_path` walks the SurrealDB writeback edge tables plus the
 * deterministic `wikilink` relation, filtered by `approved = true AND
 * applied = true`. The smoke seeds wikilink edges so the BFS exercises a
 * realistic Tier-1 graph.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeFindPathTool } from "../../../../../src/core/chat/tools/graph";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const TEST_CONTEXT = { clientIdentity: "human" } as const;

async function seedWikilink(
  connection: SurrealConnection,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const fromId = await upsertNoteByPath(connection.db, {
    path: fromPath,
    sha: contentRevision(fromPath),
    wordCount: 10,
  });
  const toId = await upsertNoteByPath(connection.db, {
    path: toPath,
    sha: contentRevision(toPath),
    wordCount: 10,
  });
  await connection.db
    .query("UPDATE note SET tier1_at = time::now(), structural_version = $version;", {
      version: STRUCTURAL_INDEX_VERSION,
    })
    .collect();
  await relateEdge(connection.db, {
    table: "wikilink",
    from: fromId,
    to: toId,
    source: "wikilink",
    confidenceClass: "EXTRACTED",
    confidence: 1.0,
    agent: "extractor",
    approved: true,
  });
}

async function clearVault(connection: SurrealConnection): Promise<void> {
  for (const table of [
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
    "wikilink",
    "note",
  ]) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] graph.find_path", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-graph-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-graph-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
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
  }, 30_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  afterEach(async () => {
    await clearVault(connection);
  });

  test("returns the shortest path through approved edges", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "b.md", "c.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(
      new GraphService({ db: connection.db, vault: { readBounded: async (path) => path } }),
    );
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.path.map((note) => note.path)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(result.steps.length).toBe(3);
  });

  test("respects the maxHops cap", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "b.md", "c.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(
      new GraphService({ db: connection.db, vault: { readBounded: async (path) => path } }),
    );
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md", maxHops: 2 },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.path.map((note) => note.path)).toEqual([]);
    expect(result.steps.length).toBe(0);
  });

  test("returns empty path when nodes are disconnected", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(
      new GraphService({ db: connection.db, vault: { readBounded: async (path) => path } }),
    );
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.path.map((note) => note.path)).toEqual([]);
  });

  test("handles same-note query as a 0-hop path", async () => {
    await upsertNoteByPath(connection.db, {
      path: "a.md",
      sha: contentRevision("a.md"),
      wordCount: 10,
    });
    const tool = makeFindPathTool(
      new GraphService({ db: connection.db, vault: { readBounded: async (path) => path } }),
    );
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "a.md" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.path.map((note) => note.path)).toEqual(["a.md"]);
    expect(result.steps.length).toBe(0);
  });
});
