/**
 * Ollama Embeddings Service
 *
 * Uses native Ollama JS SDK for generating embeddings.
 * Discovers model capabilities at runtime via /api/show.
 * Restricts to localhost only for privacy.
 *
 * SDK Migration: Now uses ollama.embed() instead of raw fetch.
 * This provides better async handling and error messages.
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
   * Extract capabilities from model_info object.
   * Keys are prefixed with model family (e.g., "bert.context_length").
   */
  private parseModelInfo(modelInfo: Record<string, unknown>): {
    contextLength: number | null;
    embeddingDimension: number | null;
    architecture: string | null;
  } {
    let contextLength: number | null = null;
    let embeddingDimension: number | null = null;
    let architecture: string | null = null;

    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith(".context_length") && typeof value === "number") {
        contextLength = value;
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

    return { contextLength, embeddingDimension, architecture };
  }

  /**
   * Build ModelCapabilities from parsed values, probing for dimension if needed.
   */
  private async buildCapabilities(
    model: string,
    parsed: {
      contextLength: number | null;
      embeddingDimension: number | null;
      architecture: string | null;
    },
  ): Promise<ModelCapabilities> {
    const { contextLength, architecture } = parsed;
    let { embeddingDimension } = parsed;

    // If we couldn't find dimension in model_info, probe with a test embedding
    if (embeddingDimension === null) {
      embeddingDimension = await this.probeEmbeddingDimension(model);
    }

    const caps: ModelCapabilities = {
      model,
      embeddingDimension: embeddingDimension ?? MODEL_DEFAULTS.FALLBACK_EMBEDDING_DIMENSION,
      contextLength: contextLength ?? MODEL_DEFAULTS.FALLBACK_CONTEXT_TOKENS,
      architecture,
      discovered: contextLength !== null || embeddingDimension !== null,
    };

    const charsPerToken = caps.architecture?.toLowerCase().includes("bert")
      ? 2.5
      : MODEL_DEFAULTS.CHARS_PER_TOKEN;
    const maxChars = Math.floor(caps.contextLength * charsPerToken * 0.8);
    console.log(
      `[OllamaService] Discovered ${model}: arch=${caps.architecture}, ctx=${caps.contextLength}, dim=${caps.embeddingDimension}, maxChars=${maxChars}`,
    );

    return caps;
  }

  /**
   * Discover model capabilities via Ollama SDK show() method.
   * Falls back to conservative defaults if discovery fails.
   */
  private async discoverCapabilities(model: string): Promise<ModelCapabilities> {
    if (!this.client) {
      console.warn("[OllamaService] Client not initialized, using fallbacks");
      return this.fallbackCapabilities(model);
    }

    try {
      const data = await this.client.show({ model });
      // SDK returns model_info as Map, convert to Record for parsing
      const rawInfo = data.model_info;
      const modelInfo: Record<string, unknown> =
        rawInfo instanceof Map
          ? Object.fromEntries(rawInfo)
          : ((rawInfo as Record<string, unknown>) ?? {});
      const parsed = this.parseModelInfo(modelInfo);

      return await this.buildCapabilities(model, parsed);
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
   * Check if error is retryable (timeout or connection error).
   */
  private isRetryableError(message: string): { retryable: boolean; reason: string } {
    if (message.includes("timed out")) {
      return { retryable: true, reason: "timeout" };
    }
    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
      return { retryable: true, reason: "connection" };
    }
    return { retryable: false, reason: "" };
  }

  /**
   * Validate service state for embedding operations.
   * @throws Error if service is not ready
   */
  private validateEmbedState(): string {
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
    return model;
  }

  /**
   * Generate embedding for a single text (used for search queries).
   * Has longer timeout and retry logic since search should work even during indexing.
   *
   * @throws Error if embedding fails after retries
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const model = this.validateEmbedState();
    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 60000; // 60s for search queries

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const embedding = (await this.embedRequest(text, model, { timeoutMs: TIMEOUT_MS }))[0];
        return { embedding, model };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { retryable, reason } = this.isRetryableError(message);

        if (!retryable || attempt >= MAX_RETRIES) {
          throw new Error(`Embedding failed: ${message}`);
        }

        const delay = Math.min(500 * 2 ** attempt, 2000);
        console.log(
          `[OllamaService] Embed failed (${reason}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
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
   * Create an AbortController that chains with an optional upstream signal.
   */
  private createChainedAbortController(upstreamSignal?: AbortSignal): {
    controller: AbortController;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();

    if (upstreamSignal?.aborted) {
      controller.abort();
    } else if (upstreamSignal) {
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      upstreamSignal?.removeEventListener("abort", onAbort);
    };

    return { controller, cleanup };
  }

  /**
   * Ollama embed call using native SDK with timeout + abort support.
   * Uses SDK's embed method for proper async handling.
   */
  private async embedRequest(
    input: string | string[],
    model: string,
    options: { timeoutMs: number; signal?: AbortSignal; contextTokens?: number },
  ): Promise<number[][]> {
    if (!this.client) {
      throw new Error("Ollama client not initialized");
    }

    const { controller, cleanup } = this.createChainedAbortController(options.signal);
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      // Use SDK's embed method
      const response = await this.client.embed({
        model,
        input: Array.isArray(input) ? input : [input],
        truncate: true,
        keep_alive: `${this.kernel.settings.advanced.keepAliveMs}ms`,
        options: options.contextTokens ? { num_ctx: options.contextTokens } : undefined,
      });

      // SDK returns { embeddings: number[][] }
      if (!response?.embeddings || !Array.isArray(response.embeddings)) {
        throw new Error("Ollama SDK embed returned invalid response");
      }

      return response.embeddings;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding timed out after ${options.timeoutMs}ms`);
      }
      // Re-throw SDK errors with context
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("fetch failed") || errorMessage.includes("ECONNREFUSED")) {
        throw new Error(`Cannot connect to Ollama: ${errorMessage}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      cleanup();
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
