import { createHash } from "node:crypto";
import type {
  Heading,
  ListItem,
  Paragraph,
  Root,
  RootContent,
  Yaml,
} from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { headingSlug } from "./slug";
import type { TagRefNode } from "./plugins/remarkTag";
import type { WikiEmbedNode, WikiLinkNode } from "./plugins/remarkWikilink";
import type {
  BlockSpec,
  FrontmatterRefSpec,
  MarkdownExtraction,
  TagSpec,
  WikilinkSpec,
} from "./types";

/**
 * Pure walker: turns an enriched mdast tree into a MarkdownExtraction
 * for the Tier 1 indexer.
 *
 * Spec: §8.2, Phase 2 plan §Task 9.
 */

const FRONTMATTER_WIKILINK_PATTERN = /\[\[([^\]\n]+?)\]\]/g;
const FRONTMATTER_TAG_PATH_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/;
const FRONTMATTER_TAG_KEYS = ["tags", "tag"] as const;

interface HeadingFrame {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

interface OpenBlock {
  spec: BlockSpec;
  textParts: string[];
}

function isHeadingNode(node: Node): node is Heading {
  return node.type === "heading";
}

function nodeStartLine(node: Node): number {
  return (node as { position?: { start?: { line: number } } }).position?.start?.line ?? 0;
}

function nodeEndLine(node: Node): number {
  return (node as { position?: { end?: { line: number } } }).position?.end?.line ?? 0;
}

function clampLevel(level: number): 1 | 2 | 3 | null {
  if (level === 1 || level === 2 || level === 3) {
    return level;
  }
  return null;
}

function makeHeadingPath(stack: HeadingFrame[], upToLevel: number): string[] {
  return stack.filter((frame) => frame.level <= upToLevel).map((frame) => frame.text);
}

function parseWikilinkInner(raw: string): {
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
} {
  let target = raw;
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

function collectInlineSignals(
  node: Node,
  fromBlockOrd: number | null,
  wikilinks: WikilinkSpec[],
  tags: TagSpec[],
  headingStack: HeadingFrame[],
): void {
  visit(node, (current) => {
    if (current.type === "wikiLink" || current.type === "wikiEmbed") {
      const link = current as WikiLinkNode | WikiEmbedNode;
      const targetHeadingPath: string[] =
        link.heading !== null
          ? [...headingStack.map((frame) => frame.text), link.heading]
          : [];
      wikilinks.push({
        fromBlockOrd,
        rawTarget: link.target,
        targetPath: null,
        targetHeading: link.heading,
        targetBlockId: link.block,
        targetHeadingPath: link.heading !== null ? targetHeadingPath : [],
        alias: link.alias,
        isEmbed: current.type === "wikiEmbed",
        targetUnresolved: null,
      });
    } else if (current.type === "tagRef") {
      const tag = current as TagRefNode;
      tags.push({ fromBlockOrd, path: tag.path.toLowerCase() });
    }
  });
}

function walkFrontmatterValue(
  key: string,
  value: unknown,
  refs: FrontmatterRefSpec[],
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    FRONTMATTER_WIKILINK_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(FRONTMATTER_WIKILINK_PATTERN)) {
      const parsed = parseWikilinkInner(match[1]);
      refs.push({ key, rawTarget: parsed.target, targetPath: null });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      walkFrontmatterValue(key, element, refs);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const nextKey = key.length === 0 ? childKey : `${key}.${childKey}`;
      walkFrontmatterValue(nextKey, childValue, refs);
    }
  }
}

function collectFrontmatterTagValues(value: unknown, output: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (typeof element === "string") {
        output.push(element);
      }
    }
  }
}

function parseFrontmatter(node: Yaml): {
  frontmatter: Record<string, unknown>;
  refs: FrontmatterRefSpec[];
  tags: TagSpec[];
} {
  const refs: FrontmatterRefSpec[] = [];
  const tags: TagSpec[] = [];
  let frontmatter: Record<string, unknown> = {};
  if (node.value.length > 0) {
    const parsed = parseYaml(node.value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    walkFrontmatterValue(key, value, refs);
  }
  // Frontmatter tags attach to the note (FROM = note), so fromBlockOrd stays
  // null. Both `tags` (plural) and `tag` (singular) are accepted; values may
  // be a string or an array of strings. Lowercase before validating against
  // the schema regex; non-matching values drop silently.
  for (const tagKey of FRONTMATTER_TAG_KEYS) {
    if (!Object.hasOwn(frontmatter, tagKey)) {
      continue;
    }
    const rawValues: string[] = [];
    collectFrontmatterTagValues(frontmatter[tagKey], rawValues);
    for (const raw of rawValues) {
      const path = raw.toLowerCase();
      if (!FRONTMATTER_TAG_PATH_PATTERN.test(path)) {
        continue;
      }
      tags.push({ fromBlockOrd: null, path });
    }
  }
  return { frontmatter, refs, tags };
}

function pushBlock(
  blocks: BlockSpec[],
  spec: BlockSpec,
): void {
  blocks.push(spec);
}

function closeBlock(open: OpenBlock | null): void {
  if (open === null) {
    return;
  }
  open.spec.text = open.textParts.join("").trim();
}

function nodeBlockId(node: Node): string | null {
  const value = (node as { blockId?: string }).blockId;
  return typeof value === "string" ? value : null;
}

function appendText(open: OpenBlock | null, text: string, endLine: number): void {
  if (open === null || text.length === 0) {
    return;
  }
  open.textParts.push(text);
  open.textParts.push("\n");
  if (endLine > open.spec.endLine) {
    open.spec.endLine = endLine;
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export function extract(ast: Root, _notePath: string, source: string): MarkdownExtraction {
  const blocks: BlockSpec[] = [];
  const wikilinks: WikilinkSpec[] = [];
  const tags: TagSpec[] = [];
  const frontmatterRefs: FrontmatterRefSpec[] = [];
  let frontmatter: Record<string, unknown> = {};

  const headingStack: HeadingFrame[] = [];
  let openHeadingBlock: OpenBlock | null = null;

  // A note that opens with body content before any H1/H2/H3 (or has no
  // heading at all) would otherwise drop every paragraph because
  // `appendText(null, ...)` is a no-op. Lazily synthesize a preamble block
  // the first time content needs a home so the same close/flush contract
  // that governs heading blocks applies to it too.
  function ensureOpenBlock(node: Node): OpenBlock {
    if (openHeadingBlock !== null) {
      return openHeadingBlock;
    }
    const startLine = nodeStartLine(node);
    const spec: BlockSpec = {
      blockId: null,
      headingLevel: null,
      headingPath: [],
      headingSlug: null,
      ord: blocks.length,
      startLine,
      endLine: startLine,
      text: "",
    };
    blocks.push(spec);
    openHeadingBlock = { spec, textParts: [] };
    return openHeadingBlock;
  }

  function makeOpenHeadingBlock(node: Heading, level: 1 | 2 | 3): OpenBlock {
    const headingText = mdastToString(node);
    const ord = blocks.length;
    const slug = headingSlug(headingText);
    const path = [...headingStack.filter((frame) => frame.level < level).map((frame) => frame.text), headingText];
    const spec: BlockSpec = {
      blockId: null,
      headingLevel: level,
      headingPath: path,
      headingSlug: slug.length > 0 ? slug : null,
      ord,
      startLine: nodeStartLine(node),
      endLine: nodeEndLine(node),
      text: "",
    };
    blocks.push(spec);
    return { spec, textParts: [] };
  }

  function makeStandaloneBlock(node: Node, blockId: string): OpenBlock {
    const ord = blocks.length;
    const text = mdastToString(node);
    const path = [...headingStack.filter((frame) => frame.level <= 3).map((frame) => frame.text)];
    const spec: BlockSpec = {
      blockId,
      headingLevel: null,
      headingPath: path,
      headingSlug: null,
      ord,
      startLine: nodeStartLine(node),
      endLine: nodeEndLine(node),
      text,
    };
    blocks.push(spec);
    return { spec, textParts: [text] };
  }

  for (const child of ast.children as RootContent[]) {
    if (child.type === "yaml") {
      const parsed = parseFrontmatter(child as Yaml);
      frontmatter = parsed.frontmatter;
      frontmatterRefs.push(...parsed.refs);
      tags.push(...parsed.tags);
      continue;
    }

    if (isHeadingNode(child)) {
      const level = child.depth as 1 | 2 | 3 | 4 | 5 | 6;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      const headingText = mdastToString(child);
      headingStack.push({ level, text: headingText });

      const clamped = clampLevel(level);
      if (clamped !== null) {
        closeBlock(openHeadingBlock);
        openHeadingBlock = makeOpenHeadingBlock(child, clamped);
      } else if (openHeadingBlock !== null) {
        openHeadingBlock.spec.headingPath = [...openHeadingBlock.spec.headingPath, headingText];
        appendText(openHeadingBlock, headingText, nodeEndLine(child));
      }
      continue;
    }

    if (
      (child.type === "paragraph" || child.type === "list") &&
      typeof (child as Paragraph).blockId === "string"
    ) {
      const blockId = nodeBlockId(child) as string;
      const standalone = makeStandaloneBlock(child, blockId);
      collectInlineSignals(child, standalone.spec.ord, wikilinks, tags, headingStack);
      continue;
    }

    if (child.type === "list") {
      for (const item of child.children) {
        const itemBlockId = nodeBlockId(item);
        if (itemBlockId !== null) {
          const standalone = makeStandaloneBlock(item, itemBlockId);
          collectInlineSignals(item as ListItem, standalone.spec.ord, wikilinks, tags, headingStack);
        } else {
          const itemText = mdastToString(item);
          const target = ensureOpenBlock(item);
          appendText(target, itemText, nodeEndLine(item));
          collectInlineSignals(
            item as ListItem,
            target.spec.ord,
            wikilinks,
            tags,
            headingStack,
          );
        }
      }
      continue;
    }

    if (child.type === "paragraph") {
      const standalonePid = nodeBlockId(child);
      if (standalonePid !== null) {
        const standalone = makeStandaloneBlock(child, standalonePid);
        collectInlineSignals(child, standalone.spec.ord, wikilinks, tags, headingStack);
        continue;
      }
      const text = mdastToString(child);
      const target = ensureOpenBlock(child);
      appendText(target, text, nodeEndLine(child));
      collectInlineSignals(
        child,
        target.spec.ord,
        wikilinks,
        tags,
        headingStack,
      );
      continue;
    }

    const generic = mdastToString(child);
    const target = ensureOpenBlock(child);
    appendText(target, generic, nodeEndLine(child));
    collectInlineSignals(
      child,
      target.spec.ord,
      wikilinks,
      tags,
      headingStack,
    );
  }

  closeBlock(openHeadingBlock);

  // bodySha hashes the raw file body (frontmatter included) so the SHA
  // contract agrees with `daemon/watcher.ts#sha256Body` and
  // `ApprovalService.hash`. Tier 1's `findRecentDaemonWrite` lookup only
  // matches when both producers compute the SHA over the same bytes.
  const bodySha = createHash("sha256").update(source).digest("hex");
  const joinedText = blocks.map((block) => block.text).join("\n");
  const wordCount = countWords(joinedText);

  return {
    blocks,
    wikilinks,
    tags,
    frontmatterRefs,
    frontmatter,
    bodySha,
    wordCount,
  };
}
