import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { expandViaApprovedEdges } from "./graphExpansion";
import type { SearchHit } from "./types";

async function setupDatabase(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function insertEdge(
  db: Database,
  options: {
    id: string;
    sourcePath: string;
    targetPath: string;
    type?: string;
    agent?: string;
    approved?: number;
  },
): void {
  db.run(
    `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [
      options.id,
      options.type ?? "related",
      `note:${options.sourcePath}`,
      `note:${options.targetPath}`,
      0.9,
      options.agent ?? "linker",
      "[]",
      options.approved ?? 1,
      1,
    ],
  );
}

function makeHit(notePath: string): SearchHit {
  return {
    notePath,
    chunkId: `chunk-${notePath}`,
    snippet: `snippet for ${notePath}`,
    score: 1,
    matchedText: "x",
  };
}

describe("expandViaApprovedEdges", () => {
  test("depth=0 returns no expansion regardless of edges present", async () => {
    const db = await setupDatabase();
    insertEdge(db, { id: "edge-1", sourcePath: "/a.md", targetPath: "/b.md" });
    const expanded = expandViaApprovedEdges({
      db,
      baseHits: [makeHit("/a.md")],
      depth: 0,
    });
    expect(expanded).toEqual([]);
  });

  test("returns empty list when there are no base hits", async () => {
    const db = await setupDatabase();
    insertEdge(db, { id: "edge-1", sourcePath: "/a.md", targetPath: "/b.md" });
    const expanded = expandViaApprovedEdges({ db, baseHits: [], depth: 1 });
    expect(expanded).toEqual([]);
  });

  test("adds approved-edge neighbours of base hits at depth=1", async () => {
    const db = await setupDatabase();
    insertEdge(db, {
      id: "edge-1",
      sourcePath: "/a.md",
      targetPath: "/b.md",
      type: "supports",
      agent: "linker",
    });
    insertEdge(db, { id: "edge-2", sourcePath: "/c.md", targetPath: "/a.md" });
    const expanded = expandViaApprovedEdges({
      db,
      baseHits: [makeHit("/a.md")],
      depth: 1,
    });
    const paths = expanded.map((hit) => hit.notePath).sort();
    expect(paths).toEqual(["/b.md", "/c.md"]);
    const linkToB = expanded.find((hit) => hit.notePath === "/b.md");
    expect(linkToB?.viaPath).toBe("/a.md");
    expect(linkToB?.snippet).toContain("supports");
    expect(linkToB?.snippet).toContain("agent: linker");
    expect(linkToB?.chunkId).toBeNull();
  });

  test("ignores edges that are not approved", async () => {
    const db = await setupDatabase();
    insertEdge(db, {
      id: "edge-pending",
      sourcePath: "/a.md",
      targetPath: "/b.md",
      approved: 0,
    });
    const expanded = expandViaApprovedEdges({
      db,
      baseHits: [makeHit("/a.md")],
      depth: 1,
    });
    expect(expanded).toEqual([]);
  });

  test("deduplicates expansion against the base notePath set", async () => {
    const db = await setupDatabase();
    insertEdge(db, { id: "edge-1", sourcePath: "/a.md", targetPath: "/b.md" });
    const expanded = expandViaApprovedEdges({
      db,
      baseHits: [makeHit("/a.md"), makeHit("/b.md")],
      depth: 1,
    });
    expect(expanded).toEqual([]);
  });

  test("collapses parallel edges to the same neighbour", async () => {
    const db = await setupDatabase();
    insertEdge(db, { id: "edge-1", sourcePath: "/a.md", targetPath: "/b.md" });
    insertEdge(db, {
      id: "edge-2",
      sourcePath: "/a.md",
      targetPath: "/b.md",
      type: "contradicts",
    });
    const expanded = expandViaApprovedEdges({
      db,
      baseHits: [makeHit("/a.md")],
      depth: 1,
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0].notePath).toBe("/b.md");
  });
});
