import type { Nodes, PhrasingContent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import type { Node, Parent } from "unist";

/**
 * Custom remark plugin: parses Obsidian-style #tag annotations.
 *
 *   #concept
 *   #concept/auth/oauth
 *
 * Produces phrasing-content nodes of type `tagRef` with a `path` field.
 * The leading `#` must be preceded by start-of-string or whitespace; this
 * rejects URL fragments such as `https://x.com#frag`. Skips text nested
 * under `inlineCode`, `code`, or `heading` ancestors.
 *
 * Spec: §8.1, Phase 2 plan §Task 6.
 */

export interface TagRefNode extends Node {
  type: "tagRef";
  path: string;
  data?: { hName: string; hProperties?: Record<string, unknown> };
}

declare module "mdast" {
  interface PhrasingContentMap {
    tagRef: TagRefNode;
  }
  interface RootContentMap {
    tagRef: TagRefNode;
  }
}

const TAG_PATTERN = /(^|\s)#([A-Za-z0-9_][A-Za-z0-9/_-]*)/g;

const SKIP_ANCESTOR_TYPES = new Set(["heading", "inlineCode", "code"]);

function processText(value: string): PhrasingContent[] | null {
  TAG_PATTERN.lastIndex = 0;
  const matches = [...value.matchAll(TAG_PATTERN)];
  if (matches.length === 0) {
    return null;
  }
  const replacements: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of matches) {
    const [full, leading, path] = match;
    const start = (match.index ?? 0) + leading.length;
    if (start > cursor) {
      replacements.push({ type: "text", value: value.slice(cursor, start) });
    }
    const tagNode: TagRefNode = {
      type: "tagRef",
      path,
      data: { hName: "span", hProperties: { className: ["tag-ref"] } },
    };
    replacements.push(tagNode as unknown as PhrasingContent);
    cursor = (match.index ?? 0) + full.length;
  }
  if (cursor < value.length) {
    replacements.push({ type: "text", value: value.slice(cursor) });
  }
  return replacements;
}

function walk(node: Node, parent: Parent | null, indexInParent: number): void {
  if (parent !== null && node.type === "text") {
    const replaced = processText((node as Text).value);
    if (replaced !== null) {
      parent.children.splice(indexInParent, 1, ...(replaced as Nodes[]));
    }
    return;
  }
  if (SKIP_ANCESTOR_TYPES.has(node.type)) {
    return;
  }
  const asParent = node as Partial<Parent>;
  if (!Array.isArray(asParent.children)) {
    return;
  }
  for (let index = asParent.children.length - 1; index >= 0; index -= 1) {
    walk(asParent.children[index], node as Parent, index);
  }
}

const remarkTag: Plugin<[], Root> = () => (tree) => {
  walk(tree, null, 0);
};

export default remarkTag;
