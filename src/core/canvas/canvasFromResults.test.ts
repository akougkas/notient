import { describe, expect, test } from "bun:test";
import type { SearchHit, SearchResult } from "../search/types";
import {
  CanvasFromResults,
  type CanvasFromResultsFacade,
  buildCanvas,
  makeSlug,
} from "./canvasFromResults";

class InMemoryFacade implements CanvasFromResultsFacade {
  readonly folders: string[] = [];
  readonly files = new Map<string, string>();

  async ensureFolder(path: string): Promise<void> {
    this.folders.push(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function hit(notePath: string): SearchHit {
  return { notePath, chunkId: null, snippet: notePath, score: 1, matchedText: notePath };
}

function makeResult(query: string, paths: string[]): SearchResult {
  return {
    query,
    mode: "balanced",
    hits: paths.map(hit),
    durationMs: 5,
    synthesis: null,
  };
}

describe("CanvasFromResults", () => {
  test("writes a canvas under <folder>/canvases with a slugged filename", async () => {
    const facade = new InMemoryFacade();
    const exporter = new CanvasFromResults({
      facade,
      folder: "Notient/searches",
      now: () => 1_700_000_000,
    });

    const result = makeResult("Career Arc 2026!", ["a.md", "b.md", "c.md"]);
    const exported = await exporter.export(result);

    expect(exported.path).toBe("Notient/searches/canvases/career-arc-2026-1700000000.canvas");
    expect(facade.folders).toContain("Notient/searches/canvases");
    const written = facade.files.get(exported.path);
    expect(written).toBeDefined();

    const parsed = JSON.parse(written ?? "{}") as { nodes: unknown[]; edges: unknown[] };
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.edges).toHaveLength(3);
  });

  test("buildCanvas connects the query node to every hit", () => {
    const result = makeResult("links", ["x.md", "y.md"]);
    const canvas = buildCanvas(result);
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.edges).toHaveLength(2);
    for (const edge of canvas.edges) {
      expect(edge.fromNode).toBe("query");
    }
    const fileNodes = canvas.nodes.filter((node) => node.type === "file");
    expect(fileNodes.map((node) => (node.type === "file" ? node.file : null))).toEqual([
      "x.md",
      "y.md",
    ]);
  });

  test("makeSlug falls back to 'search' for non-alphanumeric queries", () => {
    expect(makeSlug("???")).toBe("search");
    expect(makeSlug("")).toBe("search");
    expect(makeSlug("Hello, World!")).toBe("hello-world");
    expect(makeSlug("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});
