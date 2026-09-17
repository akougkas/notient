import { describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkTag, { type TagRefNode } from "../../../../../src/core/markdown/plugins/remarkTag";

function process(source: string): Root {
  const processor = unified().use(remarkParse).use(remarkTag);
  const tree = processor.parse(source) as Root;
  return processor.runSync(tree, source) as Root;
}

function collectTags(tree: Root): TagRefNode[] {
  const found: TagRefNode[] = [];
  visit(tree, (node) => {
    if (node.type === "tagRef") {
      found.push(node as TagRefNode);
    }
  });
  return found;
}

describe("remarkTag", () => {
  test("parses simple tag at start of paragraph", () => {
    const tree = process("#concept is the topic.\n");
    const tags = collectTags(tree);
    expect(tags).toHaveLength(1);
    expect(tags[0].path).toBe("concept");
  });

  test("parses nested tag", () => {
    const tree = process("Notes about #concept/auth/oauth here.\n");
    const tags = collectTags(tree);
    expect(tags[0].path).toBe("concept/auth/oauth");
  });

  test("rejects URL fragment", () => {
    const tree = process("Visit https://example.com#frag for more.\n");
    expect(collectTags(tree)).toHaveLength(0);
  });

  test("does not match inside inline code", () => {
    const tree = process("Inline `#not-a-tag` here.\n");
    expect(collectTags(tree)).toHaveLength(0);
  });

  test("does not match inside fenced code blocks", () => {
    const tree = process("```\n#not-a-tag\n```\n");
    expect(collectTags(tree)).toHaveLength(0);
  });

  test("matches tags in heading text, as Obsidian does", () => {
    const tree = process("# Heading with #heading-tag\n");
    expect(collectTags(tree).map((tag) => tag.path)).toEqual(["heading-tag"]);
  });

  test("accepts Unicode letters, marks and emoji sequences", () => {
    const tree = process("#café #日本語 #📚reading #emoji✨ #family👨‍👩‍👧 and #cafe\u0301.\n");
    expect(collectTags(tree).map((tag) => tag.path)).toEqual([
      "café",
      "日本語",
      "📚reading",
      "emoji✨",
      "family👨‍👩‍👧",
      "cafe\u0301",
    ]);
  });

  test("ignores escaped hashes, numeric-only names and punctuation boundaries", () => {
    const tree = process('\\#escaped #123 #y2k #end. word#no #a/b-c_d, #quoted"\n');
    expect(collectTags(tree).map((tag) => tag.path)).toEqual(["y2k", "end", "a/b-c_d", "quoted"]);
  });

  test("an escaped hash contributes no tag while an unescaped repeat still counts once", () => {
    const tree = process("\\#same then #same\n");
    expect(collectTags(tree).map((tag) => tag.path)).toEqual(["same"]);
  });

  test("parses multiple tags in one paragraph", () => {
    const tree = process("Has #one and #two/sub tags.\n");
    const tags = collectTags(tree);
    expect(tags).toHaveLength(2);
    expect(tags[0].path).toBe("one");
    expect(tags[1].path).toBe("two/sub");
  });
});
