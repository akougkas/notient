import { describe, expect, test } from "bun:test";
import { dbscanCosine } from "./dbscan";

function vec(x: number, y: number): Float32Array {
  return Float32Array.from([x, y]);
}

describe("dbscanCosine", () => {
  test("clusters near-identical vectors and isolates outliers", () => {
    const points = [
      { id: "a", v: vec(1, 0) },
      { id: "b", v: vec(0.99, 0.01) },
      { id: "c", v: vec(0.98, 0.02) },
      { id: "d", v: vec(0, 1) },
      { id: "e", v: vec(0.01, 0.99) },
      { id: "f", v: vec(-1, -1) },
    ];
    const clusters = dbscanCosine(points, { epsilon: 0.05, minPoints: 2 });
    expect(clusters.length).toBe(2);
    const ids = clusters.map((c) => c.map((p) => p.id).sort()).sort();
    expect(ids).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  test("returns no clusters when minPoints not met", () => {
    const points = [
      { id: "a", v: vec(1, 0) },
      { id: "b", v: vec(0, 1) },
    ];
    expect(dbscanCosine(points, { epsilon: 0.1, minPoints: 3 })).toEqual([]);
  });
});
