/**
 * LLM Type Definitions
 *
 * Core types for the LLM abstraction layer.
 * These types are provider-agnostic and used across all LLM implementations.
 */

/**
 * A message in a chat conversation
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Options for completion requests
 */
export interface CompletionOptions {
  /** Sampling temperature (0.0 - 2.0, lower = more deterministic) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Stop generation at these sequences */
  stopSequences?: string[];
}

/**
 * A chunk from a streaming response
 */
export interface StreamChunk {
  /** The content of this chunk */
  content: string;
  /** Whether this is the final chunk */
  done: boolean;
}

/**
 * Result from a reranking operation
 */
export interface RankedResult {
  noteId: string;
  path: string;
  title: string;
  /** Normalized score (0-1) */
  score: number;
  /** Brief explanation of the ranking */
  reasoning: string;
}

/**
 * A candidate for reranking
 */
export interface RerankCandidate {
  noteId: string;
  path: string;
  title: string;
  text: string;
  originalScore: number;
}
