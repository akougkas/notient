import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visit } from "unist-util-visit";
import { getMarkdownPipeline, parse, processAst, stringify } from "./pipeline";

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

  test("processAst applies the three custom plugins to the golden fixture", () => {
    const source = readFileSync(goldenPath, "utf8");
    const tree = processAst(source);
    const counts: Record<string, number> = {
      wikiLink: 0,
      wikiEmbed: 0,
      tagRef: 0,
      blockIdNode: 0,
    };
    visit(tree, (node) => {
      if (node.type === "wikiLink") counts.wikiLink += 1;
      if (node.type === "wikiEmbed") counts.wikiEmbed += 1;
      if (node.type === "tagRef") counts.tagRef += 1;
      if (
        (node.type === "paragraph" || node.type === "listItem") &&
        (node as { blockId?: string }).blockId !== undefined
      ) {
        counts.blockIdNode += 1;
      }
    });
    expect(counts.wikiLink).toBeGreaterThan(0);
    expect(counts.wikiEmbed).toBeGreaterThan(0);
    expect(counts.tagRef).toBeGreaterThan(0);
    expect(counts.blockIdNode).toBeGreaterThan(0);
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

  test("stringify emits Obsidian wikilink syntax for wikiLink and wikiEmbed nodes", () => {
    const source = [
      "Plain link to [[Note]] and aliased [[Note|Display]].",
      "",
      "Heading qualifier [[Note#Section]] and block qualifier [[Note#^block-1]].",
      "",
      "Aliased qualifier [[Note#Section|Display]] and aliased block [[Note#^block-1|Display]].",
      "",
      "An embed: ![[asset.png]] and aliased embed ![[asset.png|caption]].",
      "",
    ].join("\n");
    const ast = processAst(source);
    const out = stringify(ast);
    expect(out).toContain("[[Note]]");
    expect(out).toContain("[[Note|Display]]");
    expect(out).toContain("[[Note#Section]]");
    expect(out).toContain("[[Note#^block-1]]");
    expect(out).toContain("[[Note#Section|Display]]");
    expect(out).toContain("[[Note#^block-1|Display]]");
    expect(out).toContain("![[asset.png]]");
    expect(out).toContain("![[asset.png|caption]]");
    // No remark unsafe escaping should leak through for our handler output.
    expect(out).not.toContain("\\[\\[");
  });

  test("processAst → stringify → processAst is semantically stable for wikilink-only input", () => {
    // Scoped to wikilink/wikiEmbed nodes (the round-trip surface for Phase 4
    // writeback). Block-id and tag node round-trip is tracked separately.
    const source = [
      "Plain [[Note]] and aliased [[Note|Display]] in body.",
      "",
      "## Related",
      "",
      "- [[A]]",
      "- [[B#Heading]]",
      "- [[C#^block-7]]",
      "",
      "An embed: ![[asset.png]] and aliased embed ![[asset.png|caption]].",
      "",
    ].join("\n");
    const firstTree = processAst(source);
    const firstString = stringify(firstTree);
    const secondTree = processAst(firstString);
    expect(stripPositions(secondTree)).toEqual(stripPositions(firstTree));
    // Same string twice means the stringify is a fixpoint at the AST level.
    expect(stringify(secondTree)).toBe(firstString);
  });
});
