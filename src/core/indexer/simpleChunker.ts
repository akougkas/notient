/**
 * Chunk Utilities
 *
 * Utility functions for note/chunk identification and content hashing.
 * Used by tieredSemanticChunker and indexManager.
 */

import { createHash } from "node:crypto";

/**
 * Generate stable note ID from path.
 * Uses SHA256 hash of normalized path for collision resistance.
 */
export function generateNoteId(filePath: string): string {
  const normalized = filePath.toLowerCase().replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate content hash for change detection.
 * Uses normalized content (collapsed whitespace, trimmed) for stable hashing.
 */
export function generateContentHash(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate chunk ID.
 * Uses full text hash to avoid collisions on short content.
 */
export function generateChunkId(noteId: string, chunkIndex: number, text: string): string {
  const hash = createHash("sha256")
    .update(`${noteId}:${chunkIndex}:${text}`)
    .digest("hex")
    .slice(0, 12);
  return `${noteId}-${chunkIndex}-${hash}`;
}

/**
 * Deterministic token estimate proxy.
 * Rough approximation: ~4 chars per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
