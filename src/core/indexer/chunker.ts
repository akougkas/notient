import type { Chunk } from "./types";

export interface ChunkerOptions {
  targetTokens?: number;
  maxTokens?: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_MAX = 800;
const CHARS_PER_TOKEN = 4;
const PARAGRAPH_JOIN_TOKEN_OVERHEAD = 2;

function estimateTokens(text: string): number {
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
    const sentenceTokens = estimateTokens(sentence);
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
    if (estimateTokens(paragraph) <= maxTokens) {
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
    const segmentTokens = estimateTokens(segment);
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
  return { id, notePath, ord, text, sha, tokenEstimate: estimateTokens(text) };
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
