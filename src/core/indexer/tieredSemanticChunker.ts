/**
 * Tiered Semantic Chunker (TSI v2)
 *
 * Produces a hierarchical chunk set:
 * - Tier 0: Note (exactly 1 per note)
 * - Tier 1: Section (per heading node, H1-H3 by default)
 * - Tier 2: Block (semantic blocks: paragraphs, lists, callouts, code, tables, etc.)
 *
 * Design goals:
 * - Obsidian-aware but dependency-light (no heavy markdown parser)
 * - Stable-ish chunk IDs via structural anchors (headingPath + blockRef/line range)
 * - Deterministic size control via char budgets + token proxy
 */

import { createHash } from "node:crypto";
import type { ChunkKind, ChunkTier, NoteChunk } from "../../types/indexer";
import { generateContentHash, generateNoteId } from "./simpleChunker";

export interface ChunkerMetadata {
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  headings?: { level: number; heading: string }[];
}

export interface TieredChunkerOptions {
  /** Tier 2 max chars per chunk (block-level) */
  blockMaxChars: number;
  /** Tier 1 max chars per chunk (section-level) */
  sectionMaxChars: number;
  /** Tier 0 max chars for content sketch */
  noteSketchMaxChars: number;
  /** Which heading levels become section chunks (default: 1-3) */
  sectionHeadingMaxLevel: number;
  /** Minimum chunk size (chars) to keep (excluding note-tier) */
  minChunkChars: number;
  /** Max outline headings in the note-tier chunk */
  maxOutlineHeadings: number;
  /** Max blocks included in note-tier sketch */
  maxSketchBlocks: number;
}

const DEFAULT_OPTIONS: TieredChunkerOptions = {
  blockMaxChars: 1200,
  sectionMaxChars: 2400,
  noteSketchMaxChars: 3600,
  sectionHeadingMaxLevel: 3,
  minChunkChars: 80,
  maxOutlineHeadings: 24,
  maxSketchBlocks: 12,
};

interface Block {
  kind: ChunkKind;
  startLine: number; // 1-based
  endLine: number; // 1-based
  rawText: string;
  text: string; // cleaned for embedding
  blockRef: string | null;
}

interface SectionNode {
  id: string;
  heading: string; // empty for preamble
  level: number; // 0 for preamble, 1-6 for heading levels
  headingPath: string[];
  headingLine: number | null; // 1-based, null for preamble
  blocks: Block[];
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableChunkId(noteId: string, tier: ChunkTier, anchor: string): string {
  const hash = createHash("sha256")
    .update(`${noteId}:${tier}:${anchor}`)
    .digest("hex")
    .slice(0, 12);
  return `${noteId}-${tier}-${hash}`;
}

function normalizeTitleFromPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1].replace(/\.md$/, "");
}

function pickFrontmatterString(fm: Record<string, unknown>, key: string): string | null {
  const value = fm[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function pickFrontmatterStringArray(fm: Record<string, unknown>, key: string): string[] {
  const value = fm[key];
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function trimToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function splitFrontmatter(lines: string[]): { bodyStartIdx: number } {
  if ((lines[0] ?? "").trim() !== "---") {
    return { bodyStartIdx: 0 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { bodyStartIdx: i + 1 };
    }
  }
  return { bodyStartIdx: 0 };
}

function stripBlockRefFromLine(line: string): { line: string; blockRef: string | null } {
  const trimmed = line.trimEnd();
  // Standalone ^id line
  const standalone = trimmed.match(/^\^([A-Za-z0-9-]+)$/);
  if (standalone) {
    return { line: "", blockRef: standalone[1] };
  }
  // Trailing ^id
  const trailing = trimmed.match(/^(.*)\s\^([A-Za-z0-9-]+)$/);
  if (trailing) {
    return { line: trailing[1].trimEnd(), blockRef: trailing[2] };
  }
  return { line, blockRef: null };
}

function cleanQuoteLines(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*>\s?/, ""));
}

function isHeading(line: string): { level: number; heading: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+)\s*$/);
  if (!m) return null;
  return { level: m[1].length, heading: m[2].trim() };
}

function isCodeFenceStart(line: string): boolean {
  return line.trimStart().startsWith("```");
}

function isHr(line: string): boolean {
  const t = line.trim();
  return t === "---" || t === "***" || t === "___";
}

function isEmbed(line: string): boolean {
  const t = line.trim();
  return t.startsWith("![[") && t.endsWith("]]");
}

function isQuote(line: string): boolean {
  return line.trimStart().startsWith(">");
}

function isCalloutStart(line: string): boolean {
  return /^\s*>\s*\[!/.test(line);
}

function isListItem(line: string): boolean {
  return /^(\s*)([-*+])\s+/.test(line) || /^(\s*)\d+\.\s+/.test(line);
}

function isTaskItem(line: string): boolean {
  return /^(\s*)[-*+]\s+\[[ xX]\]\s+/.test(line);
}

function looksLikeTableLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  // Avoid accidental pipes in code-ish lines
  if (t.startsWith("```")) return false;
  return true;
}

function parseBlocks(
  filePath: string,
  content: string,
): { titleFromH1: string | null; blocks: Block[] } {
  const lines = content.split("\n");
  const { bodyStartIdx } = splitFrontmatter(lines);

  const blocks: Block[] = [];
  let titleFromH1: string | null = null;

  let i = bodyStartIdx;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineNo = i + 1; // 1-based

    // Code fence (single cohesive block)
    if (isCodeFenceStart(line)) {
      const start = i;
      let end = i;
      i++;
      while (i < lines.length) {
        if (isCodeFenceStart(lines[i] ?? "")) {
          end = i;
          i++;
          break;
        }
        i++;
      }
      const rawLines = lines.slice(start, end + 1);
      const rawText = rawLines.join("\n");
      const { line: lastLineCleaned, blockRef: trailingRef } = stripBlockRefFromLine(
        rawLines[rawLines.length - 1] ?? "",
      );
      if (trailingRef) {
        rawLines[rawLines.length - 1] = lastLineCleaned;
      }
      blocks.push({
        kind: "code",
        startLine: start + 1,
        endLine: end + 1,
        rawText,
        text: rawText,
        blockRef: trailingRef,
      });
      continue;
    }

    // Heading (structure delimiter)
    const heading = isHeading(line);
    if (heading) {
      if (!titleFromH1 && heading.level === 1) {
        titleFromH1 = heading.heading;
      }
      blocks.push({
        kind: "heading",
        startLine: lineNo,
        endLine: lineNo,
        rawText: line,
        text: line.trim(),
        blockRef: null,
      });
      i++;
      continue;
    }

    // Blank
    if (line.trim().length === 0) {
      blocks.push({
        kind: "blank",
        startLine: lineNo,
        endLine: lineNo,
        rawText: line,
        text: "",
        blockRef: null,
      });
      i++;
      continue;
    }

    // HR
    if (isHr(line)) {
      blocks.push({
        kind: "hr",
        startLine: lineNo,
        endLine: lineNo,
        rawText: line,
        text: line.trim(),
        blockRef: null,
      });
      i++;
      continue;
    }

    // Embeds
    if (isEmbed(line)) {
      const start = i;
      let end = i;
      i++;
      while (i < lines.length && isEmbed(lines[i] ?? "")) {
        end = i;
        i++;
      }
      const rawLines = lines.slice(start, end + 1);
      const rawText = rawLines.join("\n");
      blocks.push({
        kind: "embed",
        startLine: start + 1,
        endLine: end + 1,
        rawText,
        text: rawText,
        blockRef: null,
      });
      continue;
    }

    // Quotes / callouts (contiguous '>' lines)
    if (isQuote(line)) {
      const start = i;
      let end = i;
      const rawLines: string[] = [];
      let anyRef: string | null = null;

      while (i < lines.length && isQuote(lines[i] ?? "")) {
        const raw = lines[i] ?? "";
        const { line: cleaned, blockRef } = stripBlockRefFromLine(raw);
        rawLines.push(cleaned);
        anyRef = anyRef ?? blockRef;
        end = i;
        i++;
      }

      const rawText = rawLines.join("\n");
      const cleanedLines = cleanQuoteLines(rawLines);
      const text = cleanedLines.join("\n").trimEnd();

      blocks.push({
        kind: isCalloutStart(line) ? "callout" : "quote",
        startLine: start + 1,
        endLine: end + 1,
        rawText,
        text,
        blockRef: anyRef,
      });
      continue;
    }

    // Lists / task lists (contiguous list items)
    if (isListItem(line)) {
      const start = i;
      let end = i;
      const rawLines: string[] = [];
      let anyTask = false;
      let anyRef: string | null = null;

      while (i < lines.length && isListItem(lines[i] ?? "")) {
        const raw = lines[i] ?? "";
        const { line: cleaned, blockRef } = stripBlockRefFromLine(raw);
        rawLines.push(cleaned);
        anyTask = anyTask || isTaskItem(raw);
        anyRef = anyRef ?? blockRef;
        end = i;
        i++;
      }

      const rawText = rawLines.join("\n");
      const text = rawText.trimEnd();

      blocks.push({
        kind: anyTask ? "taskList" : "list",
        startLine: start + 1,
        endLine: end + 1,
        rawText,
        text,
        blockRef: anyRef,
      });
      continue;
    }

    // Tables (contiguous pipe-heavy lines)
    if (looksLikeTableLine(line)) {
      const start = i;
      let end = i;
      const rawLines: string[] = [];
      let anyRef: string | null = null;

      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (cur.trim().length === 0) break;
        if (!looksLikeTableLine(cur)) break;
        const { line: cleaned, blockRef } = stripBlockRefFromLine(cur);
        rawLines.push(cleaned);
        anyRef = anyRef ?? blockRef;
        end = i;
        i++;
      }

      const rawText = rawLines.join("\n");
      blocks.push({
        kind: "table",
        startLine: start + 1,
        endLine: end + 1,
        rawText,
        text: rawText.trimEnd(),
        blockRef: anyRef,
      });
      continue;
    }

    // Paragraph (contiguous non-blank, non-special)
    const start = i;
    let end = i;
    const rawLines: string[] = [];
    let anyRef: string | null = null;

    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.trim().length === 0) break;
      if (isCodeFenceStart(cur)) break;
      if (isHeading(cur)) break;
      if (isHr(cur)) break;
      if (isEmbed(cur)) break;
      if (isQuote(cur)) break;
      if (isListItem(cur)) break;
      // tables are ambiguous; allow single pipe line to remain paragraph unless followed by more table lines
      if (looksLikeTableLine(cur) && looksLikeTableLine(lines[i + 1] ?? "")) break;

      const { line: cleaned, blockRef } = stripBlockRefFromLine(cur);
      rawLines.push(cleaned);
      anyRef = anyRef ?? blockRef;
      end = i;
      i++;
    }

    const rawText = rawLines.join("\n");
    blocks.push({
      kind: "paragraph",
      startLine: start + 1,
      endLine: end + 1,
      rawText,
      text: rawText.trimEnd(),
      blockRef: anyRef,
    });
  }

  return { titleFromH1, blocks };
}

function buildSections(noteId: string, blocks: Block[]): SectionNode[] {
  const sections: SectionNode[] = [];

  const root: SectionNode = {
    id: stableChunkId(noteId, "section", "preamble@0"),
    heading: "",
    level: 0,
    headingPath: [],
    headingLine: null,
    blocks: [],
  };
  sections.push(root);

  const stack: SectionNode[] = [root];

  for (const block of blocks) {
    if (block.kind === "heading") {
      const headingInfo = isHeading(block.text);
      if (!headingInfo) continue;

      // unwind to parent
      while (stack.length > 1 && (stack[stack.length - 1]?.level ?? 0) >= headingInfo.level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1] ?? root;
      const headingPath = [...parent.headingPath, headingInfo.heading];
      const id = stableChunkId(
        noteId,
        "section",
        `${headingPath.join(" > ") || "preamble"}@${block.startLine}`,
      );
      const node: SectionNode = {
        id,
        heading: headingInfo.heading,
        level: headingInfo.level,
        headingPath,
        headingLine: block.startLine,
        blocks: [],
      };
      sections.push(node);
      stack.push(node);
      continue;
    }

    // Skip pure blanks as section content (but keep for sketch boundaries elsewhere)
    if (block.kind === "blank") continue;

    const current = stack[stack.length - 1] ?? root;
    current.blocks.push(block);
  }

  return sections;
}

function sectionContentText(section: SectionNode, maxChars: number): string {
  const parts: string[] = [];
  for (const b of section.blocks) {
    if (b.kind === "blank") continue;
    // Avoid embedding megabytes of code in section tier
    if (b.kind === "code" && b.text.length > 2000) continue;
    if (b.text.trim().length === 0) continue;
    parts.push(b.text);
    if (parts.join("\n\n").length >= maxChars) break;
  }
  return trimToChars(parts.join("\n\n").trim(), maxChars);
}

function splitIntoBudgetedPieces(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  // First try paragraph boundaries
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length > 1) {
    const out: string[] = [];
    let cur = "";
    for (const p of paras) {
      if (!cur) {
        cur = p;
        continue;
      }
      if (cur.length + 2 + p.length <= maxChars) {
        cur = `${cur}\n\n${p}`;
      } else {
        out.push(cur);
        cur = p;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.map((t) => trimToChars(t, maxChars));
  }

  // Fall back to sentence-ish splitting
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    const out: string[] = [];
    let cur = "";
    for (const s of sentences) {
      if (!cur) {
        cur = s;
        continue;
      }
      if (cur.length + 1 + s.length <= maxChars) {
        cur = `${cur} ${s}`;
      } else {
        out.push(cur);
        cur = s;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.map((t) => trimToChars(t, maxChars));
  }

  // Absolute fallback: hard cut
  return [trimToChars(text, maxChars)];
}

function buildNoteTierText(
  filePath: string,
  title: string,
  metadata: ChunkerMetadata | null,
  sections: SectionNode[],
  options: TieredChunkerOptions,
): string {
  const fm = metadata?.frontmatter ?? {};
  const tags = (metadata?.tags ?? []).slice(0, 24);
  const aliases = pickFrontmatterStringArray(fm, "aliases");
  const type = pickFrontmatterString(fm, "type");
  const status = pickFrontmatterString(fm, "status");

  const outlineHeadings = sections
    .filter((s) => s.level >= 1 && s.level <= options.sectionHeadingMaxLevel)
    .slice(0, options.maxOutlineHeadings)
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 1))}- ${s.heading}`);

  // Content sketch: first N non-blank blocks from earliest sections (preamble first)
  const sketchBlocks: string[] = [];
  for (const section of sections) {
    for (const b of section.blocks) {
      if (b.kind === "blank") continue;
      if (b.kind === "code" && b.text.length > 2000) continue;
      const t = b.text.trim();
      if (!t) continue;
      sketchBlocks.push(t);
      if (sketchBlocks.length >= options.maxSketchBlocks) break;
      if (sketchBlocks.join("\n\n").length >= options.noteSketchMaxChars) break;
    }
    if (sketchBlocks.length >= options.maxSketchBlocks) break;
    if (sketchBlocks.join("\n\n").length >= options.noteSketchMaxChars) break;
  }

  const parts: string[] = [];
  parts.push(`# ${title}`);

  // Keep path low-weight (helps disambiguation in some vaults)
  parts.push(`Path: ${filePath}`);

  const metaBits: string[] = [];
  if (tags.length) metaBits.push(`Tags: ${tags.join(", ")}`);
  if (aliases.length) metaBits.push(`Aliases: ${aliases.join(", ")}`);
  if (type) metaBits.push(`Type: ${type}`);
  if (status) metaBits.push(`Status: ${status}`);
  if (metaBits.length) parts.push(metaBits.join("\n"));

  if (outlineHeadings.length) {
    parts.push(["Outline:", ...outlineHeadings].join("\n"));
  }

  if (sketchBlocks.length) {
    parts.push("Sketch:");
    parts.push(trimToChars(sketchBlocks.join("\n\n"), options.noteSketchMaxChars));
  }

  return parts.join("\n\n").trim();
}

function buildContextHeader(title: string, headingPath: string[], tags: string[]): string {
  const parts: string[] = [];
  parts.push(`# ${title}`);
  if (headingPath.length) {
    parts.push(`## ${headingPath.join(" > ")}`);
  }
  if (tags.length) {
    parts.push(`Tags: ${tags.slice(0, 16).join(", ")}`);
  }
  return parts.join("\n\n");
}

/**
 * Chunk a markdown note into tiered chunks for TSI v2.
 */
export function chunkNoteTiered(
  filePath: string,
  content: string,
  mtimeMs: number,
  metadata: ChunkerMetadata | null,
  opts?: Partial<TieredChunkerOptions>,
): NoteChunk[] {
  const options: TieredChunkerOptions = { ...DEFAULT_OPTIONS, ...(opts ?? {}) };

  const noteId = generateNoteId(filePath);
  const tags = (metadata?.tags ?? []).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "")).filter(Boolean);
  const frontmatter = metadata?.frontmatter ?? {};

  const { titleFromH1, blocks } = parseBlocks(filePath, content);
  const title =
    pickFrontmatterString(frontmatter, "title") || titleFromH1 || normalizeTitleFromPath(filePath);

  const sections = buildSections(noteId, blocks);

  const chunks: NoteChunk[] = [];
  let chunkIndex = 0;

  // Tier 0: note chunk (exactly one)
  const noteTierText = buildNoteTierText(filePath, title, metadata, sections, options);
  const noteChunkId = stableChunkId(noteId, "note", "note");
  chunks.push({
    chunkId: noteChunkId,
    noteId,
    path: filePath,
    title,
    headingPath: [],
    tier: "note",
    kind: "note",
    parentChunkId: null,
    blockRef: null,
    startLine: null,
    endLine: null,
    tokenEstimate: estimateTokens(noteTierText),
    chunkIndex: chunkIndex++,
    text: noteTierText,
    mtimeMs,
    contentHash: generateContentHash(noteTierText),
    tags,
    frontmatter,
  });

  // Tier 1: section chunks
  const sectionIdToChunkId: Map<string, string> = new Map();
  for (const section of sections) {
    const isPreamble = section.level === 0;
    const shouldInclude =
      isPreamble || (section.level >= 1 && section.level <= options.sectionHeadingMaxLevel);
    if (!shouldInclude) continue;

    const body = sectionContentText(section, options.sectionMaxChars);
    if (!body || body.length < options.minChunkChars) continue;

    const header = buildContextHeader(title, section.headingPath, tags);
    const text = trimToChars(`${header}\n\n${body}`.trim(), options.sectionMaxChars + 600);
    const sectionChunkId = stableChunkId(
      noteId,
      "section",
      `${section.headingPath.join(" > ") || "preamble"}@${section.headingLine ?? 0}`,
    );

    sectionIdToChunkId.set(section.id, sectionChunkId);

    const startLine = section.headingLine ?? section.blocks[0]?.startLine ?? null;
    const endLine = section.blocks.length
      ? (section.blocks[section.blocks.length - 1]?.endLine ?? null)
      : null;

    chunks.push({
      chunkId: sectionChunkId,
      noteId,
      path: filePath,
      title,
      headingPath: section.headingPath,
      tier: "section",
      kind: "section",
      parentChunkId: noteChunkId,
      blockRef: null,
      startLine,
      endLine,
      tokenEstimate: estimateTokens(text),
      chunkIndex: chunkIndex++,
      text,
      mtimeMs,
      contentHash: generateContentHash(text),
      tags,
      frontmatter,
    });
  }

  // Tier 2: block chunks
  for (const section of sections) {
    const parentSectionChunkId =
      sectionIdToChunkId.get(section.id) ??
      // If section wasn't included as tier 1 (e.g., deep heading), attach blocks to note chunk.
      noteChunkId;

    for (const block of section.blocks) {
      // Skip tiny/noisy blocks
      if (block.kind === "blank") continue;
      const raw = block.text.trim();
      if (!raw) continue;

      const header = buildContextHeader(title, section.headingPath, tags);
      const base = `${header}\n\n${raw}`.trim();

      const pieces =
        block.kind === "code"
          ? [trimToChars(base, options.blockMaxChars + 600)]
          : splitIntoBudgetedPieces(base, options.blockMaxChars + 600);

      for (let partIdx = 0; partIdx < pieces.length; partIdx++) {
        const part = pieces[partIdx]?.trim();
        if (!part || part.length < options.minChunkChars) continue;

        const anchor = `${section.headingPath.join(" > ") || "preamble"}#${block.blockRef ?? `${block.startLine}-${block.endLine}`}${pieces.length > 1 ? `:${partIdx}` : ""}`;
        const chunkId = stableChunkId(noteId, "block", anchor);

        chunks.push({
          chunkId,
          noteId,
          path: filePath,
          title,
          headingPath: section.headingPath,
          tier: "block",
          kind: block.kind,
          parentChunkId: parentSectionChunkId,
          blockRef: block.blockRef,
          startLine: block.startLine,
          endLine: block.endLine,
          tokenEstimate: estimateTokens(part),
          chunkIndex: chunkIndex++,
          text: part,
          mtimeMs,
          contentHash: generateContentHash(part),
          tags,
          frontmatter,
        });
      }
    }
  }

  return chunks;
}
