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
  ExpertAgentType,
  NoteContext,
} from "./types";
import { AGENT_CONFIGS, getAgentSchema } from "./types";

/**
 * Abstract base class for all agents
 */
export abstract class BaseAgent {
  protected readonly config: AgentConfig;
  protected readonly agentType: AgentType;

  constructor(
    protected readonly llm: LLMProvider,
    agentType: AgentType,
  ) {
    this.agentType = agentType;
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
    const result = this.config.canDelegate && this.config.delegationTargets.includes(targetAgent);
    return result;
  }

  /**
   * Build LLM completion options based on agent config
   * Adjusts temperature for thinking models (DeepSeek, Falcon H1R, Qwen QwQ)
   * Adds structured output schema for expert agents
   */
  protected getCompletionOptions(): CompletionOptions {
    let temperature = this.config.temperature;

    // Thinking models need higher temperature for quality output
    // They use extended reasoning which gets suppressed at low temps
    const modelName = this.llm.model?.toLowerCase() || "";

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

    const options: CompletionOptions = {
      temperature,
      maxTokens: this.config.maxTokens,
    };

    // Add structured output schema for expert agents (forces valid JSON)
    if (this.config.outputKind === "structured" && !this.config.isUI) {
      const schema = getAgentSchema(this.config.type as ExpertAgentType);
      if (schema) {
        options.responseFormat = schema;
        console.log(
          `[${this.config.name}] Using structured output schema: ${schema.json_schema.name}`,
        );
      }
    }

    return options;
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

    const result = `=== CURRENT NOTE ===
Title: ${note.title}
Path: ${note.path}
${note.frontmatter ? `Frontmatter: ${JSON.stringify(note.frontmatter, null, 2)}` : ""}

${truncatedContent}
=== END CURRENT NOTE ===`;
    return result;
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
    if (!notes.length) {
      return "";
    }

    const formatted = notes
      .slice(0, maxNotes)
      .map((n) => {
        const preview =
          n.text.length > maxCharsPerNote ? `${n.text.slice(0, maxCharsPerNote)}...` : n.text;
        return `### [[${n.title}]] (${n.path})\n${preview}`;
      })
      .join("\n\n");

    const result = `RELATED NOTES FROM VAULT:\n${formatted}`;
    return result;
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
    const result = [
      { role: "system" as const, content: systemPrompt },
      ...this.formatChatHistory(context.chatHistory),
    ];
    return result;
  }

  /**
   * Stream LLM response with proper error handling
   */
  protected async *streamLLM(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string> {
    try {
      let chunkCount = 0;
      for await (const chunk of this.llm.stream(messages, this.getCompletionOptions(), signal)) {
        chunkCount++;
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
    const startTime = Date.now();
    console.log(`[BaseAgent:${this.agentType}] completeLLM START`);
    const result = await this.llm.complete(messages, this.getCompletionOptions());
    const duration = Date.now() - startTime;
    console.log(
      `[BaseAgent:${this.agentType}] completeLLM END (${result.length} chars, ${duration}ms)`,
    );
    return result;
  }

  /**
   * Sanitize LLM output for safe JSON parsing
   * Removes control characters and normalizes line endings
   */
  protected sanitizeLLMOutput(rawOutput: string): string {
    // Remove control characters that break JSON.parse (keep \n, \r, \t)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional control char removal from LLM output
    const controlCharRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
    const result = rawOutput
      .replace(controlCharRegex, "")
      .replace(/\r\n/g, "\n") // Normalize line endings
      .replace(/\r/g, "\n");
    return result;
  }

  /**
   * Parse JSON from LLM output with robust error handling
   * Handles thinking model output with <think> tags
   */
  protected parseJSON<T>(jsonStr: string): T | null {
    try {
      let cleaned = jsonStr.trim();
      const originalLength = jsonStr.length;

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
        console.debug(
          `[${this.config.name}] Full cleaned input (${cleaned.length} chars):`,
          cleaned,
        );
        return null;
      }

      // Try parsing the extracted JSON
      const extracted = jsonMatch[0];
      try {
        const result = JSON.parse(extracted) as T;
        return result;
      } catch (parseError) {
        // If greedy match failed, try to find balanced braces
        const balanced = this.extractBalancedJson(cleaned);
        if (balanced) {
          try {
            const result = JSON.parse(balanced) as T;
            return result;
          } catch (balancedError) {
            console.debug(
              `[${this.config.name}] Balanced JSON parse failed. Extracted (${balanced.length} chars):`,
              balanced.slice(0, 500),
            );
            throw new Error("JSON extraction failed - balanced parse error");
          }
        }
        console.debug(
          `[${this.config.name}] JSON extraction failed. Original length: ${originalLength}, cleaned: ${cleaned.length}`,
        );
        console.debug(
          `[${this.config.name}] Extracted segment (${extracted.length} chars):`,
          extracted.slice(0, 500),
        );
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
    if (startIdx === -1) {
      return null;
    }

    const startChar = text[startIdx];
    const endChar = startChar === "{" ? "}" : "]";

    const endIdx = this.findBalancedEndIndex(text, startIdx, startChar, endChar);
    if (endIdx === -1) {
      return null;
    }

    const result = text.slice(startIdx, endIdx + 1);
    return result;
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

    const result = {
      targetAgent,
      instruction,
      contextFilter: {
        includeNote: true,
        includeChatHistory: false,
        includeSearch: true,
      },
    };
    return result;
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
