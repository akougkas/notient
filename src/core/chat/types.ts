/**
 * Chat Type Definitions
 *
 * Types for the reusable chat system.
 */

import type { ChatMessage } from "../llm/types";

/**
 * Configuration for a chat session
 */
export interface ChatConfig {
  /** Maximum messages to retain in history */
  maxHistoryLength?: number;
  /** Maximum messages to send to LLM (sliding window) */
  maxLLMMessages?: number;
}

/**
 * A message with metadata for the UI
 */
export interface ExtendedChatMessage extends ChatMessage {
  /** Unique identifier */
  id: string;
  /** When the message was created */
  timestamp: Date;
  /** Optional attachments (citations, files, etc.) */
  attachments?: ChatAttachment[];
}

/**
 * An attachment on a chat message
 */
export interface ChatAttachment {
  id: string;
  type: "rag-citation" | "user-attached";
  filename: string;
  path: string;
}

/**
 * State of the chat session
 */
export interface ChatSessionState {
  /** All messages in the session */
  messages: ExtendedChatMessage[];
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Content being streamed (partial response) */
  streamingContent: string;
}

// ============================================================================
// Enhanced Chat System Types (ChatService)
// ============================================================================

import type { AgentType } from "../agents/types";

/**
 * Events emitted during chat streaming from ChatService
 */
export type ChatStreamEvent =
  | { type: "started" }
  | { type: "thinking"; content: string }
  | { type: "thinking-complete"; content: string; durationMs: number }
  | { type: "chunk"; content: string }
  | { type: "activity"; message: string; phase: ActivityPhase }
  | { type: "delegation-started"; agent: AgentType }
  | { type: "delegation-complete"; agent: AgentType; durationMs: number }
  | { type: "complete"; content: string; thinking: string | null; statistics: ChatStatistics }
  | { type: "error"; error: Error };

/**
 * Activity phases for the activity trail
 */
export type ActivityPhase =
  | "context" // Building context
  | "thinking" // Model reasoning
  | "generating" // Generating response
  | "delegation" // Delegating to specialist
  | "complete"; // Done

/**
 * Statistics collected during chat response generation
 */
export interface ChatStatistics {
  /** Total response time in milliseconds */
  responseTimeMs: number;
  /** Time spent in thinking/reasoning phase */
  thinkingTimeMs: number;
  /** Time spent generating main response */
  generationTimeMs: number;
  /** Estimated or actual token count */
  tokenCount: number;
  /** Tokens per second generation rate */
  tokensPerSecond: number;
  /** Characters sent to LLM (context size used) */
  contextWindowUsed: number;
  /** Model's max context window */
  contextWindowMax: number;
  /** Model identifier */
  modelName: string;
  /** Thinking token count (if separate from main content) */
  thinkingTokenCount: number;
}

/**
 * Result of delegation detection
 */
export interface DelegationDetection {
  /** Whether message should be delegated */
  shouldDelegate: boolean;
  /** Target agent for delegation */
  targetAgent?: AgentType;
  /** Extracted instruction for the agent */
  instruction?: string;
  /** Confidence level (0-1) */
  confidence: number;
}

/**
 * Note context for chat (simplified from AgentContext)
 */
export interface ChatNoteContext {
  title: string;
  path: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  wordCount: number;
}

/**
 * Configuration for thinking token parsing
 */
export interface ThinkingConfig {
  /** Start tag for thinking blocks (default: <think>) */
  startTag: string;
  /** End tag for thinking blocks (default: </think>) */
  endTag: string;
  /** Whether to check reasoning_content field */
  checkReasoningField: boolean;
}

/**
 * Parsed result from thinking extraction
 */
export interface ThinkingParseResult {
  /** Main content (without thinking) */
  content: string;
  /** Extracted thinking content */
  thinking: string | null;
  /** Whether thinking is still in progress (unclosed tag) */
  thinkingInProgress: boolean;
}

/**
 * Configuration for ChatService
 */
export interface ChatServiceConfig {
  /** Model name for display */
  modelName: string;
  /** Max context window size */
  contextWindowMax: number;
  /** Thinking token configuration */
  thinkingConfig: ThinkingConfig;
  /** Keywords that trigger delegation */
  delegationKeywords: DelegationKeywordConfig;
}

/**
 * Delegation keyword configuration
 */
export interface DelegationKeywordConfig {
  edit: string[];
  classify: string[];
  link: string[];
}

/**
 * Default configuration values
 */
export const DEFAULT_CHAT_CONFIG: ChatServiceConfig = {
  modelName: "unknown",
  contextWindowMax: 8192,
  thinkingConfig: {
    startTag: "<think>",
    endTag: "</think>",
    checkReasoningField: true,
  },
  delegationKeywords: {
    edit: ["edit", "improve", "enhance", "fix", "restructure", "rewrite", "add section", "append"],
    classify: ["classify", "categorize", "organize", "para", "move to", "tag as", "folder"],
    link: ["link", "connect", "related", "similar", "connections", "references", "find notes"],
  },
};
