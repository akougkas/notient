/**
 * Thinking Parser
 *
 * Extracts <think>...</think> blocks from LLM responses.
 * Streaming-aware: buffers only when a partial tag is detected at the end.
 */

import type { ThinkingConfig, ThinkingParseResult } from "./types";

export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  startTag: "<think>",
  endTag: "</think>",
  checkReasoningField: true,
};

/**
 * Streaming parser that extracts thinking blocks from LLM output.
 *
 * Design: Only buffers content when we see a potential partial tag at the
 * very end of the stream. This prevents mangling JSON or other content
 * that happens to contain `<` characters.
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
   * Process a chunk of streamed content.
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

    while (this.buffer.length > 0) {
      const targetTag = this.inThinkingBlock ? this.config.endTag : this.config.startTag;
      const tagIndex = this.buffer.indexOf(targetTag);

      if (tagIndex !== -1) {
        // Full tag found - process content before it
        const beforeTag = this.buffer.slice(0, tagIndex);
        this.buffer = this.buffer.slice(tagIndex + targetTag.length);

        if (this.inThinkingBlock) {
          this.thinkingContent += beforeTag;
          thinkingChunk += beforeTag;
          this.inThinkingBlock = false;
          thinkingJustEnded = true;
        } else {
          this.mainContent += beforeTag;
          contentChunk += beforeTag;
          this.inThinkingBlock = true;
          this.thinkingStartTime = Date.now();
          thinkingJustStarted = true;
        }
        continue;
      }

      // No full tag - check for partial tag at end only
      const holdLength = this.partialTagLength(this.buffer, targetTag);
      const safeContent = this.buffer.slice(0, this.buffer.length - holdLength);

      if (safeContent.length > 0) {
        if (this.inThinkingBlock) {
          this.thinkingContent += safeContent;
          thinkingChunk += safeContent;
        } else {
          this.mainContent += safeContent;
          contentChunk += safeContent;
        }
        this.buffer = this.buffer.slice(safeContent.length);
      }
      break;
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
   * Returns how many characters at the end of `text` could be a partial `tag`.
   * Only matches if the suffix starts with '<' (first char of tag).
   */
  private partialTagLength(text: string, tag: string): number {
    const maxCheck = Math.min(text.length, tag.length - 1);
    for (let length = maxCheck; length >= 1; length--) {
      const suffix = text.slice(-length);
      if (tag.startsWith(suffix)) {
        return length;
      }
    }
    return 0;
  }

  /**
   * Finalize parsing (call when stream ends).
   * Flushes any remaining buffer content.
   */
  finalize(): ThinkingParseResult {
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

  getThinkingDurationMs(): number {
    if (this.thinkingStartTime === 0) return 0;
    return Date.now() - this.thinkingStartTime;
  }

  getThinkingContent(): string {
    return this.thinkingContent;
  }

  getMainContent(): string {
    return this.mainContent;
  }

  isInThinkingBlock(): boolean {
    return this.inThinkingBlock;
  }

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
