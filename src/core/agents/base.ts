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
    console.log(`[base:constructor] TRACE: START agentType=${agentType}`);
    this.agentType = agentType;
    this.config = AGENT_CONFIGS[agentType];
    console.log("[base:constructor] TRACE: END");
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
    console.log("[base:getConfig] TRACE: START");
    console.log("[base:getConfig] TRACE: END");
    return this.config;
  }

  /**
   * Check if this agent can delegate to another
   */
  canDelegateTo(targetAgent: AgentType): boolean {
    console.log(`[base:canDelegateTo] TRACE: START targetAgent=${targetAgent}`);
    const result = this.config.canDelegate && this.config.delegationTargets.includes(targetAgent);
    console.log(`[base:canDelegateTo] TRACE: END result=${result}`);
    return result;
  }

  /**
   * Build LLM completion options based on agent config
   * Adjusts temperature for thinking models (DeepSeek, Falcon H1R, Qwen QwQ)
   * Adds structured output schema for expert agents
   */
  protected getCompletionOptions(): CompletionOptions {
    console.log("[base:getCompletionOptions] TRACE: START");
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

    console.log(`[base:getCompletionOptions] TRACE: END temperature=${temperature}`);
    return options;
  }

  /**
   * Format the current note for prompt inclusion
   * Respects context budget
   */
  protected formatNoteForPrompt(note: NoteContext, maxChars?: number): string {
    console.log(`[base:formatNoteForPrompt] TRACE: START note.title=${note.title}`);
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
    console.log(`[base:formatNoteForPrompt] TRACE: END resultLength=${result.length}`);
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
    console.log(`[base:formatRelatedNotes] TRACE: START notesCount=${notes.length}`);
    if (!notes.length) {
      console.log("[base:formatRelatedNotes] TRACE: END (empty notes)");
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
    console.log(`[base:formatRelatedNotes] TRACE: END resultLength=${result.length}`);
    return result;
  }

  /**
   * Format chat history for prompt inclusion
   * Keeps last N messages to stay within budget
   */
  protected formatChatHistory(history: ChatMessage[], maxMessages = 10): ChatMessage[] {
    console.log(
      `[base:formatChatHistory] TRACE: START historyLength=${history.length} maxMessages=${maxMessages}`,
    );
    const result = history.slice(-maxMessages);
    console.log(`[base:formatChatHistory] TRACE: END resultLength=${result.length}`);
    return result;
  }

  /**
   * Build messages array for LLM call
   */
  protected buildMessages(systemPrompt: string, context: AgentContext): ChatMessage[] {
    console.log(`[base:buildMessages] TRACE: START systemPromptLength=${systemPrompt.length}`);
    const result = [
      { role: "system" as const, content: systemPrompt },
      ...this.formatChatHistory(context.chatHistory),
    ];
    console.log(`[base:buildMessages] TRACE: END messagesCount=${result.length}`);
    return result;
  }

  /**
   * Stream LLM response with proper error handling
   */
  protected async *streamLLM(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string> {
    console.log(`[base:streamLLM] TRACE: START messagesCount=${messages.length}`);
    try {
      console.log("[base:streamLLM] TRACE: before llm.stream for-await loop");
      let chunkCount = 0;
      for await (const chunk of this.llm.stream(messages, this.getCompletionOptions(), signal)) {
        chunkCount++;
        if (signal?.aborted) {
          console.log(`[base:streamLLM] TRACE: aborted at chunk ${chunkCount}`);
          throw new DOMException("Aborted", "AbortError");
        }
        console.log(`[base:streamLLM] TRACE: yielding chunk ${chunkCount}`);
        yield chunk;
        console.log(`[base:streamLLM] TRACE: yielded chunk ${chunkCount}`);
      }
      console.log(`[base:streamLLM] TRACE: END (completed ${chunkCount} chunks)`);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log("[base:streamLLM] TRACE: END (aborted)");
        throw error;
      }
      console.error(`[${this.config.name}] LLM stream error:`, error);
      console.log("[base:streamLLM] TRACE: END (error)");
      throw error;
    }
  }

  /**
   * Non-streaming LLM completion
   */
  protected async completeLLM(messages: ChatMessage[]): Promise<string> {
    console.log(`[BaseAgent:${this.agentType}] TRACE: completeLLM START`);
    const result = await this.llm.complete(messages, this.getCompletionOptions());
    console.log(`[BaseAgent:${this.agentType}] TRACE: completeLLM END (${result.length} chars)`);
    return result;
  }

  /**
   * Sanitize LLM output for safe JSON parsing
   * Removes control characters and normalizes line endings
   */
  protected sanitizeLLMOutput(rawOutput: string): string {
    console.log(`[base:sanitizeLLMOutput] TRACE: START inputLength=${rawOutput.length}`);
    // Remove control characters that break JSON.parse (keep \n, \r, \t)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional control char removal from LLM output
    const controlCharRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
    const result = rawOutput
      .replace(controlCharRegex, "")
      .replace(/\r\n/g, "\n") // Normalize line endings
      .replace(/\r/g, "\n");
    console.log(`[base:sanitizeLLMOutput] TRACE: END outputLength=${result.length}`);
    return result;
  }

  /**
   * Parse JSON from LLM output with robust error handling
   * Handles thinking model output with <think> tags
   */
  protected parseJSON<T>(jsonStr: string): T | null {
    console.log(`[base:parseJSON] TRACE: START inputLength=${jsonStr.length}`);
    try {
      let cleaned = jsonStr.trim();

      // Strip thinking model tags (DeepSeek, Falcon H1R, Qwen QwQ)
      // These models wrap reasoning in <think>...</think>
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      console.log(`[base:parseJSON] TRACE: after stripping think tags, length=${cleaned.length}`);

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
      console.log(`[base:parseJSON] TRACE: after stripping fences, length=${cleaned.length}`);

      // Extract JSON object/array - use non-greedy match from first { or [
      // to find the balanced closing bracket
      const jsonMatch = cleaned.match(/[\[{][\s\S]*[\]}]/);
      if (!jsonMatch) {
        console.warn(
          `[${this.config.name}] No JSON found in output. Preview:`,
          cleaned.slice(0, 200),
        );
        console.log("[base:parseJSON] TRACE: END (no JSON found)");
        return null;
      }

      // Try parsing the extracted JSON
      const extracted = jsonMatch[0];
      try {
        const result = JSON.parse(extracted) as T;
        console.log("[base:parseJSON] TRACE: END (success)");
        return result;
      } catch {
        console.log("[base:parseJSON] TRACE: greedy match failed, trying balanced extraction");
        // If greedy match failed, try to find balanced braces
        const balanced = this.extractBalancedJson(cleaned);
        if (balanced) {
          const result = JSON.parse(balanced) as T;
          console.log("[base:parseJSON] TRACE: END (success via balanced)");
          return result;
        }
        throw new Error("JSON extraction failed");
      }
    } catch (error) {
      console.warn(`[${this.config.name}] JSON parse error:`, error);
      console.log("[base:parseJSON] TRACE: END (error)");
      return null;
    }
  }

  /**
   * Extract balanced JSON from a string (handles nested structures)
   */
  private extractBalancedJson(text: string): string | null {
    console.log(`[base:extractBalancedJson] TRACE: START textLength=${text.length}`);
    const startIdx = text.search(/[\[{]/);
    if (startIdx === -1) {
      console.log("[base:extractBalancedJson] TRACE: END (no start bracket found)");
      return null;
    }

    const startChar = text[startIdx];
    const endChar = startChar === "{" ? "}" : "]";

    const endIdx = this.findBalancedEndIndex(text, startIdx, startChar, endChar);
    if (endIdx === -1) {
      console.log("[base:extractBalancedJson] TRACE: END (no balanced end found)");
      return null;
    }

    const result = text.slice(startIdx, endIdx + 1);
    console.log(`[base:extractBalancedJson] TRACE: END resultLength=${result.length}`);
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
    console.log(`[base:findBalancedEndIndex] TRACE: START startIdx=${startIdx}`);
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
        console.log(`[base:findBalancedEndIndex] TRACE: END foundAt=${i}`);
        return i;
      }
    }
    console.log("[base:findBalancedEndIndex] TRACE: END (not found)");
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
    console.log(`[base:createDelegationRequest] TRACE: START targetAgent=${targetAgent}`);
    if (!this.canDelegateTo(targetAgent)) {
      console.warn(`[${this.config.name}] Cannot delegate to ${targetAgent}`);
      console.log("[base:createDelegationRequest] TRACE: END (cannot delegate)");
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
    console.log("[base:createDelegationRequest] TRACE: END (success)");
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
