/**
 * Vault chat-tool tests.
 *
 * `vault.search_notes`, `vault.read_note`, `vault.get_vitals`, and the
 * registry integration test are pure (no database). The
 * `vault.list_neighbors` tool reads the SurrealDB substrate and lives
 * behind the smoke harness, run with `bun run test:smoke`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolValidationError } from "../../../../../src/core/chat/tools/registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "../../../../../src/core/chat/tools/vault";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import type { SearchPipeline } from "../../../../../src/core/search/searchPipeline";
import type { SearchEvent, SearchHit, SearchQuery } from "../../../../../src/core/search/types";
import type { VitalsSnapshot } from "../../../../../src/core/vitals/types";
import type { VitalsService } from "../../../../../src/core/vitals/vitalsService";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

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
  async readNote(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw new Error(`not found: ${filePath}`);
    return value;
  }
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

describe("vault.list_neighbors validation", () => {
  test("rejects an empty notePath", () => {
    const fakeDb = {} as Parameters<typeof makeListNeighborsTool>[0];
    const tool = makeListNeighborsTool(fakeDb);
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
      async computeSnapshot(filePath: string): Promise<VitalsSnapshot | null> {
        calls.push(filePath);
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
    const { ToolRegistry } = await import("../../../../../src/core/chat/tools/registry");
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
