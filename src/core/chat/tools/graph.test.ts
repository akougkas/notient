import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import {
  type ClusterEntry,
  InMemoryClusterCache,
  makeFindPathTool,
  makeListClustersTool,
} from "./graph";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function insertEdge(
  db: Database,
  id: string,
  source: string,
  target: string,
  approved: number,
): void {
  db.run(
    `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [id, "supports", `note:${source}`, `note:${target}`, 0.9, "linker", null, approved, 1],
  );
}

describe("graph.find_path", () => {
  test("returns the shortest path through approved edges", async () => {
    const db = await newDb();
    insertEdge(db, "e1", "/a.md", "/b.md", 1);
    insertEdge(db, "e2", "/b.md", "/c.md", 1);
    insertEdge(db, "e3", "/c.md", "/d.md", 1);
    insertEdge(db, "e4", "/a.md", "/d.md", 0); // unapproved shortcut must not be used
    const tool = makeFindPathTool(db);
    const result = await tool.invoke(
      { fromNotePath: "/a.md", toNotePath: "/d.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual(["/a.md", "/b.md", "/c.md", "/d.md"]);
    expect(result.hops).toBe(3);
  });

  test("respects the maxHops cap and returns an empty path when unreachable in budget", async () => {
    const db = await newDb();
    insertEdge(db, "e1", "/a.md", "/b.md", 1);
    insertEdge(db, "e2", "/b.md", "/c.md", 1);
    insertEdge(db, "e3", "/c.md", "/d.md", 1);
    const tool = makeFindPathTool(db);
    const result = await tool.invoke(
      { fromNotePath: "/a.md", toNotePath: "/d.md", maxHops: 2 },
      new AbortController().signal,
    );
    expect(result.path).toEqual([]);
    expect(result.hops).toBe(0);
  });

  test("returns an empty path when nodes are disconnected", async () => {
    const db = await newDb();
    insertEdge(db, "e1", "/a.md", "/b.md", 1);
    insertEdge(db, "e2", "/c.md", "/d.md", 1);
    const tool = makeFindPathTool(db);
    const result = await tool.invoke(
      { fromNotePath: "/a.md", toNotePath: "/d.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual([]);
  });

  test("handles same-note query as a 0-hop path", async () => {
    const db = await newDb();
    const tool = makeFindPathTool(db);
    const result = await tool.invoke(
      { fromNotePath: "/a.md", toNotePath: "/a.md" },
      new AbortController().signal,
    );
    expect(result.path).toEqual(["/a.md"]);
    expect(result.hops).toBe(0);
  });

  test("validates inputs", async () => {
    const db = await newDb();
    const tool = makeFindPathTool(db);
    expect(() => tool.validate({ fromNotePath: "/a.md", toNotePath: "" })).toThrow();
    expect(() => tool.validate({ toNotePath: "/b.md" })).toThrow();
    expect(() =>
      tool.validate({ fromNotePath: "/a.md", toNotePath: "/b.md", maxHops: -1 }),
    ).toThrow();
  });

  test("clamps oversized maxHops to the hard cap", async () => {
    const db = await newDb();
    const tool = makeFindPathTool(db);
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

  test("accepts undefined args", async () => {
    const tool = makeListClustersTool(new InMemoryClusterCache());
    const validated = tool.validate(undefined);
    expect(validated).toEqual({});
  });

  test("rejects malformed args", async () => {
    const tool = makeListClustersTool(new InMemoryClusterCache());
    expect(() => tool.validate({ limit: -1 })).toThrow();
    expect(() => tool.validate("nope")).toThrow();
  });
});
