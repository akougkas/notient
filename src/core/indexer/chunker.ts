import type { BlockSpec } from "../markdown/types";
/**
 * AST-aware content chunker. It consumes the Markdown extractor's BlockSpec
 * output, groups blocks into heading-bounded sections, and splits only when
 * a section exceeds the configured embedding budget.
 */
import { CHUNK } from "./concurrencyDefaults";

export interface ChunkSpec {
  ord: number;
  text: string;
  tokenEstimate: number;
  blockOrd: number | null;
  startLine: number;
  endLine: number;
}

// Sized for a 512-token embedder context (nomic-embed-text-v2-moe and most
// small local embedding models). Anything above that is silently truncated by
// the server, so the tail of an oversized chunk would never reach the vector.
const CHARS_PER_TOKEN = 4;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Section {
  blockOrd: number | null;
  startLine: number;
  endLine: number;
  text: string;
}

function buildSections(blocks: BlockSpec[]): Section[] {
  const sections: Section[] = [];

  for (const block of blocks) {
    if (block.headingLevel !== null) {
      sections.push({
        blockOrd: block.ord,
        startLine: block.startLine,
        endLine: block.endLine,
        text: block.text,
      });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current === undefined) {
      sections.push({
        blockOrd: null,
        startLine: block.startLine,
        endLine: block.endLine,
        text: block.text,
      });
      continue;
    }
    if (block.text.length > 0) {
      current.text = current.text.length > 0 ? `${current.text}\n\n${block.text}` : block.text;
    }
    if (block.startLine < current.startLine || current.startLine === 0) {
      current.startLine = block.startLine;
    }
    if (block.endLine > current.endLine) {
      current.endLine = block.endLine;
    }
  }

  return sections;
}

function hardSplitBySpaces(sentence: string, maxTokens: number): string[] {
  const words = sentence.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const out: string[] = [];
  let buffer = "";
  for (const word of words) {
    const candidate = buffer.length === 0 ? word : `${buffer} ${word}`;
    if (tokenEstimate(candidate) > maxTokens && buffer.length > 0) {
      out.push(buffer);
      buffer = word;
      continue;
    }
    buffer = candidate;
    if (tokenEstimate(buffer) > maxTokens) {
      const sliceSize = maxTokens * CHARS_PER_TOKEN;
      for (let index = 0; index < buffer.length; index += sliceSize) {
        out.push(buffer.slice(index, index + sliceSize));
      }
      buffer = "";
    }
  }
  if (buffer.length > 0) {
    out.push(buffer);
  }
  return out;
}

export interface ChunkBlockSizes {
  /** Soft cap; sections under this size are emitted as a single chunk. */
  targetTokens: number;
  /** Hard cap; sentences over this size are split by spaces. */
  maxTokens: number;
}

function packSection(text: string, sizes: ChunkBlockSizes): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (tokenEstimate(trimmed) <= sizes.targetTokens) {
    return [trimmed];
  }

  const sentences = trimmed.split(SENTENCE_BOUNDARY).filter((sentence) => sentence.length > 0);
  const out: string[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(buffer);
      buffer = "";
    }
  };

  for (const sentence of sentences) {
    if (tokenEstimate(sentence) > sizes.maxTokens) {
      flush();
      for (const piece of hardSplitBySpaces(sentence, sizes.maxTokens)) {
        out.push(piece);
      }
      continue;
    }
    const candidate = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    if (tokenEstimate(candidate) <= sizes.targetTokens) {
      buffer = candidate;
    } else {
      flush();
      buffer = sentence;
    }
  }
  flush();
  return out;
}

/**
 * Inline HTML (MathML from arXiv clippings, <sup>, <table>) is noise for
 * both BM25 and embeddings, and markup tokenizes at roughly one token per
 * character, which blows past a 512-token embedder while the chars/4
 * estimate still reads well under budget. Strip tags, keep their text.
 * Autolinks such as <https://x> are not tags and survive.
 */
export function stripHtmlTags(text: string): string {
  if (!text.includes("<")) return text;
  const { masked, restore } = maskMarkdownCode(text);
  const stripped = masked
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return restore(stripped);
}

interface Fence {
  marker: "`" | "~";
  length: number;
  start: number;
}

interface TextRange {
  start: number;
  end: number;
}

function fenceStart(line: string, start: number): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) return null;
  const run = match[1];
  return { marker: run[0] as "`" | "~", length: run.length, start };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length;
}

function fencedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let fence: Fence | null = null;
  for (const match of text.matchAll(linePattern)) {
    if (match[0].length === 0) continue;
    const start = match.index;
    const line = match[0].replace(/(?:\r\n|\n|\r)$/, "");
    if (fence === null) {
      fence = fenceStart(line, start);
      continue;
    }
    if (closesFence(line, fence)) {
      ranges.push({ start: fence.start, end: start + match[0].length });
      fence = null;
    }
  }
  if (fence !== null) ranges.push({ start: fence.start, end: text.length });
  return ranges;
}

function maskMarkdownCode(text: string): {
  masked: string;
  restore(value: string): string;
} {
  const protectedText: string[] = [];
  let tokenPrefix = "\u{e000}notient-code-";
  while (text.includes(tokenPrefix)) tokenPrefix += "x";
  const stash = (value: string): string => {
    const token = `${tokenPrefix}${protectedText.length}\u{e001}`;
    protectedText.push(value);
    return token;
  };
  const maskInline = (value: string): string => value.replace(/(`+)[\s\S]*?\1/g, stash);

  const output: string[] = [];
  let cursor = 0;
  for (const range of fencedRanges(text)) {
    output.push(maskInline(text.slice(cursor, range.start)));
    output.push(stash(text.slice(range.start, range.end)));
    cursor = range.end;
  }
  output.push(maskInline(text.slice(cursor)));

  return {
    masked: output.join(""),
    restore(value: string): string {
      let restored = value;
      for (let index = 0; index < protectedText.length; index += 1) {
        restored = restored.replace(`${tokenPrefix}${index}\u{e001}`, protectedText[index]);
      }
      return restored;
    },
  };
}

export function chunkBlocks(blocks: BlockSpec[], sizes?: ChunkBlockSizes): ChunkSpec[] {
  if (blocks.length === 0) {
    return [];
  }
  const resolvedSizes: ChunkBlockSizes = {
    targetTokens: sizes?.targetTokens ?? CHUNK.targetTokens,
    maxTokens: sizes?.maxTokens ?? CHUNK.maxTokens,
  };
  const sections = buildSections(blocks);
  const specs: ChunkSpec[] = [];
  let ord = 0;
  for (const section of sections) {
    const pieces = packSection(stripHtmlTags(section.text), resolvedSizes);
    for (const piece of pieces) {
      // Hard invariant: no chunk leaves the chunker above `maxTokens`. A
      // single huge paragraph or fenced code block with no sentence
      // boundaries can still slip past the packer, and an oversized chunk is
      // silently truncated by the embedding server, so the tail would never
      // make it into the vector. Splitting at a `maxTokens` boundary keeps
      // the whole text reachable.
      for (const bounded of enforceMaxTokens(piece, resolvedSizes.maxTokens)) {
        specs.push({
          ord,
          text: bounded,
          tokenEstimate: tokenEstimate(bounded),
          blockOrd: section.blockOrd,
          startLine: section.startLine,
          endLine: section.endLine,
        });
        ord += 1;
      }
    }
  }
  return specs;
}

function enforceMaxTokens(text: string, maxTokens: number): string[] {
  if (tokenEstimate(text) <= maxTokens) {
    return [text];
  }
  const sliceSize = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  const out: string[] = [];
  for (let index = 0; index < text.length; index += sliceSize) {
    const slice = text.slice(index, index + sliceSize).trim();
    if (slice.length > 0) out.push(slice);
  }
  return out.length > 0 ? out : [text];
}
