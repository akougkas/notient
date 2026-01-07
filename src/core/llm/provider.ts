/**
 * LLM Provider Interface
 *
 * Abstract interface that all LLM providers must implement.
 * This allows swapping between different backends (LM Studio, Ollama, etc.)
 * without changing consumer code.
 */

import type { ChatMessage, CompletionOptions, RankedResult, RerankCandidate } from "./types";

/**
 * Abstract interface for LLM providers
 *
 * Implementations should:
 * - Handle connection management
 * - Implement streaming and non-streaming completions
 * - Provide health/status information
 */
export interface LLMProvider {
  /** Provider identifier */
  readonly name: string;

  /** Whether the provider is initialized and ready */
  readonly isReady: boolean;

  /**
   * Initialize the provider (connect, validate config, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Clean up resources
   */
  dispose(): void;

  /**
   * Get a list of available models
   */
  listModels(): Promise<string[]>;

  /**
   * Non-streaming completion
   * @param messages - The conversation messages
   * @param options - Completion options
   * @returns The complete response text
   */
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;

  /**
   * Streaming completion
   * @param messages - The conversation messages
   * @param options - Completion options
   * @param signal - Optional AbortSignal for cancellation
   * @yields String chunks as they arrive
   */
  stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): AsyncIterable<string>;

  /**
   * Rerank search candidates by relevance to a query
   * @param query - The search query
   * @param candidates - Candidates to rerank
   * @returns Ranked results sorted by relevance
   */
  rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]>;
}
