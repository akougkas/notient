import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMarkdownPipeline, parse, stringify } from "./pipeline";

const goldenPath = join(import.meta.dir, "__fixtures__", "golden.md");

function stripPositions(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripPositions);
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "position") {
        continue;
      }
      result[key] = stripPositions(value);
    }
    return result;
  }
  return node;
}

describe("markdown pipeline", () => {
  test("getMarkdownPipeline returns the same memoised instance", () => {
    expect(getMarkdownPipeline()).toBe(getMarkdownPipeline());
  });

  test("parse produces an mdast root node", () => {
    const ast = parse("# Hello\n\nworld\n");
    expect(ast.type).toBe("root");
    expect(Array.isArray(ast.children)).toBe(true);
  });

  test("parse → stringify → parse is byte-deterministic on the golden fixture", () => {
    const source = readFileSync(goldenPath, "utf8");
    const firstAst = parse(source);
    const firstString = stringify(firstAst);
    const secondAst = parse(firstString);
    const secondString = stringify(secondAst);
    expect(secondString).toBe(firstString);
    expect(stripPositions(secondAst)).toEqual(stripPositions(firstAst));
  });
});
