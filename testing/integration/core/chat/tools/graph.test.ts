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
 *
 * `graph.list_clusters` is a pure in-memory cache reader; its tests are
 * unit-style and run unconditionally.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ClusterEntry,
  InMemoryClusterCache,
  makeFindPathTool,
  makeListClustersTool,
} from "../../../../../src/core/chat/tools/graph";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function seedWikilink(
  connection: SurrealConnection,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const fromId = await upsertNoteByPath(connection.db, {
    path: fromPath,
    sha: `sha-${fromPath}`,
    wordCount: 10,
  });
  const toId = await upsertNoteByPath(connection.db, {
    path: toPath,
    sha: `sha-${toPath}`,
    wordCount: 10,
  });
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
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

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
  });

  afterEach(async () => {
    await clearVault(connection);
  });

  test("returns the shortest path through approved edges", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "b.md", "c.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(connection.db);
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(result.hops).toBe(3);
  });

  test("respects the maxHops cap", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "b.md", "c.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(connection.db);
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md", maxHops: 2 },
      new AbortController().signal,
    );
    expect(result.path).toEqual([]);
    expect(result.hops).toBe(0);
  });

  test("returns empty path when nodes are disconnected", async () => {
    await seedWikilink(connection, "a.md", "b.md");
    await seedWikilink(connection, "c.md", "d.md");
    const tool = makeFindPathTool(connection.db);
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "d.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual([]);
  });

  test("handles same-note query as a 0-hop path", async () => {
    const tool = makeFindPathTool(connection.db);
    const result = await tool.invoke(
      { fromNotePath: "a.md", toNotePath: "a.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual(["a.md"]);
    expect(result.hops).toBe(0);
  });
});
