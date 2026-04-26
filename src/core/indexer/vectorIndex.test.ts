import { describe, expect, test } from "bun:test";
import { HnswVectorIndex } from "./hnswVectorIndex";
import { InMemoryVectorIndex } from "./vectorIndex";

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("InMemoryVectorIndex", () => {
  test("init sets dim and starts empty", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(4);
    expect(idx.size()).toBe(0);
  });

  test("add stores vectors and search returns nearest by cosine", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    idx.add("a", vec([1, 0, 0]));
    idx.add("b", vec([0, 1, 0]));
    idx.add("c", vec([0.9, 0.1, 0]));
    const results = idx.search(vec([1, 0, 0]), 2);
    expect(results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("search throws when k is non-positive", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    expect(() => idx.search(vec([1, 0, 0]), 0)).toThrow();
  });

  test("add throws when vector dim mismatches", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    expect(() => idx.add("x", vec([1, 0]))).toThrow(/dim/);
  });

  test("remove deletes by id", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    idx.add("a", vec([1, 0, 0]));
    idx.add("b", vec([0, 1, 0]));
    idx.remove("a");
    expect(idx.size()).toBe(1);
    expect(idx.search(vec([1, 0, 0]), 1).map((r) => r.id)).toEqual(["b"]);
  });

  test("persist + load round-trips through ArrayBuffer", async () => {
    const a = new InMemoryVectorIndex();
    await a.init(2);
    a.add("x", vec([1, 0]));
    a.add("y", vec([0, 1]));
    const blob = await a.persist();

    const b = new InMemoryVectorIndex();
    await b.load(blob);
    expect(b.size()).toBe(2);
    expect(b.search(vec([1, 0]), 1).map((r) => r.id)).toEqual(["x"]);
  });
});

// TODO(phase-2.5): hnswlib-wasm 0.8.2 is browser-only (the wasm bundle requires
// `window` or `importScripts`), so it cannot load under Bun's test runtime. The
// VectorIndex interface contract is fully covered by InMemoryVectorIndex tests
// above; HnswVectorIndex is validated at runtime inside the Obsidian plugin.
describe.skip("HnswVectorIndex (smoke)", () => {
  test("initializes, indexes 50 vectors, returns nearest neighbor", async () => {
    const idx = new HnswVectorIndex({ maxElements: 100 });
    await idx.init(8);
    for (let i = 0; i < 50; i++) {
      const v = Float32Array.from(Array.from({ length: 8 }, (_, k) => (k === i % 8 ? 1 : 0)));
      idx.add(`id-${i}`, v);
    }
    const target = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
    const results = idx.search(target, 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe("id-0");
  });

  test("persist/load round-trip preserves search", async () => {
    const a = new HnswVectorIndex({ maxElements: 10 });
    await a.init(4);
    a.add("p", Float32Array.from([1, 0, 0, 0]));
    a.add("q", Float32Array.from([0, 1, 0, 0]));
    const blob = await a.persist();

    const b = new HnswVectorIndex({ maxElements: 10 });
    await b.load(blob);
    const results = b.search(Float32Array.from([1, 0, 0, 0]), 1);
    expect(results[0].id).toBe("p");
  });
});
