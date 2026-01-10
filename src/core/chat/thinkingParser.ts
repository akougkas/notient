/**
 * Thinking Parser
 *
 * Parses thinking/reasoning tokens from LLM responses.
 * Supports:
 * - <think>...</think> inline tags (DeepSeek R1, Qwen3)
 * - Configurable start/end tags (LM Studio v0.3.10+)
 * - Streaming-aware parsing (handles partial tags)
 */

import type { ThinkingConfig, ThinkingParseResult } from "./types";

/**
 * Default thinking configuration
 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  startTag: "<think>",
  endTag: "</think>",
  checkReasoningField: true,
};

/**
 * ThinkingParser - Extracts thinking/reasoning content from LLM responses
 */
export class ThinkingParser {
  private config: ThinkingConfig;
  private buffer = "";
  private thinkingContent = "";
  private mainContent = "";
  private inThinkingBlock = false;
  private thinkingStartTime = 0;

  constructor(config: Partial<ThinkingConfig> = {}) {
    this.config = { ...DEFAULT_THINKING_CONFIG, ...config };
  }

  /**
   * Process a chunk of streamed content
   * Call this for each chunk received from the LLM
   *
   * @returns Object containing new thinking content, new main content, and state
   */
  processChunk(chunk: string): {
    thinkingChunk: string;
    contentChunk: string;
    isThinking: boolean;
    thinkingJustStarted: boolean;
    thinkingJustEnded: boolean;
  } {
    this.buffer += chunk;

    let thinkingChunk = "";
    let contentChunk = "";
    let thinkingJustStarted = false;
    let thinkingJustEnded = false;

    // Process buffer looking for tags
    while (this.buffer.length > 0) {
      if (this.inThinkingBlock) {
        // Look for end tag
        const endIndex = this.buffer.indexOf(this.config.endTag);
        if (endIndex !== -1) {
          // Found end tag - extract thinking content
          const thinking = this.buffer.slice(0, endIndex);
          thinkingChunk += thinking;
          this.thinkingContent += thinking;
          this.buffer = this.buffer.slice(endIndex + this.config.endTag.length);
          this.inThinkingBlock = false;
          thinkingJustEnded = true;
        } else if (this.mightContainPartialTag(this.buffer, this.config.endTag)) {
          // Might have partial end tag at end of buffer - wait for more data
          break;
        } else {
          // No end tag visible - all is thinking content
          thinkingChunk += this.buffer;
          this.thinkingContent += this.buffer;
          this.buffer = "";
        }
      } else {
        // Not in thinking block - look for start tag
        const startIndex = this.buffer.indexOf(this.config.startTag);
        if (startIndex !== -1) {
          // Found start tag
          const beforeThinking = this.buffer.slice(0, startIndex);
          contentChunk += beforeThinking;
          this.mainContent += beforeThinking;
          this.buffer = this.buffer.slice(startIndex + this.config.startTag.length);
          this.inThinkingBlock = true;
          this.thinkingStartTime = Date.now();
          thinkingJustStarted = true;
        } else if (this.mightContainPartialTag(this.buffer, this.config.startTag)) {
          // Might have partial start tag at end of buffer - wait for more data
          break;
        } else {
          // No start tag visible - all is main content
          contentChunk += this.buffer;
          this.mainContent += this.buffer;
          this.buffer = "";
        }
      }
    }

    return {
      thinkingChunk,
      contentChunk,
      isThinking: this.inThinkingBlock,
      thinkingJustStarted,
      thinkingJustEnded,
    };
  }

  /**
   * Check if the buffer might contain a partial tag at the end
   */
  private mightContainPartialTag(buffer: string, tag: string): boolean {
    // Check if any suffix of the buffer is a prefix of the tag
    const maxCheck = Math.min(buffer.length, tag.length - 1);
    for (let i = 1; i <= maxCheck; i++) {
      const suffix = buffer.slice(-i);
      if (tag.startsWith(suffix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Finalize parsing (call when stream ends)
   * Flushes any remaining buffer content
   */
  finalize(): ThinkingParseResult {
    // Flush remaining buffer as content (even if we were in thinking block)
    if (this.buffer.length > 0) {
      if (this.inThinkingBlock) {
        this.thinkingContent += this.buffer;
      } else {
        this.mainContent += this.buffer;
      }
      this.buffer = "";
    }

    return {
      content: this.mainContent,
      thinking: this.thinkingContent.length > 0 ? this.thinkingContent : null,
      thinkingInProgress: this.inThinkingBlock,
    };
  }

  /**
   * Get current thinking duration (if in thinking block)
   */
  getThinkingDurationMs(): number {
    if (this.thinkingStartTime === 0) return 0;
    return Date.now() - this.thinkingStartTime;
  }

  /**
   * Get accumulated thinking content so far
   */
  getThinkingContent(): string {
    return this.thinkingContent;
  }

  /**
   * Get accumulated main content so far
   */
  getMainContent(): string {
    return this.mainContent;
  }

  /**
   * Check if currently in a thinking block
   */
  isInThinkingBlock(): boolean {
    return this.inThinkingBlock;
  }

  /**
   * Reset parser state for new message
   */
  reset(): void {
    this.buffer = "";
    this.thinkingContent = "";
    this.mainContent = "";
    this.inThinkingBlock = false;
    this.thinkingStartTime = 0;
  }
}

/**
 * Parse a complete response (non-streaming)
 * Useful for processing reasoning_content field or complete responses
 */
export function parseThinkingFromComplete(
  content: string,
  config: Partial<ThinkingConfig> = {},
): ThinkingParseResult {
  const parser = new ThinkingParser(config);
  parser.processChunk(content);
  return parser.finalize();
}

/**
 * Estimate token count from text
 * Uses ~4 characters per token as rough estimate for English
 */
export function estimateTokenCount(text: string): number {
  // More accurate estimate considering:
  // - Whitespace and punctuation count as tokens
  // - Long words get split into multiple tokens
  // - Short words/common words often get combined
  const words = text.split(/\s+/).filter(Boolean);
  let tokens = 0;

  for (const word of words) {
    // Punctuation at boundaries
    const punctuation = (word.match(/[.,!?;:'"()\[\]{}]/g) || []).length;
    // Estimate word tokens (words > 6 chars often split)
    const wordTokens = Math.ceil(word.length / 4);
    tokens += punctuation + wordTokens;
  }

  // Add 10% overhead for special tokens, formatting
  return Math.ceil(tokens * 1.1);
}
