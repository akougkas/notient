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
   */
  protected getCompletionOptions(): CompletionOptions {
    return {
      temperature: this.config.temperature,
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
   */
  protected parseJSON<T>(jsonStr: string): T | null {
    try {
      // Strip markdown code fences
      let cleaned = jsonStr.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
      }
      cleaned = cleaned.trim();

      // Extract JSON object/array
      const jsonMatch = cleaned.match(/[\[{][\s\S]*[\]}]/);
      if (!jsonMatch) {
        console.warn(`[${this.config.name}] No JSON found in output`);
        return null;
      }

      return JSON.parse(jsonMatch[0]) as T;
    } catch (error) {
      console.warn(`[${this.config.name}] JSON parse error:`, error);
      return null;
    }
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
