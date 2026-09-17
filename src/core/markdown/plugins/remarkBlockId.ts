import type { ListItem, Paragraph, Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/**
 * Custom remark plugin: detects trailing Obsidian block-id markers.
 *
 * Pattern: `\s\^([A-Za-z0-9_-]+)\s*$` on the last text child of a
 * `paragraph` or `listItem` node. The marker is stripped from the
 * visible text and the parsed id is attached as `blockId` on the
 * paragraph (or on the enclosing listItem when the paragraph is its
 * last child).
 */

declare module "mdast" {
  interface Paragraph {
    blockId?: string;
  }
  interface ListItem {
    blockId?: string;
  }
}

const BLOCK_ID_PATTERN = /\s\^([A-Za-z0-9_-]+)\s*$/;

function removeTrailingBlockId(paragraph: Paragraph): string | null {
  const last = paragraph.children.at(-1);
  if (last?.type !== "text") return null;
  const match = last.value.match(BLOCK_ID_PATTERN);
  if (match === null) return null;
  const stripped = last.value.slice(0, match.index ?? 0);
  if (stripped.length === 0) paragraph.children.pop();
  else last.value = stripped;
  return match[1];
}

function attachBlockId(
  paragraph: Paragraph,
  blockId: string,
  indexInParent: number | undefined,
  parent: { type: string; children: unknown[] } | undefined,
): void {
  const listItem = parent?.type === "listItem" ? (parent as ListItem) : null;
  if (listItem !== null && indexInParent === listItem.children.length - 1) {
    listItem.blockId = blockId;
    return;
  }
  paragraph.blockId = blockId;
}

const remarkBlockId: Plugin<[], Root> = () => (tree) => {
  visit(tree, "paragraph", (paragraph: Paragraph, indexInParent, parent) => {
    const blockId = removeTrailingBlockId(paragraph);
    if (blockId !== null) attachBlockId(paragraph, blockId, indexInParent, parent);
  });
};

export default remarkBlockId;
