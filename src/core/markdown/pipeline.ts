import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type { Root } from "mdast";
import type { Processor } from "unified";
import { unified } from "unified";
import remarkBlockId from "./plugins/remarkBlockId";
import remarkTag from "./plugins/remarkTag";
import remarkWikilink from "./plugins/remarkWikilink";

/**
 * Memoised unified processor for Notient's markdown pipeline.
 *
 * Spec: §8.1. Phase 2 wires only the base plugins here; Task 7 adds the
 * three custom Obsidian plugins (wikilink, blockId, tag) once they exist.
 */

type MarkdownProcessor = Processor<Root, Root, Root, Root, string>;

let cached: MarkdownProcessor | null = null;

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
 * paragraphs/list-items. Used by the Tier 1 extractor (Task 9).
 */
export function processAst(source: string): Root {
  const processor = getMarkdownPipeline();
  const tree = processor.parse(source) as Root;
  return processor.runSync(tree) as Root;
}
