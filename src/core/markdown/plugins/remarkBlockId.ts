import type { ListItem, Paragraph, Root, Text } from "mdast";
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
 *
 * Spec: §8.1, Phase 2 plan §Task 5.
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

const remarkBlockId: Plugin<[], Root> = () => (tree) => {
  visit(tree, "paragraph", (paragraph: Paragraph, indexInParent, parent) => {
    const children = paragraph.children;
    if (children.length === 0) {
      return;
    }
    const last = children[children.length - 1];
    if (last.type !== "text") {
      return;
    }
    const match = (last as Text).value.match(BLOCK_ID_PATTERN);
    if (match === null) {
      return;
    }
    const blockId = match[1];
    const stripped = (last as Text).value.slice(0, match.index ?? 0);
    if (stripped.length === 0) {
      children.pop();
    } else {
      (last as Text).value = stripped;
    }

    const isLastParagraphInListItem =
      parent !== undefined &&
      parent.type === "listItem" &&
      indexInParent === parent.children.length - 1;
    if (isLastParagraphInListItem) {
      (parent as ListItem).blockId = blockId;
    } else {
      paragraph.blockId = blockId;
    }
  });
};

export default remarkBlockId;
