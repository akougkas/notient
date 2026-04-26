import { describe, expect, test } from "bun:test";
import { generateSearchResultsCanvas, generateSynthesisCanvas } from "./canvasGenerator";

describe("canvasGenerator", () => {
  test("synthesis canvas centres the stub and orbits source notes", () => {
    const canvas = generateSynthesisCanvas({
      synthesisTitle: "Career arc",
      synthesisBody: "Draft body.",
      sourceNotePaths: ["/a.md", "/b.md", "/c.md"],
    });
    expect(canvas.nodes).toHaveLength(4);
    expect(canvas.nodes[0]).toMatchObject({ type: "text" });
    expect(canvas.edges).toHaveLength(3);
  });

  test("search canvas places the query node and connects each result", () => {
    const canvas = generateSearchResultsCanvas({
      query: "career arc",
      resultPaths: ["/a.md", "/b.md"],
    });
    expect(canvas.nodes).toHaveLength(3);
    const fileCount = canvas.nodes.filter((n) => n.type === "file").length;
    expect(fileCount).toBe(2);
    expect(canvas.edges).toHaveLength(2);
  });

  test("output passes JSON.parse(JSON.stringify(...)) round-trip with no functions", () => {
    const canvas = generateSynthesisCanvas({
      synthesisTitle: "t",
      synthesisBody: "b",
      sourceNotePaths: [],
    });
    expect(JSON.parse(JSON.stringify(canvas))).toEqual(canvas);
  });
});
