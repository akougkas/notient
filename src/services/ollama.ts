/**
 * Ollama Embeddings Service
 * 
 * Wrapper around the Ollama JS SDK for generating embeddings.
 * Restricts to localhost only for privacy.
 */

import { Ollama } from "ollama";
import type { Kernel } from "../core/kernel";
import { MODEL_DEFAULTS } from "../core/constants";

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  promptTokens?: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  model: string;
}

/**
 * Ollama embeddings service
 */
export class OllamaService {
  private client: Ollama | null = null;
  private modelDimension: number | null = null;
  private disposed = false;

  constructor(private kernel: Kernel) {}

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    const settings = this.kernel.settings;
    
    if (!settings.ollama.enabled) {
      console.log("[OllamaService] Ollama is disabled");
      return;
    }

    this.client = new Ollama({
      host: settings.ollama.host,
    });

    // Pre-fetch model dimension
    if (settings.ollama.embeddingModel) {
      await this.detectDimension(settings.ollama.embeddingModel);
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<EmbeddingResult> {
    if (this.disposed) {
      throw new Error("Service is disposed");
    }

    if (!this.client) {
      throw new Error("Ollama client not initialized");
    }

    const model = this.kernel.settings.ollama.embeddingModel;
    if (!model) {
      throw new Error("No embedding model configured");
    }

    try {
      return {
        embedding: (await this.embedRequest(text, model, { timeoutMs: 30000 }))[0],
        model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding failed: ${message}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in a single Ollama `/api/embed` call.
   * Uses a hard timeout to avoid indefinitely stuck requests.
   */
  async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    if (this.disposed) {
      throw new Error("Service is disposed");
    }

    if (!this.client) {
      throw new Error("Ollama client not initialized");
    }

    const model = this.kernel.settings.ollama.embeddingModel;
    if (!model) {
      throw new Error("No embedding model configured");
    }

    if (texts.length === 0) {
      return { embeddings: [], model };
    }

    return {
      embeddings: await this.embedRequest(texts, model, { timeoutMs: 30000 }),
      model,
    };
  }

  /**
   * Direct Ollama embed call with timeout + abort support.
   *
   * We intentionally bypass the Ollama JS SDK here because its `embed()` method
   * does not accept an AbortSignal, making timeouts/cancellation ineffective in
   * long-running vault indexing.
   */
  private async embedRequest(
    input: string | string[],
    model: string,
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<number[][]> {
    const host = this.kernel.settings.ollama.host.replace(/\/$/, "");
    const url = `${host}/api/embed`;

    // Timeout + optional upstream abort
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input,
          truncate: true,
          keep_alive: `${this.kernel.settings.advanced.keepAliveMs}ms`,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Ollama /api/embed failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
        );
      }

      const data = (await response.json()) as { embeddings: number[][] };
      if (!data?.embeddings || !Array.isArray(data.embeddings)) {
        throw new Error("Ollama /api/embed returned invalid response");
      }
      return data.embeddings;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding timed out after ${options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * Get the current model's embedding dimension
   */
  async getDimension(): Promise<number> {
    if (this.modelDimension !== null) {
      return this.modelDimension;
    }

    const model = this.kernel.settings.ollama.embeddingModel;
    return this.detectDimension(model);
  }

  /**
   * Detect embedding dimension by generating a test embedding
   */
  private async detectDimension(model: string): Promise<number> {
    // Check known dimensions first
    const known = MODEL_DEFAULTS.EMBEDDING_DIMENSIONS[model];
    if (known) {
      this.modelDimension = known;
      return known;
    }

    try {
      const embeddings = await this.embedRequest("test", model, { timeoutMs: 15000 });
      this.modelDimension = embeddings[0]?.length ?? 768;
      return this.modelDimension;
    } catch (error) {
      // Default fallback
      console.warn("[OllamaService] Could not detect dimension, using default 768");
      this.modelDimension = 768;
      return this.modelDimension;
    }
  }

  /**
   * Get the model key for the current configuration
   * Used for scoping vector store storage
   */
  getModelKey(): string {
    const model = this.kernel.settings.ollama.embeddingModel;
    const dim = this.modelDimension ?? "unknown";
    // Sanitize for filesystem
    return `${model.replace(/[^a-zA-Z0-9-]/g, "_")}_d${dim}`;
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return !this.disposed && this.client !== null;
  }

  /**
   * Dispose of the service
   */
  dispose(): void {
    this.disposed = true;
    this.client = null;
  }
}
