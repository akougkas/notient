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
 * JSON Schema for structured output
 * Used to force LLM to output valid JSON matching a schema
 */
export interface JsonSchemaFormat {
  type: "json_schema";
  json_schema: {
    /** Name of the schema (for debugging) */
    name: string;
    /** Whether to enforce strict validation */
    strict?: boolean;
    /** The JSON schema definition */
    schema: {
      type: "object" | "array";
      properties?: Record<string, unknown>;
      items?: unknown;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/**
 * Response format options
 */
export type ResponseFormat = JsonSchemaFormat | { type: "json_object" } | { type: "text" };

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
  /** Force structured output format (LM Studio structured output API) */
  responseFormat?: ResponseFormat;
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
