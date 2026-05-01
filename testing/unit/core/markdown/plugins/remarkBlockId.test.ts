import { describe, expect, test } from "bun:test";
import type { ListItem, Paragraph, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkBlockId from "../../../../../src/core/markdown/plugins/remarkBlockId";

function process(source: string): Root {
  const processor = unified().use(remarkParse).use(remarkBlockId);
  const tree = processor.parse(source) as Root;
  return processor.runSync(tree) as Root;
}

function firstParagraph(tree: Root): Paragraph | null {
  let found: Paragraph | null = null;
  visit(tree, "paragraph", (node) => {
    if (found === null) {
      found = node as Paragraph;
    }
  });
  return found;
}

function firstListItem(tree: Root): ListItem | null {
  let found: ListItem | null = null;
  visit(tree, "listItem", (node) => {
    if (found === null) {
      found = node as ListItem;
    }
  });
  return found;
}

function paragraphText(paragraph: Paragraph): string {
  let result = "";
  for (const child of paragraph.children) {
    if (child.type === "text") {
      result += child.value;
    }
  }
  return result;
}

describe("remarkBlockId", () => {
  test("attaches blockId to paragraph and strips marker", () => {
    const tree = process("This is a paragraph. ^para-1\n");
    const paragraph = firstParagraph(tree);
    expect(paragraph?.blockId).toBe("para-1");
    expect(paragraphText(paragraph as Paragraph)).toBe("This is a paragraph.");
  });

  test("attaches blockId to listItem and strips marker", () => {
    const tree = process("- Item one ^item-id\n- Item two\n");
    const item = firstListItem(tree);
    expect(item?.blockId).toBe("item-id");
    const inner = (item as ListItem).children[0] as Paragraph;
    expect(paragraphText(inner)).toBe("Item one");
  });

  test("paragraphs without a marker are untouched", () => {
    const tree = process("Plain paragraph.\n");
    const paragraph = firstParagraph(tree);
    expect(paragraph?.blockId).toBeUndefined();
    expect(paragraphText(paragraph as Paragraph)).toBe("Plain paragraph.");
  });

  test("mid-paragraph carets are not block-ids", () => {
    const tree = process("This has ^mid in the middle text.\n");
    const paragraph = firstParagraph(tree);
    expect(paragraph?.blockId).toBeUndefined();
    expect(paragraphText(paragraph as Paragraph)).toBe("This has ^mid in the middle text.");
  });

  test("hyphens and underscores are allowed in block ids", () => {
    const tree = process("Body. ^my-block_42\n");
    const paragraph = firstParagraph(tree);
    expect(paragraph?.blockId).toBe("my-block_42");
  });
});
