/**
 * Vector Store Stub for Notient
 * Interface for HNSW vector storage with similarity search.
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import type { EmbeddingVector } from "./embeddings";

/**
 * A search result from the vector store.
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Vector store interface.
 * Implementations handle actual HNSW operations.
 */
export interface VectorStore {
  /** Add a vector with associated ID */
  add(id: string, vector: EmbeddingVector): void;
  /** Remove a vector by ID */
  remove(id: string): void;
  /** Search for similar vectors */
  search(query: EmbeddingVector, topK: number): VectorSearchResult[];
  /** Get total vector count */
  size(): number;
  /** Clear all vectors */
  clear(): void;
  /** Check if initialized */
  isReady(): boolean;
}

/**
 * Stub Vector Store
 *
 * Placeholder implementation for MVP.
 * Will be replaced with HNSW WASM integration.
 * Uses linear scan for correctness testing.
 */
export class StubVectorStore implements VectorStore {
  private vectors = new Map<string, EmbeddingVector>();

  add(id: string, vector: EmbeddingVector): void {
    this.vectors.set(id, vector);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(query: EmbeddingVector, topK: number): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const [id, vector] of this.vectors) {
      const score = this.cosineSimilarity(query, vector);
      results.push({ id, score });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.vectors.clear();
  }

  isReady(): boolean {
    return true;
  }

  private cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
