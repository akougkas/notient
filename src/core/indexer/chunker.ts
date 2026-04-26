import type { Chunk } from "./types";

export interface ChunkerOptions {
  targetTokens?: number;
  maxTokens?: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_MAX = 800;

export async function chunkNote(
  notePath: string,
  body: string,
  opts: ChunkerOptions = {},
): Promise<Chunk[]> {
  const target = opts.targetTokens ?? DEFAULT_TARGET;
  const max = opts.maxTokens ?? DEFAULT_MAX;
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const segments: string[] = [];
  for (const para of paragraphs) {
    if (estimateTokens(para) <= max) {
      segments.push(para);
    } else {
      for (const piece of hardSplit(para, max)) segments.push(piece);
    }
  }

  const merged: string[] = [];
  let buffer = "";
  let bufferTokens = 0;
  for (const seg of segments) {
    const segTokens = estimateTokens(seg);
    if (buffer.length === 0) {
      buffer = seg;
      bufferTokens = segTokens;
      continue;
    }
    if (bufferTokens + segTokens + 2 <= target) {
      buffer = `${buffer}\n\n${seg}`;
      bufferTokens += segTokens + 2;
    } else {
      merged.push(buffer);
      buffer = seg;
      bufferTokens = segTokens;
    }
  }
  if (buffer.length > 0) merged.push(buffer);

  const chunks: Chunk[] = [];
  for (let ord = 0; ord < merged.length; ord++) {
    const text = merged[ord];
    const id = (await sha256(`${notePath}\n${ord}\n${text}`)).slice(0, 16);
    const sha = await sha256(text);
    chunks.push({ id, notePath, ord, text, sha, tokenEstimate: estimateTokens(text) });
  }
  return chunks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hardSplit(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let buf = "";
  let bufTokens = 0;
  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    if (t > maxTokens) {
      if (buf.length > 0) {
        out.push(buf.trim());
        buf = "";
        bufTokens = 0;
      }
      // Sentence itself larger than maxTokens, slice on whitespace.
      const charsPerToken = 4;
      const sliceSize = maxTokens * charsPerToken;
      for (let i = 0; i < sentence.length; i += sliceSize) {
        out.push(sentence.slice(i, i + sliceSize).trim());
      }
      continue;
    }
    if (bufTokens + t > maxTokens) {
      out.push(buf.trim());
      buf = sentence;
      bufTokens = t;
    } else {
      buf += sentence;
      bufTokens += t;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
