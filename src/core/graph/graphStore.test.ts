import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type DatabaseAdapter } from "../db/database";
import { GraphStore } from "./graphStore";

class MemAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(init: Record<string, ArrayBuffer>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async readBinary(p: string) {
    return this.files.get(p) ?? null;
  }
  async writeBinary(p: string, d: ArrayBuffer) {
    this.files.set(p, d);
  }
}

function wasm(): ArrayBuffer {
  const buf = readFileSync(
    resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm"),
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

let db: Database;
let store: GraphStore;
beforeEach(async () => {
  db = new Database(new MemAdapter({ "/w": wasm() }), { dbPath: "/d", wasmPath: "/w" });
  await db.init();
  store = new GraphStore(db);
});

describe("GraphStore", () => {
  test("insert and retrieve concept node", () => {
    store.upsertNode({
      id: "concept:hpc",
      type: "concept",
      label: "HPC",
      notePath: null,
      payload: { domain: "computing" },
      createdAt: 1,
    });
    const nodes = store.nodesByType("concept");
    expect(nodes.length).toBe(1);
    expect(nodes[0].label).toBe("HPC");
    expect(nodes[0].payload).toEqual({ domain: "computing" });
  });

  test("upsert merges payload", () => {
    store.upsertNode({
      id: "c",
      type: "concept",
      label: "X",
      notePath: null,
      payload: null,
      createdAt: 1,
    });
    store.upsertNode({
      id: "c",
      type: "concept",
      label: "Y",
      notePath: null,
      payload: { v: 2 },
      createdAt: 2,
    });
    const nodes = store.nodesByType("concept");
    expect(nodes[0].label).toBe("Y");
    expect(nodes[0].payload).toEqual({ v: 2 });
  });

  test("edges can be inserted and queried by source/target", () => {
    store.insertEdge({
      id: "e1",
      type: "supports",
      sourceId: "a",
      targetId: "b",
      confidence: 0.8,
      agent: "linker",
      evidence: ["chunk-1"],
      approved: false,
      createdAt: 1,
    });
    const edges = store.edgesFor("a");
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("supports");
    expect(edges[0].evidence).toEqual(["chunk-1"]);
    expect(edges[0].approved).toBe(false);
  });

  test("insertEdge is idempotent on duplicate id", () => {
    store.insertEdge({
      id: "edge:duplicate",
      type: "mentions",
      sourceId: "note:foo.md",
      targetId: "concept:bar",
      confidence: 1,
      agent: "extractor",
      evidence: [],
      approved: true,
      createdAt: 1,
    });
    store.insertEdge({
      id: "edge:duplicate",
      type: "mentions",
      sourceId: "note:foo.md",
      targetId: "concept:bar",
      confidence: 1,
      agent: "extractor",
      evidence: [],
      approved: true,
      createdAt: 1,
    });
    const edges = store.edgesFor("note:foo.md");
    expect(edges.length).toBe(1);
  });

  test("approveEdge flips the flag and edgesByType filters", () => {
    store.insertEdge({
      id: "e1",
      type: "contradicts",
      sourceId: "a",
      targetId: "b",
      confidence: 0.7,
      agent: "hunter",
      evidence: [],
      approved: false,
      createdAt: 1,
    });
    expect(store.edgesByType("contradicts", true).length).toBe(0);
    store.approveEdge("e1");
    expect(store.edgesByType("contradicts", true).length).toBe(1);
  });
});
