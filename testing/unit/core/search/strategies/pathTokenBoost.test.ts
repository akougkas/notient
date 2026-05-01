import { describe, expect, test } from "bun:test";
import {
  applyPathTokenBoost,
  computePathTokenBoost,
  tokenizeNotePath,
  tokenizeQuery,
} from "../../../../../src/core/search/strategies/pathTokenBoost";
import type { SearchHit } from "../../../../../src/core/search/types";

describe("tokenizeQuery", () => {
  test("lowercases and splits on non-word", () => {
    expect(tokenizeQuery("Vector search")).toEqual(["vector", "search"]);
    expect(tokenizeQuery("BM25 vs. vector")).toEqual(["bm25", "vs", "vector"]);
  });
  test("returns [] for empty/whitespace", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });
});

describe("tokenizeNotePath", () => {
  test("strips numeric prefix and extension", () => {
    expect(tokenizeNotePath("0002-vector-search.md")).toEqual(["vector", "search"]);
    expect(tokenizeNotePath("0030-fan-vector-search.md")).toEqual(["fan", "vector", "search"]);
    expect(tokenizeNotePath("notes/2025_01-graph-traversal.md")).toEqual(["graph", "traversal"]);
  });
  test("handles no-prefix paths", () => {
    expect(tokenizeNotePath("vector-search.md")).toEqual(["vector", "search"]);
    expect(tokenizeNotePath("README.md")).toEqual(["readme"]);
  });
});

describe("computePathTokenBoost", () => {
  test("perfect match earns full bonus (~0.30)", () => {
    expect(computePathTokenBoost(["vector", "search"], ["vector", "search"])).toBeCloseTo(0.3, 5);
  });
  test("partial match earns much smaller bonus (cubic falloff)", () => {
    const fullPath = computePathTokenBoost(["vector", "search"], ["vector", "search"]);
    const partial = computePathTokenBoost(["vector", "search"], ["fan", "vector", "search"]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(fullPath / 2);
  });
  test("no overlap returns 0", () => {
    expect(computePathTokenBoost(["vector", "search"], ["graph", "traversal"])).toBe(0);
  });
  test("empty inputs return 0", () => {
    expect(computePathTokenBoost([], ["vector"])).toBe(0);
    expect(computePathTokenBoost(["vector"], [])).toBe(0);
  });
});

describe("applyPathTokenBoost", () => {
  function hit(path: string, score: number): SearchHit {
    return { notePath: path, chunkId: `c-${path}`, snippet: "", score, matchedText: "" };
  }

  test("promotes the canonical concept note over fillers", () => {
    const hits: SearchHit[] = [
      hit("0090-filler-vector-search.md", 0.53),
      hit("0080-filler-vector-search.md", 0.53),
      hit("0030-fan-vector-search.md", 0.48),
      hit("0002-vector-search.md", 0.45),
    ];
    const boosted = applyPathTokenBoost(hits, "vector search");
    expect(boosted[0].notePath).toBe("0002-vector-search.md");
  });

  test("does not alter ordering when no path tokens match", () => {
    const hits: SearchHit[] = [hit("0001-foo.md", 0.6), hit("0002-bar.md", 0.5)];
    const boosted = applyPathTokenBoost(hits, "completely unrelated query");
    expect(boosted.map((h) => h.notePath)).toEqual(["0001-foo.md", "0002-bar.md"]);
  });

  test("returns a new array (no mutation)", () => {
    const hits: SearchHit[] = [hit("a.md", 0.1)];
    const boosted = applyPathTokenBoost(hits, "anything");
    expect(boosted).not.toBe(hits);
    expect(hits[0].score).toBe(0.1);
  });

  test("empty query bypasses boost", () => {
    const hits: SearchHit[] = [hit("0001-foo.md", 0.5), hit("0002-bar.md", 0.6)];
    const boosted = applyPathTokenBoost(hits, "");
    expect(boosted.map((h) => h.score)).toEqual([0.5, 0.6]);
  });
});
