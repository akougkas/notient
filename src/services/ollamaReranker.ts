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

import { Ollama } from "ollama";
import type { Kernel } from "../core/kernel";
import type { RankedResult, RerankCandidate } from "../core/llm/types";

export const DEFAULT_RERANKER_MODEL = "B-A-M-N/Qwen3-Reranker-4B";

export class OllamaRerankerService {
  private client: Ollama | null = null;
  private disposed = false;
  private initialized = false;
  private modelLoaded = false;

  constructor(private kernel: Kernel) {
    console.log("[ollamaReranker:constructor] TRACE: START");
    console.log("[ollamaReranker:constructor] TRACE: END");
  }

  async initialize(): Promise<void> {
    console.log("[ollamaReranker:initialize] TRACE: START");
    if (this.disposed) {
      console.log("[ollamaReranker:initialize] TRACE: END (disposed)");
      return;
    }

    const settings = this.kernel.settings;
    if (!settings.ollama.enabled) {
      console.log("[ollamaReranker:initialize] TRACE: END (ollama disabled)");
      return;
    }

    console.log(
      `[ollamaReranker:initialize] TRACE: creating Ollama client with host=${settings.ollama.host}`,
    );
    this.client = new Ollama({ host: settings.ollama.host });
    const model = settings.ollama.rerankModel || DEFAULT_RERANKER_MODEL;
    console.log(`[ollamaReranker:initialize] TRACE: model=${model}`);

    try {
      console.log("[ollamaReranker:initialize] TRACE: checking model availability");
      const available = await this.checkModelAvailable(model);
      console.log(`[ollamaReranker:initialize] TRACE: model available=${available}`);
      if (available) {
        this.modelLoaded = true;
        this.initialized = true;
      }
    } catch (error) {
      console.log(`[ollamaReranker:initialize] TRACE: model check failed: ${error}`);
      // Model check failed - service remains unavailable
    }
    console.log("[ollamaReranker:initialize] TRACE: END");
  }

  private async checkModelAvailable(model: string): Promise<boolean> {
    console.log("[ollamaReranker:checkModelAvailable] TRACE: START");
    console.log(`[ollamaReranker:checkModelAvailable] TRACE: model=${model}`);
    if (!this.client) {
      console.log("[ollamaReranker:checkModelAvailable] TRACE: END (no client)");
      return false;
    }
    try {
      console.log("[ollamaReranker:checkModelAvailable] TRACE: calling client.show");
      await this.client.show({ model });
      console.log("[ollamaReranker:checkModelAvailable] TRACE: client.show returned");
      console.log("[ollamaReranker:checkModelAvailable] TRACE: END (true)");
      return true;
    } catch (error) {
      console.log(`[ollamaReranker:checkModelAvailable] TRACE: error: ${error}`);
      console.log("[ollamaReranker:checkModelAvailable] TRACE: END (false)");
      return false;
    }
  }

  isReady(): boolean {
    console.log("[ollamaReranker:isReady] TRACE: START");
    const result = !this.disposed && this.initialized && this.modelLoaded;
    console.log(`[ollamaReranker:isReady] TRACE: returning ${result}`);
    console.log("[ollamaReranker:isReady] TRACE: END");
    return result;
  }

  /**
   * Rerank candidates by relevance to query.
   *
   * Currently returns vector scores directly (LLM reranking disabled).
   * When re-enabled, will use batch LLM scoring for efficiency.
   */
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<RankedResult[]> {
    console.log("[ollamaReranker:rerank] TRACE: START");
    console.log(
      `[ollamaReranker:rerank] TRACE: query.length=${_query.length}, candidates.length=${candidates.length}`,
    );
    if (candidates.length === 0) {
      console.log("[ollamaReranker:rerank] TRACE: END (no candidates)");
      return [];
    }

    // TODO: Implement batch reranking (one LLM call for all candidates)
    console.log("[ollamaReranker:rerank] TRACE: returning vector scores (LLM reranking disabled)");
    const result = candidates.map((candidate) => ({
      noteId: candidate.noteId,
      path: candidate.path,
      title: candidate.title,
      score: candidate.originalScore,
      reasoning: "Vector similarity",
    }));
    console.log(`[ollamaReranker:rerank] TRACE: returning ${result.length} results`);
    console.log("[ollamaReranker:rerank] TRACE: END");
    return result;
  }

  dispose(): void {
    console.log("[ollamaReranker:dispose] TRACE: START");
    this.disposed = true;
    this.initialized = false;
    this.modelLoaded = false;
    console.log("[ollamaReranker:dispose] TRACE: END");
  }
}
