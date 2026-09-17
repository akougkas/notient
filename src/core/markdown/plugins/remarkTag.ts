import type { Nodes, PhrasingContent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import type { Node, Parent } from "unist";
import type { VFile } from "vfile";
import { inlineTagPattern, isTagName } from "../tags";

/**
 * Custom remark plugin: parses Obsidian-style #tag annotations.
 *
 *   #concept
 *   #concept/auth/oauth
 *   #café  #📚reading
 *
 * Produces phrasing-content nodes of type `tagRef` with a `path` field. The
 * grammar is shared with note structure (`../tags`). The leading `#` must be
 * preceded by start-of-text or whitespace, which rejects URL fragments such
 * as `https://x.com#frag`. Text under `inlineCode` or `code` is skipped.
 * Heading text is included, as in Obsidian.
 *
 * Text node values are unescaped, so `\#word` and `#word` look identical.
 * When the source is available (`processAst`), each candidate must also
 * appear unescaped in the node's raw source span.
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

const SKIP_ANCESTOR_TYPES = new Set(["inlineCode", "code"]);

/** Tag names that occur unescaped in the raw source, in order. */
function rawTagNames(node: Text, source: string | null): string[] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (source === null || start === undefined || end === undefined) return null;
  return [...source.slice(start, end).matchAll(inlineTagPattern())].map((match) => match[2]);
}

function processText(node: Text, source: string | null): PhrasingContent[] | null {
  const value = node.value;
  const raw = rawTagNames(node, source);
  const matches = [...value.matchAll(inlineTagPattern())].filter((match) => {
    if (!isTagName(match[2])) return false;
    if (raw === null) return true;
    const index = raw.indexOf(match[2]);
    if (index < 0) return false;
    raw.splice(0, index + 1);
    return true;
  });
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

function walk(
  node: Node,
  parent: Parent | null,
  indexInParent: number,
  source: string | null,
): void {
  if (parent !== null && node.type === "text") {
    const replaced = processText(node as Text, source);
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
    walk(asParent.children[index], node as Parent, index, source);
  }
}

const remarkTag: Plugin<[], Root> = () => (tree, file?: VFile) => {
  const source = typeof file?.value === "string" && file.value.length > 0 ? file.value : null;
  walk(tree, null, 0, source);
};

export default remarkTag;
