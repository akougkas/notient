/**
 * Base Agent Interface & Abstract Class
 *
 * All specialized agents extend this base class.
 * Provides common functionality: context handling, LLM access, streaming.
 */

import type { ChatMessage, CompletionOptions, LLMProvider } from "../llm";
import type {
  AgentConfig,
  AgentContext,
  AgentEvent,
  AgentOutput,
  AgentType,
  DelegationRequest,
  NoteContext,
} from "./types";
import { AGENT_CONFIGS } from "./types";

/**
 * Abstract base class for all agents
 */
export abstract class BaseAgent {
  protected readonly config: AgentConfig;

  constructor(
    protected readonly llm: LLMProvider,
    agentType: AgentType,
  ) {
    this.config = AGENT_CONFIGS[agentType];
  }

  // ===========================================================================
  // Abstract Methods (must implement)
  // ===========================================================================

  /**
   * Build the system prompt for this agent
   */
  protected abstract buildSystemPrompt(context: AgentContext): string;

  /**
   * Process the raw LLM output into typed output
   */
  protected abstract parseOutput(rawOutput: string, context: AgentContext): AgentOutput;

  /**
   * Execute the agent's primary function
   */
  abstract execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent>;

  // ===========================================================================
  // Common Functionality
  // ===========================================================================

  /**
   * Get agent configuration
   */
  getConfig(): Readonly<AgentConfig> {
    return this.config;
  }

  /**
   * Check if this agent can delegate to another
   */
  canDelegateTo(targetAgent: AgentType): boolean {
    return this.config.canDelegate && this.config.delegationTargets.includes(targetAgent);
  }

  /**
   * Build LLM completion options based on agent config
   * Adjusts temperature for thinking models (DeepSeek, Falcon H1R, Qwen QwQ)
   */
  protected getCompletionOptions(): CompletionOptions {
    let temperature = this.config.temperature;

    // Thinking models need higher temperature for quality output
    // They use extended reasoning which gets suppressed at low temps
    // Access model name through the provider (protected property)
    const llmAny = this.llm as { model?: string };
    const modelName = llmAny.model?.toLowerCase() || "";

    const isThinkingModel =
      modelName.includes("deepseek") ||
      modelName.includes("falcon") ||
      modelName.includes("qwq") ||
      modelName.includes("r1");

    if (isThinkingModel && temperature < 0.7) {
      // Thinking models need at least 0.7-1.0 temperature
      temperature = Math.max(0.7, temperature);
      console.log(
        `[${this.config.name}] Adjusted temperature ${this.config.temperature} → ${temperature} for thinking model`,
      );
    }

    return {
      temperature,
      maxTokens: this.config.maxTokens,
    };
  }

  /**
   * Format the current note for prompt inclusion
   * Respects context budget
   */
  protected formatNoteForPrompt(note: NoteContext, maxChars?: number): string {
    const limit = maxChars ?? Math.floor(this.config.contextBudget * 0.5);
    const truncatedContent =
      note.content.length > limit
        ? `${note.content.slice(0, limit)}\n\n[... content truncated (${note.content.length - limit} chars omitted) ...]`
        : note.content;

    return `=== CURRENT NOTE ===
Title: ${note.title}
Path: ${note.path}
${note.frontmatter ? `Frontmatter: ${JSON.stringify(note.frontmatter, null, 2)}` : ""}

${truncatedContent}
=== END CURRENT NOTE ===`;
  }

  /**
   * Format related notes for prompt inclusion
   * Respects context budget
   */
  protected formatRelatedNotes(
    notes: Array<{ title: string; path: string; text: string }>,
    maxNotes = 5,
    maxCharsPerNote = 400,
  ): string {
    if (!notes.length) return "";

    const formatted = notes
      .slice(0, maxNotes)
      .map((n) => {
        const preview =
          n.text.length > maxCharsPerNote ? `${n.text.slice(0, maxCharsPerNote)}...` : n.text;
        return `### [[${n.title}]] (${n.path})\n${preview}`;
      })
      .join("\n\n");

    return `RELATED NOTES FROM VAULT:\n${formatted}`;
  }

  /**
   * Format chat history for prompt inclusion
   * Keeps last N messages to stay within budget
   */
  protected formatChatHistory(history: ChatMessage[], maxMessages = 10): ChatMessage[] {
    return history.slice(-maxMessages);
  }

  /**
   * Build messages array for LLM call
   */
  protected buildMessages(systemPrompt: string, context: AgentContext): ChatMessage[] {
    return [
      { role: "system", content: systemPrompt },
      ...this.formatChatHistory(context.chatHistory),
    ];
  }

  /**
   * Stream LLM response with proper error handling
   */
  protected async *streamLLM(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string> {
    try {
      for await (const chunk of this.llm.stream(messages, this.getCompletionOptions(), signal)) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield chunk;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw error;
      }
      console.error(`[${this.config.name}] LLM stream error:`, error);
      throw error;
    }
  }

  /**
   * Non-streaming LLM completion
   */
  protected async completeLLM(messages: ChatMessage[]): Promise<string> {
    return this.llm.complete(messages, this.getCompletionOptions());
  }

  /**
   * Sanitize LLM output for safe JSON parsing
   * Removes control characters and normalizes line endings
   */
  protected sanitizeLLMOutput(rawOutput: string): string {
    // Remove control characters that break JSON.parse (keep \n, \r, \t)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional control char removal from LLM output
    const controlCharRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
    return rawOutput
      .replace(controlCharRegex, "")
      .replace(/\r\n/g, "\n") // Normalize line endings
      .replace(/\r/g, "\n");
  }

  /**
   * Parse JSON from LLM output with robust error handling
   * Handles thinking model output with <think> tags
   */
  protected parseJSON<T>(jsonStr: string): T | null {
    try {
      let cleaned = jsonStr.trim();

      // Strip thinking model tags (DeepSeek, Falcon H1R, Qwen QwQ)
      // These models wrap reasoning in <think>...</think>
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      // Strip markdown code fences
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
      }
      cleaned = cleaned.trim();

      // Extract JSON object/array - use non-greedy match from first { or [
      // to find the balanced closing bracket
      const jsonMatch = cleaned.match(/[\[{][\s\S]*[\]}]/);
      if (!jsonMatch) {
        console.warn(
          `[${this.config.name}] No JSON found in output. Preview:`,
          cleaned.slice(0, 200),
        );
        return null;
      }

      // Try parsing the extracted JSON
      const extracted = jsonMatch[0];
      try {
        return JSON.parse(extracted) as T;
      } catch {
        // If greedy match failed, try to find balanced braces
        const balanced = this.extractBalancedJson(cleaned);
        if (balanced) {
          return JSON.parse(balanced) as T;
        }
        throw new Error("JSON extraction failed");
      }
    } catch (error) {
      console.warn(`[${this.config.name}] JSON parse error:`, error);
      return null;
    }
  }

  /**
   * Extract balanced JSON from a string (handles nested structures)
   */
  private extractBalancedJson(text: string): string | null {
    const startIdx = text.search(/[\[{]/);
    if (startIdx === -1) return null;

    const startChar = text[startIdx];
    const endChar = startChar === "{" ? "}" : "]";

    const endIdx = this.findBalancedEndIndex(text, startIdx, startChar, endChar);
    if (endIdx === -1) return null;

    return text.slice(startIdx, endIdx + 1);
  }

  /**
   * Find the index of the balanced closing bracket
   */
  private findBalancedEndIndex(
    text: string,
    startIdx: number,
    startChar: string,
    endChar: string,
  ): number {
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];
      const result = this.processJsonChar(char, inString, isEscaped, depth, startChar, endChar);

      inString = result.inString;
      isEscaped = result.isEscaped;
      depth = result.depth;

      if (result.foundEnd) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Process a single character during JSON bracket balancing
   */
  private processJsonChar(
    char: string,
    inString: boolean,
    isEscaped: boolean,
    depth: number,
    startChar: string,
    endChar: string,
  ): { inString: boolean; isEscaped: boolean; depth: number; foundEnd: boolean } {
    if (isEscaped) {
      return { inString, isEscaped: false, depth, foundEnd: false };
    }
    if (char === "\\") {
      return { inString, isEscaped: true, depth, foundEnd: false };
    }
    if (char === '"') {
      return { inString: !inString, isEscaped: false, depth, foundEnd: false };
    }
    if (inString) {
      return { inString, isEscaped: false, depth, foundEnd: false };
    }
    if (char === startChar) {
      return { inString, isEscaped: false, depth: depth + 1, foundEnd: false };
    }
    if (char === endChar) {
      const newDepth = depth - 1;
      return { inString, isEscaped: false, depth: newDepth, foundEnd: newDepth === 0 };
    }
    return { inString, isEscaped: false, depth, foundEnd: false };
  }

  /**
   * Create delegation request (for agents that support it)
   */
  protected createDelegationRequest(
    targetAgent: AgentType,
    instruction: string,
  ): DelegationRequest | null {
    if (!this.canDelegateTo(targetAgent)) {
      console.warn(`[${this.config.name}] Cannot delegate to ${targetAgent}`);
      return null;
    }

    return {
      targetAgent,
      instruction,
      contextFilter: {
        includeNote: true,
        includeChatHistory: false,
        includeSearch: true,
      },
    };
  }

  /**
   * Log with agent prefix
   */
  protected log(message: string, ...args: unknown[]): void {
    console.log(`[${this.config.name}] ${message}`, ...args);
  }

  /**
   * Warn with agent prefix
   */
  protected warn(message: string, ...args: unknown[]): void {
    console.warn(`[${this.config.name}] ${message}`, ...args);
  }
}

/**
 * Type guard for checking agent output kind
 */
export function isConversationalOutput(
  output: AgentOutput,
): output is AgentOutput & { kind: "conversational" } {
  return output.kind === "conversational";
}

export function isStructuredOutput(
  output: AgentOutput,
): output is AgentOutput & { kind: "structured" } {
  return output.kind === "structured";
}

export function isInternalOutput(
  output: AgentOutput,
): output is AgentOutput & { kind: "internal" } {
  return output.kind === "internal";
}
