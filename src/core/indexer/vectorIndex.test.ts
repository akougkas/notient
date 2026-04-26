import { describe, expect, test } from "bun:test";
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
