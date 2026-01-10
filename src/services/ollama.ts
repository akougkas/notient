/**
 * Ollama Embeddings Service
 *
 * Wrapper around the Ollama JS SDK for generating embeddings.
 * Discovers model capabilities at runtime via /api/show.
 * Restricts to localhost only for privacy.
 */

import { Ollama } from "ollama";
import { MODEL_DEFAULTS } from "../core/constants";
import type { Kernel } from "../core/kernel";

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
 * Discovered model capabilities from Ollama /api/show
 */
export interface ModelCapabilities {
  /** Model name */
  model: string;
  /** Embedding vector dimension */
  embeddingDimension: number;
  /** Maximum context length in tokens */
  contextLength: number;
  /** Model architecture family (e.g., "bert", "nomic_bert", "llama") */
  architecture: string | null;
  /** Whether capabilities were discovered or using fallbacks */
  discovered: boolean;
}

/**
 * Ollama embeddings service with runtime capability discovery
 */
export class OllamaService {
  private client: Ollama | null = null;
  private disposed = false;
  /** Cached model capabilities - discovered at initialization */
  private capabilities: ModelCapabilities | null = null;

  constructor(private kernel: Kernel) {}

  /**
   * Initialize the service and discover model capabilities
   */
  async initialize(): Promise<void> {
    const settings = this.kernel.settings;

    if (!settings.ollama.enabled) {
      console.log("[OllamaService] Ollama is disabled");
      return;
    }

    const model = settings.ollama.embeddingModel;
    console.log(`[OllamaService] Initializing with host=${settings.ollama.host}, model=${model}`);

    this.client = new Ollama({
      host: settings.ollama.host,
    });

    // Discover model capabilities at initialization
    if (model) {
      this.capabilities = await this.discoverCapabilities(model);
      console.log(
        `[OllamaService] Model capabilities: dim=${this.capabilities.embeddingDimension}, ` +
          `ctx=${this.capabilities.contextLength}, discovered=${this.capabilities.discovered}`,
      );
      console.log(`[OllamaService] Model key will be: ${this.getModelKey()}`);
    } else {
      console.warn("[OllamaService] No embedding model configured!");
    }
  }

  /**
   * Discover model capabilities via Ollama /api/show endpoint.
   * Falls back to conservative defaults if discovery fails.
   */
  private async discoverCapabilities(model: string): Promise<ModelCapabilities> {
    const host = this.kernel.settings.ollama.host.replace(/\/$/, "");

    try {
      const response = await fetch(`${host}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });

      if (!response.ok) {
        console.warn(`[OllamaService] /api/show failed: ${response.status}, using fallbacks`);
        return this.fallbackCapabilities(model);
      }

      const data = await response.json();
      const modelInfo = data.model_info || {};

      // Extract capabilities from model_info - keys are prefixed with model family
      // e.g., "bert.context_length", "bert.embedding_length", "nomic_bert.context_length"
      let contextLength: number | null = null;
      let embeddingDimension: number | null = null;
      let architecture: string | null = null;

      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith(".context_length") && typeof value === "number") {
          contextLength = value;
          // Extract architecture from key prefix (e.g., "bert" from "bert.context_length")
          architecture = key.split(".")[0];
        }
        if (key.endsWith(".embedding_length") && typeof value === "number") {
          embeddingDimension = value;
          if (!architecture) {
            architecture = key.split(".")[0];
          }
        }
      }

      // Also check general_architecture field if present
      if (!architecture && modelInfo["general.architecture"]) {
        architecture = String(modelInfo["general.architecture"]);
      }

      // If we couldn't find capabilities in model_info, probe with a test embedding
      if (embeddingDimension === null) {
        embeddingDimension = await this.probeEmbeddingDimension(model);
      }

      // Use discovered values or fallbacks
      const caps: ModelCapabilities = {
        model,
        embeddingDimension: embeddingDimension ?? MODEL_DEFAULTS.FALLBACK_EMBEDDING_DIMENSION,
        contextLength: contextLength ?? MODEL_DEFAULTS.FALLBACK_CONTEXT_TOKENS,
        architecture,
        discovered: contextLength !== null || embeddingDimension !== null,
      };

      // Calculate effective max chars for this model
      const charsPerToken = caps.architecture?.toLowerCase().includes("bert")
        ? 2.5
        : MODEL_DEFAULTS.CHARS_PER_TOKEN;
      const maxChars = Math.floor(caps.contextLength * charsPerToken * 0.8);
      console.log(
        `[OllamaService] Discovered ${model}: arch=${caps.architecture}, ctx=${caps.contextLength}, dim=${caps.embeddingDimension}, maxChars=${maxChars}`,
      );
      return caps;
    } catch (error) {
      console.warn(`[OllamaService] Discovery failed for ${model}:`, error);
      return this.fallbackCapabilities(model);
    }
  }

  /**
   * Probe embedding dimension by generating a test embedding
   */
  private async probeEmbeddingDimension(model: string): Promise<number | null> {
    try {
      const embeddings = await this.embedRequest("test", model, { timeoutMs: 15000 });
      return embeddings[0]?.length ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Create fallback capabilities when discovery fails
   */
  private fallbackCapabilities(model: string): ModelCapabilities {
    return {
      model,
      embeddingDimension: MODEL_DEFAULTS.FALLBACK_EMBEDDING_DIMENSION,
      contextLength: MODEL_DEFAULTS.FALLBACK_CONTEXT_TOKENS,
      architecture: null,
      discovered: false,
    };
  }

  /**
   * Get chars-per-token ratio based on model architecture.
   * BERT-based models use WordPiece tokenization (~2.5-3 chars/token).
   * Modern models like nomic use ~4 chars/token.
   */
  private getCharsPerToken(): number {
    const arch = this.capabilities?.architecture?.toLowerCase() ?? "";
    // BERT-based architectures use more aggressive tokenization
    if (arch.includes("bert")) {
      return 2.5; // Conservative for WordPiece tokenization
    }
    // Default for other architectures
    return MODEL_DEFAULTS.CHARS_PER_TOKEN;
  }

  /**
   * Get current model capabilities (discovered or fallback)
   */
  getCapabilities(): ModelCapabilities | null {
    return this.capabilities;
  }

  /**
   * Generate embedding for a single text (used for search queries).
   * Has longer timeout and retry logic since search should work even during indexing.
   *
   * @throws Error if embedding fails after retries
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

    // Retry with longer timeout for search during heavy indexing
    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 60000; // 60s for search queries

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return {
          embedding: (await this.embedRequest(text, model, { timeoutMs: TIMEOUT_MS }))[0],
          model,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = message.includes("timed out");
        const isConnectionError =
          message.includes("fetch failed") || message.includes("ECONNREFUSED");

        if ((isTimeout || isConnectionError) && attempt < MAX_RETRIES) {
          const delay = Math.min(500 * Math.pow(2, attempt), 2000); // Exponential backoff, max 2s
          console.log(
            `[OllamaService] Embed failed (${isTimeout ? "timeout" : "connection"}), ` +
              `retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw new Error(`Embedding failed: ${message}`);
      }
    }

    throw new Error("Embedding failed after retries");
  }

  /**
   * Try to generate embedding, returning null on failure (graceful degradation).
   * Use this for search operations where fallback to native search is acceptable.
   *
   * @param text - Text to embed
   * @returns Embedding result or null if unavailable
   */
  async tryEmbed(text: string): Promise<EmbeddingResult | null> {
    try {
      return await this.embed(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OllamaService] tryEmbed failed: ${message}`);
      return null;
    }
  }

  /**
   * Generate embeddings for multiple texts in a single Ollama `/api/embed` call.
   * Uses discovered model capabilities to truncate appropriately.
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

    // Use discovered context length or conservative fallback
    const contextTokens =
      this.capabilities?.contextLength ?? MODEL_DEFAULTS.FALLBACK_CONTEXT_TOKENS;
    // Convert to chars using architecture-aware ratio with 20% safety margin
    const charsPerToken = this.getCharsPerToken();
    const maxChars = Math.floor(contextTokens * charsPerToken * 0.8);

    const truncatedTexts = texts.map((text) => {
      if (text.length > maxChars) {
        // Truncate at word boundary if possible
        const truncated = text.slice(0, maxChars);
        const lastSpace = truncated.lastIndexOf(" ");
        return lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated;
      }
      return text;
    });

    return {
      embeddings: await this.embedRequest(truncatedTexts, model, {
        timeoutMs: 30000,
        contextTokens,
      }),
      model,
    };
  }

  /**
   * Direct Ollama embed call with timeout + abort support.
   * Passes num_ctx option to request appropriate context window.
   */
  private async embedRequest(
    input: string | string[],
    model: string,
    options: { timeoutMs: number; signal?: AbortSignal; contextTokens?: number },
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
          // Pass num_ctx to request appropriate context window for the model
          ...(options.contextTokens && { options: { num_ctx: options.contextTokens } }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Ollama /api/embed failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
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
   * Get the current model's embedding dimension (from discovered capabilities)
   */
  async getDimension(): Promise<number> {
    return this.capabilities?.embeddingDimension ?? MODEL_DEFAULTS.FALLBACK_EMBEDDING_DIMENSION;
  }

  /**
   * Get the model key for the current configuration
   * Used for scoping vector store storage
   */
  getModelKey(): string {
    const model = this.kernel.settings.ollama.embeddingModel;
    if (!model) {
      throw new Error(
        "Cannot generate model key: no embedding model configured. " +
          "Please set an embedding model in Notient settings.",
      );
    }
    const dim = this.capabilities?.embeddingDimension ?? "unknown";
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
