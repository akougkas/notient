import { describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkWikilink, { type WikiEmbedNode, type WikiLinkNode } from "../../../../../src/core/markdown/plugins/remarkWikilink";

function parse(source: string): Root {
  return unified().use(remarkParse).use(remarkWikilink).parse(source) as Root;
}

function process(source: string): Root {
  const processor = unified().use(remarkParse).use(remarkWikilink);
  const tree = processor.parse(source) as Root;
  return processor.runSync(tree) as Root;
}

function collectWikilinks(tree: Root): (WikiLinkNode | WikiEmbedNode)[] {
  const found: (WikiLinkNode | WikiEmbedNode)[] = [];
  visit(tree, (node) => {
    if (node.type === "wikiLink" || node.type === "wikiEmbed") {
      found.push(node as WikiLinkNode | WikiEmbedNode);
    }
  });
  return found;
}

describe("remarkWikilink", () => {
  test("parses plain target", () => {
    const tree = process("Hello [[target]] world.\n");
    const links = collectWikilinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "wikiLink",
      target: "target",
      alias: null,
      heading: null,
      block: null,
    });
  });

  test("parses aliased target", () => {
    const tree = process("See [[note|the note]].\n");
    const links = collectWikilinks(tree);
    expect(links[0]).toMatchObject({
      type: "wikiLink",
      target: "note",
      alias: "the note",
    });
  });

  test("parses heading qualifier", () => {
    const tree = process("Jump to [[note#Heading Two]].\n");
    const links = collectWikilinks(tree);
    expect(links[0]).toMatchObject({
      target: "note",
      heading: "Heading Two",
      block: null,
    });
  });

  test("parses block-id qualifier", () => {
    const tree = process("Jump to [[note#^abc-1]].\n");
    const links = collectWikilinks(tree);
    expect(links[0]).toMatchObject({
      target: "note",
      heading: null,
      block: "abc-1",
    });
  });

  test("parses embed variant", () => {
    const tree = process("Embedded ![[image.png]].\n");
    const links = collectWikilinks(tree);
    expect(links[0].type).toBe("wikiEmbed");
    expect(links[0].target).toBe("image.png");
  });

  test("does not match inside inline code", () => {
    const tree = process("Inline `code [[not-a-link]]` here.\n");
    expect(collectWikilinks(tree)).toHaveLength(0);
  });

  test("does not match inside fenced code blocks", () => {
    const source = "```\n[[not-a-link]]\n```\n";
    const tree = process(source);
    expect(collectWikilinks(tree)).toHaveLength(0);
  });

  test("parses multiple links per paragraph", () => {
    const tree = process("First [[one]] then [[two|alias]] then ![[three]].\n");
    const links = collectWikilinks(tree);
    expect(links).toHaveLength(3);
    expect(links[0].target).toBe("one");
    expect(links[1].alias).toBe("alias");
    expect(links[2].type).toBe("wikiEmbed");
  });

  test("preserves surrounding text", () => {
    const tree = process("Before [[mid]] after.\n");
    let textConcat = "";
    visit(tree, (node) => {
      if (node.type === "text") {
        textConcat += (node as { value: string }).value;
      }
    });
    expect(textConcat).toBe("Before  after.");
  });
});
