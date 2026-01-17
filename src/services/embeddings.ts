/**
 * Embedding Service Stub for Notient
 * Interface for embedding provider with Web Worker integration placeholder.
 * Source of truth: .planning/PHASE-GALAXY.md
 */

/**
 * Embedding vector type (Float32Array for efficiency).
 */
export type EmbeddingVector = Float32Array;

/**
 * Configuration for embedding provider.
 */
export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
}

/**
 * Result of embedding a single text.
 */
export interface EmbeddingResult {
  vector: EmbeddingVector;
  dimensions: number;
  model: string;
}

/**
 * Embedding service interface.
 * Implementations handle actual provider communication.
 */
export interface EmbeddingProvider {
  /** Generate embedding for a single text */
  embed(text: string): Promise<EmbeddingResult>;
  /** Generate embeddings for multiple texts (batched) */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  /** Get the model dimensions */
  getDimensions(): number;
  /** Check if the provider is available */
  isAvailable(): Promise<boolean>;
}

/**
 * Stub Embedding Service
 *
 * Placeholder implementation for MVP.
 * Will be replaced with Web Worker-based Ollama integration.
 */
export class StubEmbeddingService implements EmbeddingProvider {
  private dimensions = 384; // Common for small models like nomic-embed-text
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  async embed(_text: string): Promise<EmbeddingResult> {
    // Stub: return zero vector
    return {
      vector: new Float32Array(this.dimensions),
      dimensions: this.dimensions,
      model: this.config.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async isAvailable(): Promise<boolean> {
    // Stub: always unavailable until real implementation
    return false;
  }
}
