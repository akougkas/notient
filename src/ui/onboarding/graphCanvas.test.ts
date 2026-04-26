import { describe, expect, test } from "bun:test";
import { type CanvasNode, GraphCanvasModel, spiralPosition } from "./graphCanvas";

describe("spiralPosition", () => {
  test("returns deterministic coords for same seed", () => {
    expect(spiralPosition(0, 720, 420)).toEqual(spiralPosition(0, 720, 420));
    expect(spiralPosition(42, 720, 420)).toEqual(spiralPosition(42, 720, 420));
  });

  test("places points within the canvas bounds", () => {
    for (let i = 0; i < 200; i++) {
      const { x, y } = spiralPosition(i, 720, 420);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(720);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(420);
    }
  });
});

describe("GraphCanvasModel", () => {
  test("addNode assigns coords and stores by id", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "n1", type: "note", label: "n1" });
    const node = model.getNode("n1") as CanvasNode;
    expect(node).toBeDefined();
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
  });

  test("addEdge stores edge only when both endpoints exist", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "a", type: "note", label: "a" });
    model.addEdge({ id: "e1", sourceId: "a", targetId: "missing", type: "mentions" });
    expect(model.edgeCount()).toBe(0);
    model.addNode({ id: "missing", type: "concept", label: "x" });
    model.addEdge({ id: "e2", sourceId: "a", targetId: "missing", type: "mentions" });
    expect(model.edgeCount()).toBe(1);
  });

  test("counts() returns per-type tallies", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "n1", type: "note", label: "n1" });
    model.addNode({ id: "n2", type: "note", label: "n2" });
    model.addNode({ id: "c1", type: "concept", label: "POSIX" });
    model.addNode({ id: "q1", type: "question", label: "Why?" });
    expect(model.counts()).toEqual({
      notes: 2,
      concepts: 1,
      claims: 0,
      questions: 1,
      edges: 0,
    });
  });
});
