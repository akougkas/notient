/**
 * Ollama Reranker Service
 *
 * Dedicated reranking using Qwen3-Reranker via Ollama.
 * Uses the yes/no classification format for relevance scoring.
 *
 * Model: B-A-M-N/Qwen3-Reranker-4B (locked, benchmarked as best)
 */

import type { RankedResult, RerankCandidate } from "../core/llm/types";
import type { Kernel } from "../core/kernel";

/** Default reranker model - locked after benchmarking */
export const DEFAULT_RERANKER_MODEL = "B-A-M-N/Qwen3-Reranker-4B";

/** Qwen3 Reranker prompt configuration */
const QWEN3_PROMPT = {
  system:
    'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".',
  instruction: "Given a query, retrieve relevant passages that answer the query",
};

/**
 * Ollama-based reranker service using Qwen3-Reranker
 */
export class OllamaRerankerService {
  private disposed = false;
  private initialized = false;
  private modelLoaded = false;

  constructor(private kernel: Kernel) {}

  /**
   * Initialize the reranker service
   */
  async initialize(): Promise<void> {
    if (this.disposed) return;

    const settings = this.kernel.settings;
    if (!settings.ollama.enabled) {
      console.log("[OllamaRerankerService] Ollama disabled, reranker unavailable");
      return;
    }

    const model = settings.ollama.rerankModel || DEFAULT_RERANKER_MODEL;
    console.log(`[OllamaRerankerService] Initializing with model=${model}`);

    // Verify model is available
    try {
      const available = await this.checkModelAvailable(model);
      if (!available) {
        console.warn(
          `[OllamaRerankerService] Model ${model} not found. Run: ollama pull ${model}`
        );
        return;
      }
      this.modelLoaded = true;
      this.initialized = true;
      console.log(`[OllamaRerankerService] Ready with model=${model}`);
    } catch (error) {
      console.warn("[OllamaRerankerService] Initialization failed:", error);
    }
  }

  /**
   * Check if reranker model is available
   */
  private async checkModelAvailable(model: string): Promise<boolean> {
    const host = this.kernel.settings.ollama.host.replace(/\/$/, "");
    try {
      const response = await fetch(`${host}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return !this.disposed && this.initialized && this.modelLoaded;
  }

  /**
   * Rerank candidates using Qwen3 reranker
   *
   * @param query - The search query
   * @param candidates - Candidates to rerank
   * @returns Ranked results sorted by relevance
   */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (!this.isReady()) {
      console.warn("[OllamaRerankerService] Not ready, returning vector scores");
      return this.fallbackToVectorScores(candidates);
    }

    if (candidates.length === 0) return [];

    const model = this.kernel.settings.ollama.rerankModel || DEFAULT_RERANKER_MODEL;
    const host = this.kernel.settings.ollama.host.replace(/\/$/, "");

    // Rerank each candidate in parallel with concurrency limit
    const CONCURRENCY = 4;
    const results: RankedResult[] = [];
    const batches = this.chunkArray(candidates, CONCURRENCY);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          try {
            const score = await this.scoreCandidate(host, model, query, candidate);
            return {
              noteId: candidate.noteId,
              path: candidate.path,
              title: candidate.title,
              score,
              reasoning: score >= 0.5 ? "Relevant to query" : "Low relevance",
            };
          } catch (error) {
            console.warn(
              `[OllamaRerankerService] Failed to score candidate: ${error}`
            );
            return {
              noteId: candidate.noteId,
              path: candidate.path,
              title: candidate.title,
              score: candidate.originalScore * 0.8, // Penalty for failed rerank
              reasoning: "Rerank failed, using vector score",
            };
          }
        })
      );
      results.push(...batchResults);
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Score a single candidate using Qwen3 reranker
   */
  private async scoreCandidate(
    host: string,
    model: string,
    query: string,
    candidate: RerankCandidate
  ): Promise<number> {
    // Build Qwen3 reranker prompt
    const prompt = this.buildQwen3Prompt(query, candidate.text);

    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        raw: true,
        options: {
          temperature: 0,
          num_predict: 5, // Only need "yes" or "no"
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    const answer = (data.response || "").toLowerCase().trim();

    // Parse yes/no to score
    if (answer.startsWith("yes")) {
      return 1.0;
    } else if (answer.startsWith("no")) {
      return 0.0;
    } else {
      // Ambiguous response - use conservative score
      console.warn(
        `[OllamaRerankerService] Unexpected response: "${answer}", using 0.3`
      );
      return 0.3;
    }
  }

  /**
   * Build Qwen3 reranker prompt
   */
  private buildQwen3Prompt(query: string, document: string): string {
    // Truncate document if too long (max ~2000 chars for efficiency)
    const maxDocLen = 2000;
    const truncatedDoc =
      document.length > maxDocLen
        ? document.slice(0, maxDocLen).trimEnd() + "..."
        : document;

    return `<|im_start|>system
${QWEN3_PROMPT.system}
<|im_end|>
<|im_start|>user
<Instruct>: ${QWEN3_PROMPT.instruction}
<Query>: ${query}
<Document>: ${truncatedDoc}
<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
  }

  /**
   * Fallback to vector similarity scores
   */
  private fallbackToVectorScores(candidates: RerankCandidate[]): RankedResult[] {
    return candidates.map((c) => ({
      noteId: c.noteId,
      path: c.path,
      title: c.title,
      score: c.originalScore,
      reasoning: "Vector similarity (reranker unavailable)",
    }));
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Dispose the service
   */
  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    this.modelLoaded = false;
  }
}
