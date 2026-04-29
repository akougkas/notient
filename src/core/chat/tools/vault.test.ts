import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import type { SearchPipeline } from "../../search/searchPipeline";
import type { SearchEvent, SearchHit, SearchQuery } from "../../search/types";
import type { VitalsSnapshot } from "../../vitals/types";
import type { VitalsService } from "../../vitals/vitalsService";
import { ToolValidationError } from "./registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "./vault";

class FakePipeline {
  readonly calls: { query: SearchQuery; signal: AbortSignal }[] = [];
  constructor(private readonly events: SearchEvent[]) {}
  async *run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent> {
    this.calls.push({ query, signal });
    for (const event of this.events) yield event;
  }
}

function asPipeline(fake: FakePipeline): SearchPipeline {
  return fake as unknown as SearchPipeline;
}

class InMemoryFacade implements VaultFacade {
  constructor(private readonly files: Map<string, string>) {}
  async readNote(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`not found: ${path}`);
    return value;
  }
}

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

describe("vault.search_notes", () => {
  test("dispatches to SearchPipeline and returns hits + duration", async () => {
    const hits: SearchHit[] = [
      { notePath: "/a.md", chunkId: "c1", snippet: "hello", score: 0.9, matchedText: "hello" },
    ];
    const fake = new FakePipeline([
      { type: "search:retrieving", mode: "balanced" },
      { type: "search:hits", hits },
      {
        type: "search:done",
        result: { query: "hi", mode: "balanced", hits, durationMs: 42 },
      },
    ]);
    const tool = makeVaultSearchTool(asPipeline(fake));
    const result = await tool.invoke(
      { query: "hi", mode: "balanced", limit: 5 },
      new AbortController().signal,
    );
    expect(result.hits).toEqual(hits);
    expect(result.durationMs).toBe(42);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].query).toEqual({
      query: "hi",
      mode: "balanced",
      limit: 5,
      filters: undefined,
    });
  });

  test("rejects modes other than quick or balanced", async () => {
    const fake = new FakePipeline([]);
    const tool = makeVaultSearchTool(asPipeline(fake));
    expect(() => tool.validate({ query: "x", mode: "deep" })).toThrow();
    expect(() => tool.validate({ query: "", mode: "quick" })).toThrow();
    expect(() => tool.validate({ query: "x" })).toThrow();
  });

  test("propagates pipeline errors", async () => {
    const fake = new FakePipeline([
      { type: "search:retrieving", mode: "quick" },
      { type: "search:error", message: "embed failed" },
    ]);
    const tool = makeVaultSearchTool(asPipeline(fake));
    await expect(
      tool.invoke({ query: "x", mode: "quick" }, new AbortController().signal),
    ).rejects.toThrow(/embed failed/);
  });

  test("forwards the abort signal to the pipeline", async () => {
    const controller = new AbortController();
    const fake = new FakePipeline([
      { type: "search:retrieving", mode: "quick" },
      {
        type: "search:done",
        result: { query: "x", mode: "quick", hits: [], durationMs: 1 },
      },
    ]);
    const tool = makeVaultSearchTool(asPipeline(fake));
    await tool.invoke({ query: "x", mode: "quick" }, controller.signal);
    expect(fake.calls[0].signal).toBe(controller.signal);
  });
});

describe("vault.read_note", () => {
  test("returns full body when no lineRange is provided", async () => {
    const facade = new InMemoryFacade(new Map([["/a.md", "line1\nline2\nline3"]]));
    const tool = makeReadNoteTool(facade);
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result.body).toBe("line1\nline2\nline3");
    expect(result.totalLines).toBe(3);
    expect(result.lineRange).toBeUndefined();
  });

  test("returns the requested 1-based inclusive lineRange", async () => {
    const facade = new InMemoryFacade(new Map([["/a.md", "a\nb\nc\nd"]]));
    const tool = makeReadNoteTool(facade);
    const result = await tool.invoke(
      { notePath: "/a.md", lineRange: { start: 2, end: 3 } },
      new AbortController().signal,
    );
    expect(result.body).toBe("b\nc");
    expect(result.lineRange).toEqual({ start: 2, end: 3 });
    expect(result.totalLines).toBe(4);
  });

  test("rejects invalid lineRange", async () => {
    const facade = new InMemoryFacade(new Map());
    const tool = makeReadNoteTool(facade);
    expect(() => tool.validate({ notePath: "/a.md", lineRange: { start: 0, end: 2 } })).toThrow();
    expect(() => tool.validate({ notePath: "/a.md", lineRange: { start: 5, end: 2 } })).toThrow();
    expect(() => tool.validate({ notePath: "/a.md", lineRange: "nope" })).toThrow();
  });
});

describe("vault.list_neighbors", () => {
  test("returns approved-edge neighbors with direction", async () => {
    const db = await newDb();
    db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      ["e1", "supports", "note:/a.md", "note:/b.md", 0.9, "linker", null, 1, 1],
    );
    db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      ["e2", "extends", "note:/c.md", "note:/a.md", 0.8, "linker", null, 1, 2],
    );
    db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      ["e3", "contradicts", "note:/a.md", "note:/d.md", 0.7, "linker", null, 0, 3],
    );
    const tool = makeListNeighborsTool(db);
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    const sorted = result.neighbors.sort((x, y) => x.notePath.localeCompare(y.notePath));
    expect(sorted).toEqual([
      {
        notePath: "/b.md",
        type: "supports",
        agent: "linker",
        confidence: 0.9,
        direction: "outgoing",
      },
      {
        notePath: "/c.md",
        type: "extends",
        agent: "linker",
        confidence: 0.8,
        direction: "incoming",
      },
    ]);
  });

  test("rejects an empty notePath", async () => {
    const db = await newDb();
    const tool = makeListNeighborsTool(db);
    expect(() => tool.validate({ notePath: "" })).toThrow();
  });
});

describe("vault.get_vitals", () => {
  test("returns the computed snapshot from VitalsService", async () => {
    const snapshot: VitalsSnapshot = {
      notePath: "/a.md",
      freshness: 0.5,
      health: 0.6,
      connectivityCount: 2,
      connectivityTier: "sparse",
      maturity: "draft",
      wordCount: 200,
      computedAt: 100,
    };
    const calls: string[] = [];
    const fake: VitalsService = {
      async computeSnapshot(path: string): Promise<VitalsSnapshot | null> {
        calls.push(path);
        return snapshot;
      },
    } as unknown as VitalsService;
    const tool = makeGetVitalsTool(fake);
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result.snapshot).toEqual(snapshot);
    expect(calls).toEqual(["/a.md"]);
  });

  test("returns null snapshot when the note is unindexed", async () => {
    const fake: VitalsService = {
      async computeSnapshot(): Promise<VitalsSnapshot | null> {
        return null;
      },
    } as unknown as VitalsService;
    const tool = makeGetVitalsTool(fake);
    const result = await tool.invoke({ notePath: "/missing.md" }, new AbortController().signal);
    expect(result.snapshot).toBeNull();
  });
});

describe("vault tool registry integration", () => {
  test("ToolValidationError surfaces the failing tool name through registry.invoke", async () => {
    const { ToolRegistry } = await import("./registry");
    const facade = new InMemoryFacade(new Map());
    const registry = new ToolRegistry();
    registry.register(makeReadNoteTool(facade));
    let captured: unknown;
    try {
      await registry.invoke("vault.read_note", { notePath: "" }, new AbortController().signal);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ToolValidationError);
    expect((captured as ToolValidationError).toolName).toBe("vault.read_note");
  });
});
