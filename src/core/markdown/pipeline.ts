import type { Root } from "mdast";
import type { Handle } from "mdast-util-to-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type { Processor } from "unified";
import { unified } from "unified";
import remarkBlockId from "./plugins/remarkBlockId";
import remarkTag from "./plugins/remarkTag";
import remarkWikilink from "./plugins/remarkWikilink";
import type { WikiEmbedNode, WikiLinkNode } from "./plugins/remarkWikilink";

/**
 * Memoised unified processor for Notient's markdown pipeline.
 *
 * Spec: §8.1. The pipeline registers Notient's three custom Obsidian parser
 * plugins (wikilink, blockId, tag) and matching stringify handlers for the
 * node types those plugins produce that are otherwise unknown to
 * `mdast-util-to-markdown`: `wikiLink` and `wikiEmbed`. With the handlers in
 * place a tree containing those nodes round-trips back to the literal
 * `[[target]]` / `![[target]]` Obsidian syntax.
 *
 * `blockId` and `tagRef`: blockId is stored as a property on
 * `paragraph`/`listItem` nodes (the marker is stripped from text), and
 * `tagRef` is a phrasing-content node introduced by `remarkTag`. Neither has
 * a stringify handler yet; consumers that need a full processAst →
 * stringify round-trip on tagged or block-id-anchored notes must add those
 * handlers separately. The Phase 4 writeback only inserts wikilinks and is
 * unaffected by that gap on the existing fixtures.
 */

type MarkdownProcessor = Processor<Root, Root, Root, Root, string>;

let cached: MarkdownProcessor | null = null;

function formatWikilinkBody(node: WikiLinkNode | WikiEmbedNode): string {
  if (node.heading !== null && node.block !== null) {
    throw new Error("wikilink heading and block qualifiers are mutually exclusive");
  }
  let body = node.target;
  if (node.heading !== null) {
    body += `#${node.heading}`;
  } else if (node.block !== null) {
    body += `#^${node.block}`;
  }
  if (node.alias !== null) {
    body += `|${node.alias}`;
  }
  return body;
}

// `Handle` accepts a heterogeneous `node: any` because mdast-util-to-markdown
// dispatches by string type and cannot statically narrow the shape. We assert
// the concrete WikiLinkNode / WikiEmbedNode shape inside our handlers; the
// dispatcher will only invoke them for those types.
const handleWikiLink: Handle = (node) => {
  return `[[${formatWikilinkBody(node as WikiLinkNode)}]]`;
};

const handleWikiEmbed: Handle = (node) => {
  return `![[${formatWikilinkBody(node as WikiEmbedNode)}]]`;
};

export function getMarkdownPipeline(): MarkdownProcessor {
  if (cached === null) {
    cached = unified()
      .use(remarkParse)
      .use(remarkFrontmatter, ["yaml"])
      .use(remarkGfm)
      .use(remarkWikilink)
      .use(remarkBlockId)
      .use(remarkTag)
      .use(remarkStringify, {
        bullet: "-",
        emphasis: "_",
        fences: true,
        listItemIndent: "one",
        rule: "-",
        ruleSpaces: false,
        tightDefinitions: true,
        handlers: {
          // mdast-util-to-markdown returns handler output verbatim into the
          // serialised stream. It does not re-check the result against the
          // global unsafe table, so the literal `[[` / `![[` we emit here is
          // preserved without escaping. We intentionally do not modify the
          // unsafe table itself; that would weaken escaping for unrelated
          // text content elsewhere in the document.
          wikiLink: handleWikiLink,
          wikiEmbed: handleWikiEmbed,
        },
      })
      .freeze() as unknown as MarkdownProcessor;
  }
  return cached;
}

export function parse(source: string): Root {
  return getMarkdownPipeline().parse(source) as Root;
}

export function stringify(ast: Root): string {
  return getMarkdownPipeline().stringify(ast) as string;
}

/**
 * Parse and run all transformer plugins. Returns the enriched mdast tree
 * containing wikiLink, wikiEmbed, tagRef nodes and blockId-annotated
 * paragraphs/list-items. Used by the Tier 1 extractor and by the writeback
 * module so it operates on a fully-typed tree (Task 1, Phase 4).
 */
export function processAst(source: string): Root {
  const processor = getMarkdownPipeline();
  const tree = processor.parse(source) as Root;
  return processor.runSync(tree) as Root;
}
