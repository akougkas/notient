import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HnswVectorIndex } from "./hnswVectorIndex";
import { InMemoryVectorIndex } from "./vectorIndex";

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

/**
 * Builds a deterministic 768-dim vector whose signal is concentrated in a
 * dedicated stripe. Each id `i` (0..9) gets unit weights at positions
 * `[i * 76, i * 76 + 76)` and zeros elsewhere, so cosine similarity is
 * maximised when querying with the same id's vector.
 */
function stripeVector(index: number): Float32Array {
  const dim = 768;
  const stripe = 76;
  const values = new Float32Array(dim);
  const start = index * stripe;
  for (let position = start; position < start + stripe && position < dim; position++) {
    values[position] = 1;
  }
  return values;
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

describe("HnswVectorIndex (smoke)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notient-hnsw-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("init + addPoint + searchKnn returns the expected id at top-1", async () => {
    const index = new HnswVectorIndex({ maxElements: 32 });
    await index.init(768);
    for (let i = 0; i < 10; i++) {
      index.add(`id-${i}`, stripeVector(i));
    }
    expect(index.size()).toBe(10);

    const results = index.search(stripeVector(3), 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe("id-3");
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  test("persist to disk + load into fresh instance preserves search", async () => {
    const original = new HnswVectorIndex({ maxElements: 32 });
    await original.init(768);
    for (let i = 0; i < 10; i++) {
      original.add(`id-${i}`, stripeVector(i));
    }

    const blob = await original.persist();
    const path = join(tempDir, "index.bin");
    writeFileSync(path, new Uint8Array(blob));

    const onDisk = readFileSync(path);
    const reopened = new HnswVectorIndex({ maxElements: 32 });
    await reopened.load(
      onDisk.buffer.slice(onDisk.byteOffset, onDisk.byteOffset + onDisk.byteLength),
    );

    expect(reopened.size()).toBe(10);
    const results = reopened.search(stripeVector(3), 3);
    expect(results[0].id).toBe("id-3");
  });

  test("remove drops the vector from future search results", async () => {
    const index = new HnswVectorIndex({ maxElements: 32 });
    await index.init(768);
    for (let i = 0; i < 10; i++) {
      index.add(`id-${i}`, stripeVector(i));
    }

    index.remove("id-3");
    expect(index.size()).toBe(9);

    const results = index.search(stripeVector(3), 9);
    for (const result of results) {
      expect(result.id).not.toBe("id-3");
    }
  });

  test("re-adding an id replaces its vector in subsequent searches", async () => {
    const index = new HnswVectorIndex({ maxElements: 32 });
    await index.init(768);
    for (let i = 0; i < 10; i++) {
      index.add(`id-${i}`, stripeVector(i));
    }

    // Move id-5 onto the stripe previously owned by id-7. The nearest
    // neighbour of stripeVector(7) should now return id-5 alongside id-7.
    index.add("id-5", stripeVector(7));

    const results = index.search(stripeVector(7), 2);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("id-5");
    expect(ids).toContain("id-7");
  });
});
