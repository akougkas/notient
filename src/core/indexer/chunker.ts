import type { BlockSpec } from "../markdown/types";
/**
 * AST-aware chunker.
 *
 * Two surfaces live here during the Phase 3 transition:
 *
 *   chunkNote(notePath, body, opts?) -> Chunk[]
 *     The original SHA-keyed chunker used by the legacy SQLite path.
 *     Phase 3 Task 9 deletes this once the new pipeline is wired.
 *
 *   chunkBlocks(blocks)              -> ChunkSpec[]
 *     The new content-only chunker that consumes the markdown extractor's
 *     BlockSpec output and groups blocks into heading-bounded sections,
 *     splitting only when a section exceeds CHUNK.targetTokens.
 */
import { CHUNK } from "./concurrencyDefaults";
import type { Chunk } from "./types";

export interface ChunkerOptions {
  targetTokens?: number;
  maxTokens?: number;
}

export interface ChunkSpec {
  ord: number;
  text: string;
  tokenEstimate: number;
  blockOrd: number | null;
  startLine: number;
  endLine: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_MAX = 800;
const CHARS_PER_TOKEN = 4;
const PARAGRAPH_JOIN_TOKEN_OVERHEAD = 2;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function sliceOversizedSentence(sentence: string, maxTokens: number): string[] {
  const sliceSize = maxTokens * CHARS_PER_TOKEN;
  const out: string[] = [];
  for (let index = 0; index < sentence.length; index += sliceSize) {
    out.push(sentence.slice(index, index + sliceSize).trim());
  }
  return out;
}

function splitOversizedParagraph(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  const flushBuffer = () => {
    if (buffer.length > 0) {
      out.push(buffer.trim());
      buffer = "";
      bufferTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = tokenEstimate(sentence);
    if (sentenceTokens > maxTokens) {
      flushBuffer();
      for (const piece of sliceOversizedSentence(sentence, maxTokens)) out.push(piece);
      continue;
    }
    if (bufferTokens + sentenceTokens > maxTokens) {
      out.push(buffer.trim());
      buffer = sentence;
      bufferTokens = sentenceTokens;
    } else {
      buffer += sentence;
      bufferTokens += sentenceTokens;
    }
  }
  if (buffer.trim().length > 0) out.push(buffer.trim());
  return out;
}

function expandToSegments(paragraphs: string[], maxTokens: number): string[] {
  const segments: string[] = [];
  for (const paragraph of paragraphs) {
    if (tokenEstimate(paragraph) <= maxTokens) {
      segments.push(paragraph);
    } else {
      for (const piece of splitOversizedParagraph(paragraph, maxTokens)) segments.push(piece);
    }
  }
  return segments;
}

function mergeShortSegments(segments: string[], targetTokens: number): string[] {
  const merged: string[] = [];
  let buffer = "";
  let bufferTokens = 0;
  for (const segment of segments) {
    const segmentTokens = tokenEstimate(segment);
    if (buffer.length === 0) {
      buffer = segment;
      bufferTokens = segmentTokens;
      continue;
    }
    if (bufferTokens + segmentTokens + PARAGRAPH_JOIN_TOKEN_OVERHEAD <= targetTokens) {
      buffer = `${buffer}\n\n${segment}`;
      bufferTokens += segmentTokens + PARAGRAPH_JOIN_TOKEN_OVERHEAD;
    } else {
      merged.push(buffer);
      buffer = segment;
      bufferTokens = segmentTokens;
    }
  }
  if (buffer.length > 0) merged.push(buffer);
  return merged;
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function makeChunkId(notePath: string, ord: number, text: string): Promise<string> {
  return (await sha256(`${notePath}\n${ord}\n${text}`)).slice(0, 16);
}

async function buildChunk(notePath: string, ord: number, text: string): Promise<Chunk> {
  const id = await makeChunkId(notePath, ord, text);
  const sha = await sha256(text);
  return { id, notePath, ord, text, sha, tokenEstimate: tokenEstimate(text) };
}

export async function chunkNote(
  notePath: string,
  body: string,
  opts: ChunkerOptions = {},
): Promise<Chunk[]> {
  const target = opts.targetTokens ?? DEFAULT_TARGET;
  const max = opts.maxTokens ?? DEFAULT_MAX;

  const paragraphs = splitParagraphs(body);
  if (paragraphs.length === 0) return [];

  const segments = expandToSegments(paragraphs, max);
  const merged = mergeShortSegments(segments, target);

  const chunks: Chunk[] = [];
  for (let ord = 0; ord < merged.length; ord++) {
    chunks.push(await buildChunk(notePath, ord, merged[ord]));
  }
  return chunks;
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

function packSection(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (tokenEstimate(trimmed) <= CHUNK.targetTokens) {
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
    if (tokenEstimate(sentence) > CHUNK.maxTokens) {
      flush();
      for (const piece of hardSplitBySpaces(sentence, CHUNK.maxTokens)) {
        out.push(piece);
      }
      continue;
    }
    const candidate = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    if (tokenEstimate(candidate) <= CHUNK.targetTokens) {
      buffer = candidate;
    } else {
      flush();
      buffer = sentence;
    }
  }
  flush();
  return out;
}

export function chunkBlocks(blocks: BlockSpec[]): ChunkSpec[] {
  if (blocks.length === 0) {
    return [];
  }
  const sections = buildSections(blocks);
  const specs: ChunkSpec[] = [];
  let ord = 0;
  for (const section of sections) {
    const pieces = packSection(section.text);
    for (const piece of pieces) {
      specs.push({
        ord,
        text: piece,
        tokenEstimate: tokenEstimate(piece),
        blockOrd: section.blockOrd,
        startLine: section.startLine,
        endLine: section.endLine,
      });
      ord += 1;
    }
  }
  return specs;
}
