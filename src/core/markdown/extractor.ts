import { createHash } from "node:crypto";
import type {
  Definition,
  Heading,
  Image,
  ImageReference,
  Link,
  LinkReference,
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
import type { TagRefNode } from "./plugins/remarkTag";
import {
  type WikiEmbedNode,
  type WikiLinkNode,
  parseWikilinkInner,
} from "./plugins/remarkWikilink";
import { parseMarkdownDestination } from "./resolver";
import { headingSlug } from "./slug";
import { tagIdentity, tagName } from "./tags";
import type {
  BlockSpec,
  FrontmatterRefSpec,
  MarkdownExtraction,
  NoteLinkSpec,
  TagSpec,
} from "./types";

/**
 * Pure walker: turns an enriched mdast tree into a MarkdownExtraction
 * for the Tier 1 indexer.
 */

const FRONTMATTER_WIKILINK_PATTERN = /\[\[([^\]\n]+?)\]\]/g;
const FRONTMATTER_TAG_KEYS = ["tags", "tag"] as const;

function markdownLinkSignal(
  current: Node,
  fromBlockOrd: number | null,
  definitions: ReadonlyMap<string, Definition>,
): NoteLinkSpec | null {
  if (!["link", "image", "linkReference", "imageReference"].includes(current.type)) return null;
  const link = current as Link | Image | LinkReference | ImageReference;
  const destination =
    link.type === "link" || link.type === "image"
      ? link.url
      : definitions.get(link.identifier)?.url;
  const parsed = destination === undefined ? null : parseMarkdownDestination(destination);
  return parsed
    ? {
        ...parsed,
        fromBlockOrd,
        syntax: "markdown",
        isEmbed: current.type === "image" || current.type === "imageReference",
      }
    : null;
}

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

function collectInlineSignals(
  node: Node,
  fromBlockOrd: number | null,
  links: NoteLinkSpec[],
  tags: TagSpec[],
  definitions: ReadonlyMap<string, Definition>,
): void {
  visit(node, (current) => {
    if (current.type === "wikiLink" || current.type === "wikiEmbed") {
      const link = current as WikiLinkNode | WikiEmbedNode;
      links.push({
        syntax: "wiki",
        fromBlockOrd,
        rawTarget: link.target,
        targetHeading: link.heading,
        targetBlockId: link.block,
        isEmbed: current.type === "wikiEmbed",
      });
    } else if (current.type === "tagRef") {
      const tag = current as TagRefNode;
      tags.push({ fromBlockOrd, path: tagIdentity(tag.path) });
    } else {
      const link = markdownLinkSignal(current, fromBlockOrd, definitions);
      if (link) links.push(link);
    }
  });
}

function walkFrontmatterValue(key: string, value: unknown, refs: FrontmatterRefSpec[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    FRONTMATTER_WIKILINK_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(FRONTMATTER_WIKILINK_PATTERN)) {
      const parsed = parseWikilinkInner(match[1]);
      refs.push({ key, rawTarget: parsed.target });
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
  // be a string or an array of strings, with or without `#`. Values outside
  // the shared tag grammar are not tags and are skipped.
  for (const tagKey of FRONTMATTER_TAG_KEYS) {
    if (!Object.hasOwn(frontmatter, tagKey)) {
      continue;
    }
    const rawValues: string[] = [];
    collectFrontmatterTagValues(frontmatter[tagKey], rawValues);
    for (const raw of rawValues) {
      const name = tagName(raw);
      if (name !== null) tags.push({ fromBlockOrd: null, path: tagIdentity(name) });
    }
  }
  return { refs, tags };
}

const CALLOUT_MARKER = /^\[!([A-Za-z0-9_-]+)\]([+-])?[ \t]*(.*)$/;
const BLOCKQUOTE_PREFIX = /^[ \t]{0,3}>[ \t]?/;

/**
 * Recognise an Obsidian callout: `> [!type]` / `> [!type]+ Title`.
 *
 * Detection reads the ORIGINAL source lines rather than the mdast tree,
 * because remark parses `[!note]` as an undefined link reference and
 * `mdast-util-to-string` would hand back `!note` with the brackets already
 * gone. The returned `text` is the title plus the quoted body with the `>`
 * markers stripped. The `[!type]` marker stays in the indexed text: it is
 * semantic content, not disposable parser metadata.
 */
function calloutFromBlockquote(node: Node, sourceLines: string[]): string | null {
  const start = nodeStartLine(node);
  const end = nodeEndLine(node);
  if (start < 1) {
    return null;
  }
  const stripped = sourceLines
    .slice(start - 1, end)
    .map((line) => line.replace(BLOCKQUOTE_PREFIX, ""));
  const match = (stripped[0] ?? "").match(CALLOUT_MARKER);
  if (match === null) {
    return null;
  }
  return stripped.join("\n").trim();
}

/**
 * Text of a list item as it appears in the note. GFM task state is part of
 * the content for indexing purposes: `- [ ] buy milk` must not be flattened
 * to `buy milk`, otherwise an open task and a done task index identically.
 */
function listItemText(item: ListItem): string {
  const text = mdastToString(item);
  if (typeof item.checked !== "boolean") {
    return text;
  }
  return `- [${item.checked ? "x" : " "}] ${text}`;
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

interface ExtractionWalkState {
  definitions: Map<string, Definition>;
  blocks: BlockSpec[];
  links: NoteLinkSpec[];
  tags: TagSpec[];
  frontmatterRefs: FrontmatterRefSpec[];
  headingStack: HeadingFrame[];
  openHeadingBlock: OpenBlock | null;
  sourceLines: string[];
}

function ensureOpenBlock(state: ExtractionWalkState, node: Node): OpenBlock {
  // A note that opens with body content before any heading (or has no
  // heading at all) would otherwise drop every paragraph because
  // `appendText(null, ...)` is a no-op. Lazily synthesize a preamble block
  // the first time content needs a home so the same close/flush contract
  // that governs heading blocks applies to it too.
  if (state.openHeadingBlock !== null) {
    return state.openHeadingBlock;
  }
  const startLine = nodeStartLine(node);
  const spec: BlockSpec = {
    blockId: null,
    headingLevel: null,
    headingPath: [],
    headingSlug: null,
    ord: state.blocks.length,
    startLine,
    endLine: startLine,
    text: "",
  };
  state.blocks.push(spec);
  state.openHeadingBlock = { spec, textParts: [] };
  return state.openHeadingBlock;
}

function makeOpenHeadingBlock(
  state: ExtractionWalkState,
  node: Heading,
  depth: 1 | 2 | 3 | 4 | 5 | 6,
): OpenBlock {
  const headingText = mdastToString(node);
  const slug = headingSlug(headingText);
  const path = [
    ...state.headingStack.filter((frame) => frame.level < depth).map((frame) => frame.text),
    headingText,
  ];
  const spec: BlockSpec = {
    blockId: null,
    headingLevel: depth,
    headingPath: path,
    headingSlug: slug.length > 0 ? slug : null,
    ord: state.blocks.length,
    startLine: nodeStartLine(node),
    endLine: nodeEndLine(node),
    text: "",
  };
  state.blocks.push(spec);
  return { spec, textParts: [] };
}

function makeStandaloneBlock(
  state: ExtractionWalkState,
  node: Node,
  blockId: string,
  override?: string,
): OpenBlock {
  const text = override ?? mdastToString(node);
  const spec: BlockSpec = {
    blockId,
    headingLevel: null,
    headingPath: [...state.headingStack.map((frame) => frame.text)],
    headingSlug: null,
    ord: state.blocks.length,
    startLine: nodeStartLine(node),
    endLine: nodeEndLine(node),
    text,
  };
  state.blocks.push(spec);
  return { spec, textParts: [text] };
}

function makeCalloutBlock(state: ExtractionWalkState, node: Node, text: string): OpenBlock {
  const spec: BlockSpec = {
    blockId: nodeBlockId(node),
    headingLevel: null,
    headingPath: [...state.headingStack.map((frame) => frame.text)],
    headingSlug: null,
    ord: state.blocks.length,
    startLine: nodeStartLine(node),
    endLine: nodeEndLine(node),
    text,
  };
  state.blocks.push(spec);
  return { spec, textParts: [text] };
}

function collectBlockSignals(state: ExtractionWalkState, node: Node, block: OpenBlock): void {
  collectInlineSignals(node, block.spec.ord, state.links, state.tags, state.definitions);
}

function consumeHeading(state: ExtractionWalkState, child: Heading): void {
  const level = child.depth as 1 | 2 | 3 | 4 | 5 | 6;
  while (
    state.headingStack.length > 0 &&
    state.headingStack[state.headingStack.length - 1].level >= level
  ) {
    state.headingStack.pop();
  }
  state.headingStack.push({ level, text: mdastToString(child) });
  closeBlock(state.openHeadingBlock);
  state.openHeadingBlock = makeOpenHeadingBlock(state, child, level);
  collectBlockSignals(state, child, state.openHeadingBlock);
}

function consumeListItem(state: ExtractionWalkState, item: ListItem): void {
  const itemBlockId = nodeBlockId(item);
  if (itemBlockId !== null) {
    collectBlockSignals(
      state,
      item,
      makeStandaloneBlock(state, item, itemBlockId, listItemText(item)),
    );
    return;
  }
  const target = ensureOpenBlock(state, item);
  appendText(target, listItemText(item), nodeEndLine(item));
  collectBlockSignals(state, item, target);
}

function consumeList(
  state: ExtractionWalkState,
  child: Extract<RootContent, { type: "list" }>,
): void {
  const blockId = nodeBlockId(child);
  if (blockId !== null) {
    collectBlockSignals(state, child, makeStandaloneBlock(state, child, blockId));
    return;
  }
  for (const item of child.children) {
    consumeListItem(state, item);
  }
}

function consumeParagraph(state: ExtractionWalkState, child: Paragraph): void {
  const blockId = nodeBlockId(child);
  if (blockId !== null) {
    collectBlockSignals(state, child, makeStandaloneBlock(state, child, blockId));
    return;
  }
  const target = ensureOpenBlock(state, child);
  appendText(target, mdastToString(child), nodeEndLine(child));
  collectBlockSignals(state, child, target);
}

function consumeBlockquote(
  state: ExtractionWalkState,
  child: Extract<RootContent, { type: "blockquote" }>,
): boolean {
  const callout = calloutFromBlockquote(child, state.sourceLines);
  if (callout === null) return false;
  collectBlockSignals(state, child, makeCalloutBlock(state, child, callout));
  return true;
}

function consumeGeneric(state: ExtractionWalkState, child: RootContent): void {
  const target = ensureOpenBlock(state, child);
  appendText(target, mdastToString(child), nodeEndLine(child));
  collectBlockSignals(state, child, target);
}

function consumeChild(state: ExtractionWalkState, child: RootContent): void {
  if (child.type === "yaml") {
    const parsed = parseFrontmatter(child as Yaml);
    state.frontmatterRefs.push(...parsed.refs);
    state.tags.push(...parsed.tags);
    return;
  }
  if (isHeadingNode(child)) {
    consumeHeading(state, child);
    return;
  }
  if (child.type === "list") {
    consumeList(state, child);
    return;
  }
  if (child.type === "paragraph") {
    consumeParagraph(state, child);
    return;
  }
  if (child.type === "blockquote" && consumeBlockquote(state, child)) return;
  consumeGeneric(state, child);
}

export function extract(ast: Root, _notePath: string, source: string): MarkdownExtraction {
  const definitions = new Map<string, Definition>();
  visit(ast, "definition", (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const state: ExtractionWalkState = {
    definitions,
    blocks: [],
    links: [],
    tags: [],
    frontmatterRefs: [],
    headingStack: [],
    openHeadingBlock: null,
    sourceLines: source.split(/\r?\n/),
  };

  for (const child of ast.children as RootContent[]) {
    consumeChild(state, child);
  }
  closeBlock(state.openHeadingBlock);

  // bodySha hashes the raw file body (frontmatter included) so the SHA
  // contract agrees with `daemon/watcher.ts#sha256Body` and
  // `ApprovalService.hash`. Tier 1's `findRecentDaemonWrite` lookup only
  // matches when both producers compute the SHA over the same bytes.
  const bodySha = createHash("sha256").update(source).digest("hex");
  const joinedText = state.blocks.map((block) => block.text).join("\n");
  const wordCount = countWords(joinedText);

  return {
    blocks: state.blocks,
    links: state.links,
    tags: state.tags,
    frontmatterRefs: state.frontmatterRefs,
    bodySha,
    wordCount,
  };
}
