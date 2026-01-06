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
      const response = await this.client.embed({
        model,
        input: text,
        truncate: true,
        keep_alive: `${this.kernel.settings.advanced.keepAliveMs}ms`,
      });

      return {
        embedding: response.embeddings[0],
        model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding failed: ${message}`);
    }
  }

  /**
   * Generate embeddings for multiple texts - ONE AT A TIME with timeout
   * This prevents UI freezing by not batching network calls
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

    const embeddings: number[][] = [];
    const TIMEOUT_MS = 30000; // 30 second timeout per embedding

    // Process ONE text at a time to keep UI responsive
    for (const text of texts) {
      try {
        const response = await this.embedWithTimeout(text, model, TIMEOUT_MS);
        embeddings.push(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Embedding failed: ${message}`);
      }
    }

    return {
      embeddings,
      model,
    };
  }

  /**
   * Embed single text with timeout protection
   */
  private async embedWithTimeout(
    text: string,
    model: string,
    timeoutMs: number
  ): Promise<number[]> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.client.embed({
        model,
        input: text,
        truncate: true,
        keep_alive: `${this.kernel.settings.advanced.keepAliveMs}ms`,
      });

      clearTimeout(timeoutId);
      return response.embeddings[0];
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding timed out after ${timeoutMs}ms`);
      }
      throw error;
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

    // Generate test embedding
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    try {
      const response = await this.client.embed({
        model,
        input: "test",
        truncate: true,
      });

      this.modelDimension = response.embeddings[0].length;
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
