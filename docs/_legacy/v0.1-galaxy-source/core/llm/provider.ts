/**
 * LLM Provider Interface for Notient
 * Abstracts LLM backends (LM Studio, Ollama, OpenAI-compatible)
 * Source of truth: .planning/PHASE-GALAXY.md (Phase D4)
 */

/**
 * Options for completion requests.
 */
export interface CompletionOptions {
  /** Temperature for response randomness (0-2, default 0.7) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * LLM Provider interface.
 * Implemented by LMStudioProvider and OllamaProvider.
 */
export interface LLMProvider {
  /**
   * Generate a completion for the given prompt.
   *
   * @param prompt - The input prompt
   * @param options - Optional completion parameters
   * @returns The generated text
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;

  /**
   * Check if the provider is available and responding.
   *
   * @returns true if provider is reachable
   */
  isAvailable(): Promise<boolean>;
}
