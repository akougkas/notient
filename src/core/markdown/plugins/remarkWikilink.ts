import type { Nodes, PhrasingContent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import type { Node, Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";

/**
 * Custom remark plugin: parses Obsidian wikilink syntax.
 *
 *   [[target]]
 *   [[target|alias]]
 *   [[target#Heading]]
 *   [[target#^block-id]]
 *   ![[target]]            (embed variant)
 *
 * Produces phrasing-content nodes of type `wikiLink` (regular) or
 * `wikiEmbed` (embed). Both carry: `target`, `alias`, `heading`, `block`
 * (any unset → `null`).
 */

export interface WikiLinkNode extends Node {
  type: "wikiLink";
  target: string;
  alias: string | null;
  heading: string | null;
  block: string | null;
  data?: { hName: string; hProperties?: Record<string, unknown> };
}

export interface WikiEmbedNode extends Node {
  type: "wikiEmbed";
  target: string;
  alias: string | null;
  heading: string | null;
  block: string | null;
  data?: { hName: string; hProperties?: Record<string, unknown> };
}

declare module "mdast" {
  interface PhrasingContentMap {
    wikiLink: WikiLinkNode;
    wikiEmbed: WikiEmbedNode;
  }
  interface RootContentMap {
    wikiLink: WikiLinkNode;
    wikiEmbed: WikiEmbedNode;
  }
}

const WIKILINK_PATTERN = /(!)?\[\[([^\]\n]+?)\]\]/g;

export interface ParsedWikilinkTarget {
  target: string;
  alias: string | null;
  heading: string | null;
  block: string | null;
}

/** Parse the contents between a wikilink's `[[` and `]]` delimiters. */
export function parseWikilinkInner(inner: string): ParsedWikilinkTarget {
  let target = inner;
  let alias: string | null = null;
  let heading: string | null = null;
  let block: string | null = null;

  const pipeIndex = target.indexOf("|");
  if (pipeIndex !== -1) {
    alias = target.slice(pipeIndex + 1).trim();
    target = target.slice(0, pipeIndex);
  }

  const hashIndex = target.indexOf("#");
  if (hashIndex !== -1) {
    const after = target.slice(hashIndex + 1);
    target = target.slice(0, hashIndex);
    if (after.startsWith("^")) {
      block = after.slice(1).trim() || null;
    } else {
      heading = after.trim() || null;
    }
  }

  return { target: target.trim(), alias, heading, block };
}

function wikiNode(inner: string, isEmbed: boolean): WikiLinkNode | WikiEmbedNode {
  const parsed = parseWikilinkInner(inner);
  return {
    type: isEmbed ? "wikiEmbed" : "wikiLink",
    target: parsed.target,
    alias: parsed.alias,
    heading: parsed.heading,
    block: parsed.block,
    data: {
      hName: "span",
      hProperties: { className: [isEmbed ? "wiki-embed" : "wiki-link"] },
    },
  };
}

function replacementsFor(value: string): PhrasingContent[] | null {
  if (!value.includes("[[")) return null;
  WIKILINK_PATTERN.lastIndex = 0;
  const matches = [...value.matchAll(WIKILINK_PATTERN)];
  if (matches.length === 0) return null;

  const replacements: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of matches) {
    const [full, bang, inner] = match;
    const start = match.index ?? 0;
    if (start > cursor) replacements.push({ type: "text", value: value.slice(cursor, start) });
    replacements.push(wikiNode(inner, bang === "!") as unknown as PhrasingContent);
    cursor = start + full.length;
  }
  if (cursor < value.length) replacements.push({ type: "text", value: value.slice(cursor) });
  return replacements;
}

const remarkWikilink: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, indexInParent, parent: Parent | undefined) => {
    if (parent === undefined || indexInParent === undefined) return;
    const replacements = replacementsFor(node.value);
    if (replacements === null) return;

    parent.children.splice(indexInParent, 1, ...(replacements as Nodes[]));
    return [SKIP, indexInParent + replacements.length];
  });
};

export default remarkWikilink;
