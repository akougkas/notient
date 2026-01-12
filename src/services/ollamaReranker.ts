/**
 * Ollama Reranker Service
 *
 * LLM-based reranking for search results using Qwen3-Reranker via Ollama.
 *
 * STATUS: DISABLED - Returns vector scores directly.
 *
 * WHY DISABLED:
 * The previous implementation made N sequential LLM calls (one per candidate).
 * With 13+ candidates per search, this caused:
 * - 100% CPU utilization
 * - UI freeze for 10-30 seconds
 * - Poor user experience
 *
 * TO RE-ENABLE:
 * Implement batch reranking - send all candidates in ONE LLM call.
 * The Qwen3-Reranker model supports batch scoring format.
 * See: https://huggingface.co/B-A-M-N/Qwen3-Reranker-4B
 */

import type { Kernel } from "../core/kernel";
import type { RankedResult, RerankCandidate } from "../core/llm/types";

export const DEFAULT_RERANKER_MODEL = "B-A-M-N/Qwen3-Reranker-4B";

export class OllamaRerankerService {
  private disposed = false;
  private initialized = false;
  private modelLoaded = false;

  constructor(private kernel: Kernel) {}

  async initialize(): Promise<void> {
    if (this.disposed) return;

    const settings = this.kernel.settings;
    if (!settings.ollama.enabled) {
      return;
    }

    const model = settings.ollama.rerankModel || DEFAULT_RERANKER_MODEL;

    try {
      const available = await this.checkModelAvailable(model);
      if (available) {
        this.modelLoaded = true;
        this.initialized = true;
      }
    } catch {
      // Model check failed - service remains unavailable
    }
  }

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

  isReady(): boolean {
    return !this.disposed && this.initialized && this.modelLoaded;
  }

  /**
   * Rerank candidates by relevance to query.
   *
   * Currently returns vector scores directly (LLM reranking disabled).
   * When re-enabled, will use batch LLM scoring for efficiency.
   */
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    if (candidates.length === 0) return [];

    // TODO: Implement batch reranking (one LLM call for all candidates)
    return candidates.map((candidate) => ({
      noteId: candidate.noteId,
      path: candidate.path,
      title: candidate.title,
      score: candidate.originalScore,
      reasoning: "Vector similarity",
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    this.modelLoaded = false;
  }
}
