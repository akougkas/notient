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
import { type SurrealServerHandle, startSurreal } from "../../../daemon/surrealServer";
import { applySchema } from "../../db/schemaApplier";
import { type SurrealConnection, connect, relateEdge, upsertNoteByPath } from "../../db/surreal";
import {
  type ClusterEntry,
  InMemoryClusterCache,
  makeFindPathTool,
  makeListClustersTool,
} from "./graph";

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

describe("graph.find_path validation", () => {
  test("validates inputs", () => {
    // The validator is pure and does not need a live SurrealDB.
    const fakeDb = {} as Parameters<typeof makeFindPathTool>[0];
    const tool = makeFindPathTool(fakeDb);
    expect(() => tool.validate({ fromNotePath: "/a.md", toNotePath: "" })).toThrow();
    expect(() => tool.validate({ toNotePath: "/b.md" })).toThrow();
    expect(() =>
      tool.validate({ fromNotePath: "/a.md", toNotePath: "/b.md", maxHops: -1 }),
    ).toThrow();
  });

  test("clamps oversized maxHops to the hard cap", () => {
    const fakeDb = {} as Parameters<typeof makeFindPathTool>[0];
    const tool = makeFindPathTool(fakeDb);
    const validated = tool.validate({ fromNotePath: "/a.md", toNotePath: "/b.md", maxHops: 999 });
    expect(validated.maxHops).toBe(8);
  });
});

describe("graph.list_clusters", () => {
  test("returns clusters from the cache", async () => {
    const cache = new InMemoryClusterCache();
    const entries: ClusterEntry[] = [
      { id: "c1", label: "POSIX limits", memberPaths: ["/a.md", "/b.md"], source: "synthesizer" },
      { id: "c2", label: "Storage tiers", memberPaths: ["/c.md", "/d.md"] },
    ];
    cache.set(entries);
    const tool = makeListClustersTool(cache);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.clusters).toEqual(entries);
  });

  test("returns an empty list when no cache is wired", async () => {
    const tool = makeListClustersTool(null);
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.clusters).toEqual([]);
  });

  test("respects the optional limit", async () => {
    const cache = new InMemoryClusterCache();
    cache.set([
      { id: "c1", label: "x", memberPaths: ["/a.md"] },
      { id: "c2", label: "y", memberPaths: ["/b.md"] },
      { id: "c3", label: "z", memberPaths: ["/c.md"] },
    ]);
    const tool = makeListClustersTool(cache);
    const result = await tool.invoke({ limit: 2 }, new AbortController().signal);
    expect(result.clusters.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("accepts undefined args", () => {
    const tool = makeListClustersTool(new InMemoryClusterCache());
    const validated = tool.validate(undefined);
    expect(validated).toEqual({});
  });

  test("rejects malformed args", () => {
    const tool = makeListClustersTool(new InMemoryClusterCache());
    expect(() => tool.validate({ limit: -1 })).toThrow();
    expect(() => tool.validate("nope")).toThrow();
  });
});
