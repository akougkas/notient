/**
 * Ollama Reranker Service
 *
 * Uses Qwen-based reranker models that output SCORE lines.
 * Parses "SCORE: N" format (N = 0, 3, 7, or 10).
 */

import { Ollama } from "ollama";
import type { Kernel } from "../core/kernel";

export interface RerankCandidate {
  id: string;
  text: string;
  score?: number; // Original score (e.g., from vector search)
}

export interface RankedResult {
  id: string;
  score: number;
  reasoning?: string;
}

/**
 * Reranker service using Ollama with Qwen-based reranker models
 */
export class OllamaReranker {
  private client: Ollama | null = null;
  private disposed = false;

  constructor(private kernel: Kernel) {}

  /**
   * Initialize the reranker
   */
  async initialize(): Promise<void> {
    const settings = this.kernel.settings;

    if (!settings.ollama.enabled) {
      console.log("[OllamaReranker] Ollama is disabled");
      return;
    }

    this.client = new Ollama({
      host: settings.ollama.host,
    });

    console.log(`[OllamaReranker] Initialized with model=${settings.ollama.rerankModel}`);
  }

  /**
   * Check if reranker is available
   */
  isReady(): boolean {
    return !this.disposed && this.client !== null;
  }

  /**
   * Rerank candidates by relevance to query
   *
   * The reranker model outputs lines like:
   * "SCORE: 7" (where score is 0, 3, 7, or 10)
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (!this.client) {
      console.warn("[OllamaReranker] Client not initialized, falling back to original scores");
      return this.fallbackToOriginalScores(candidates);
    }

    if (candidates.length === 0) {
      return [];
    }

    const model = this.kernel.settings.ollama.rerankModel;
    if (!model) {
      console.warn("[OllamaReranker] No rerank model configured");
      return this.fallbackToOriginalScores(candidates);
    }

    const results: RankedResult[] = [];

    // Process each candidate individually (reranker models work best this way)
    for (const candidate of candidates) {
      try {
        const score = await this.scoreCandidate(query, candidate.text, model);
        results.push({
          id: candidate.id,
          score: score / 10, // Normalize to 0-1 range
        });
      } catch (error) {
        console.warn(`[OllamaReranker] Failed to score candidate ${candidate.id}:`, error);
        // Fallback to original score or 0
        results.push({
          id: candidate.id,
          score: candidate.score ?? 0,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Score a single candidate against the query
   */
  private async scoreCandidate(query: string, text: string, model: string): Promise<number> {
    if (!this.client) throw new Error("Client not initialized");

    // Format prompt for Qwen reranker
    const prompt = `Query: ${query}\n\nDocument: ${text}\n\nRate the relevance of this document to the query. Output only: SCORE: N (where N is 0, 3, 7, or 10)`;

    const response = await this.client.generate({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 20, // Short response expected
      },
    });

    return this.parseScore(response.response);
  }

  /**
   * Parse SCORE from model output
   *
   * Expected format: "SCORE: N" where N is 0, 3, 7, or 10
   * Falls back to 0 if no match found
   */
  private parseScore(output: string): number {
    const match = output.match(/SCORE:\s*(\d+)/i);
    if (!match) {
      console.warn(`[OllamaReranker] No SCORE found in output: "${output.slice(0, 50)}..."`);
      return 0;
    }

    const score = Number.parseInt(match[1], 10);

    // Clamp to valid range
    if (score < 0) return 0;
    if (score > 10) return 10;

    return score;
  }

  /**
   * Fallback when reranker is unavailable
   */
  private fallbackToOriginalScores(candidates: RerankCandidate[]): RankedResult[] {
    return candidates.map((c) => ({
      id: c.id,
      score: c.score ?? 0,
    }));
  }

  /**
   * Batch rerank with concurrency limit
   */
  async rerankBatch(
    query: string,
    candidates: RerankCandidate[],
    options: { concurrency?: number; limit?: number } = {},
  ): Promise<RankedResult[]> {
    const { concurrency = 4, limit = 25 } = options;

    // Only rerank top candidates
    const topCandidates = candidates.slice(0, limit);

    if (!this.client) {
      return this.fallbackToOriginalScores(topCandidates);
    }

    const model = this.kernel.settings.ollama.rerankModel;
    if (!model) {
      return this.fallbackToOriginalScores(topCandidates);
    }

    const results: RankedResult[] = new Array(topCandidates.length);
    let nextIndex = 0;

    // Worker function
    const worker = async () => {
      while (nextIndex < topCandidates.length) {
        const idx = nextIndex++;
        const candidate = topCandidates[idx];
        try {
          const score = await this.scoreCandidate(query, candidate.text, model);
          results[idx] = {
            id: candidate.id,
            score: score / 10,
          };
        } catch {
          results[idx] = {
            id: candidate.id,
            score: candidate.score ?? 0,
          };
        }
      }
    };

    // Run with concurrency limit
    const workers = Array(Math.min(concurrency, topCandidates.length))
      .fill(null)
      .map(() => worker());
    await Promise.all(workers);

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Dispose the service
   */
  dispose(): void {
    this.disposed = true;
    this.client = null;
  }
}
