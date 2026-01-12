/**
 * Chat Service
 *
 * Lightweight chat orchestrator that bypasses ChiefOfStaff for pure conversation.
 * Provides direct LLM access with streaming, thinking token support, and optional
 * delegation to specialist agents when needed.
 *
 * Key features:
 * - Direct LLM calls for fast chat (no routing overhead)
 * - Thinking token extraction (<think> tags, reasoning_content)
 * - Activity trail events for UI breadcrumbs
 * - Statistics collection (tokens/sec, response time, etc.)
 * - Delegation detection for specialist agent handoff
 * - Reasoning summary extraction for storage
 */

import type { UserProfile } from "../../types/profile";
import { buildBaseIdentity } from "../agent/identity";
import type { AgentType } from "../agents/types";
import { CHAT_LIMITS } from "../constants";
import type { LLMProvider } from "../llm/provider";
import type { ChatMessage } from "../llm/types";
import { ThinkingParser, estimateTokenCount } from "./thinkingParser";
import {
  type ChatNoteContext,
  type ChatServiceConfig,
  type ChatStatistics,
  type ChatStreamEvent,
  DEFAULT_CHAT_CONFIG,
  type DelegationDetection,
} from "./types";

/** Thinking state accumulated during streaming */
interface ThinkingState {
  fullContent: string;
  fullThinking: string;
  thinkingTimeMs: number;
  generationStartTime: number;
}

/** Maximum length for reasoning summary */
const REASONING_SUMMARY_MAX_LENGTH = 200;

/**
 * Extract a reasoning summary from thinking content.
 * Used when storing messages to avoid bloating storage with full thinking blocks.
 *
 * @param thinkingContent - Full thinking/reasoning content from <think> blocks
 * @param maxLength - Maximum summary length (default 200)
 * @returns Summary string or undefined if no thinking content
 */
export function extractReasoningSummary(
  thinkingContent: string | null | undefined,
  maxLength: number = REASONING_SUMMARY_MAX_LENGTH,
): string | undefined {
  console.log("[chatService:extractReasoningSummary] TRACE: START");
  if (!thinkingContent || thinkingContent.trim().length === 0) {
    console.log("[chatService:extractReasoningSummary] TRACE: END (no content)");
    return undefined;
  }

  // Clean up and normalize whitespace
  const cleaned = thinkingContent.trim().replace(/\s+/g, " ");

  if (cleaned.length <= maxLength) {
    console.log(
      "[chatService:extractReasoningSummary] TRACE: END (returning full cleaned content)",
    );
    return cleaned;
  }

  // Truncate and add ellipsis
  const result = `${cleaned.slice(0, maxLength)}...`;
  console.log("[chatService:extractReasoningSummary] TRACE: END (truncated)");
  return result;
}

/**
 * ChatService - Lightweight chat orchestrator
 */
export class ChatService {
  private config: ChatServiceConfig;
  private profile?: UserProfile;

  constructor(
    private llm: LLMProvider,
    profile?: UserProfile,
    config?: Partial<ChatServiceConfig>,
  ) {
    console.log("[chatService:constructor] TRACE: START");
    this.profile = profile;
    this.config = { ...DEFAULT_CHAT_CONFIG, ...config };
    console.log("[chatService:constructor] TRACE: END");
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    console.log("[chatService:setProfile] TRACE: START");
    this.profile = profile;
    console.log("[chatService:setProfile] TRACE: END");
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ChatServiceConfig>): void {
    console.log("[chatService:setConfig] TRACE: START");
    this.config = { ...this.config, ...config };
    console.log("[chatService:setConfig] TRACE: END");
  }

  /**
   * Update LLM provider
   */
  setLLM(llm: LLMProvider): void {
    console.log("[chatService:setLLM] TRACE: START");
    this.llm = llm;
    console.log("[chatService:setLLM] TRACE: END");
  }

  /**
   * Process a parsed chunk and yield appropriate events.
   * Returns updated thinking state.
   */
  private *processThinkingChunk(
    parsed: ReturnType<ThinkingParser["processChunk"]>,
    thinkingParser: ThinkingParser,
    state: ThinkingState,
  ): Generator<ChatStreamEvent, ThinkingState> {
    console.log("[chatService:processThinkingChunk] TRACE: START");
    const updatedState = { ...state };

    if (parsed.thinkingJustStarted) {
      console.log("[chatService:processThinkingChunk] TRACE: Thinking just started");
      yield { type: "activity", message: "Reasoning...", phase: "thinking" };
    }

    if (parsed.thinkingChunk) {
      console.log(
        `[chatService:processThinkingChunk] TRACE: Got thinking chunk, length=${parsed.thinkingChunk.length}`,
      );
      updatedState.fullThinking += parsed.thinkingChunk;
      yield { type: "thinking", content: parsed.thinkingChunk };
    }

    if (parsed.thinkingJustEnded) {
      console.log("[chatService:processThinkingChunk] TRACE: Thinking just ended");
      updatedState.thinkingTimeMs = thinkingParser.getThinkingDurationMs();
      updatedState.generationStartTime = Date.now();
      yield {
        type: "thinking-complete",
        content: thinkingParser.getThinkingContent(),
        durationMs: updatedState.thinkingTimeMs,
      };
      yield { type: "activity", message: "Generating response...", phase: "generating" };
    }

    if (parsed.contentChunk) {
      console.log(
        `[chatService:processThinkingChunk] TRACE: Got content chunk, length=${parsed.contentChunk.length}`,
      );
      updatedState.fullContent += parsed.contentChunk;
      yield { type: "chunk", content: parsed.contentChunk };
    }

    console.log("[chatService:processThinkingChunk] TRACE: END");
    return updatedState;
  }

  /**
   * Build chat statistics from accumulated state.
   */
  private buildStatistics(
    startTime: number,
    contextTimeMs: number,
    contextSize: number,
    state: ThinkingState,
  ): ChatStatistics {
    console.log("[chatService:buildStatistics] TRACE: START");
    const totalTimeMs = Date.now() - startTime;
    const generationTimeMs = totalTimeMs - state.thinkingTimeMs - contextTimeMs;
    const tokenCount =
      estimateTokenCount(state.fullContent) + estimateTokenCount(state.fullThinking);
    const thinkingTokenCount = estimateTokenCount(state.fullThinking);
    const tokensPerSecond = generationTimeMs > 0 ? (tokenCount / generationTimeMs) * 1000 : 0;

    const stats: ChatStatistics = {
      responseTimeMs: totalTimeMs,
      thinkingTimeMs: state.thinkingTimeMs,
      generationTimeMs,
      tokenCount,
      tokensPerSecond,
      contextWindowUsed: contextSize,
      contextWindowMax: this.config.contextWindowMax,
      modelName: this.config.modelName,
      thinkingTokenCount,
    };
    console.log(
      `[chatService:buildStatistics] TRACE: END totalTimeMs=${totalTimeMs} tokensPerSecond=${tokensPerSecond.toFixed(2)}`,
    );
    return stats;
  }

  /**
   * Chat with streaming response
   *
   * @param message - User's message
   * @param noteContext - Current note context
   * @param history - Previous chat messages
   * @param signal - Optional abort signal
   */
  async *chat(
    message: string,
    noteContext: ChatNoteContext | null,
    history: ChatMessage[] = [],
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    console.log(`[chatService:chat] TRACE: START message.length=${message.length}`);
    const startTime = Date.now();

    yield { type: "started" };
    console.log("[chatService:chat] TRACE: Yielded started event");

    // Check for delegation first
    console.log("[chatService:chat] TRACE: Checking for delegation");
    const delegation = this.detectDelegation(message);
    if (delegation.shouldDelegate && delegation.confidence > 0.7) {
      console.log(
        `[chatService:chat] TRACE: Delegation detected, targetAgent=${delegation.targetAgent}`,
      );
      yield {
        type: "activity",
        message: `Detected ${delegation.targetAgent} intent - will delegate...`,
        phase: "delegation",
      };
    }

    // Build context
    console.log("[chatService:chat] TRACE: Building context");
    yield { type: "activity", message: "Building context...", phase: "context" };
    const contextStartTime = Date.now();

    console.log("[chatService:chat] TRACE: Building system prompt");
    const systemPrompt = this.buildSystemPrompt(noteContext);
    console.log("[chatService:chat] TRACE: Building messages array");
    const messages = this.buildMessages(systemPrompt, message, history);
    const contextSize = messages.reduce((acc, m) => acc + m.content.length, 0);
    const contextTimeMs = Date.now() - contextStartTime;
    console.log(
      `[chatService:chat] TRACE: Context built, size=${contextSize} timeMs=${contextTimeMs}`,
    );

    // Initialize thinking parser and state
    console.log("[chatService:chat] TRACE: Initializing thinking parser");
    const thinkingParser = new ThinkingParser(this.config.thinkingConfig);
    let state: ThinkingState = {
      fullContent: "",
      fullThinking: "",
      thinkingTimeMs: 0,
      generationStartTime: Date.now(),
    };

    try {
      yield { type: "activity", message: "Generating response...", phase: "generating" };
      console.log("[chatService:chat] TRACE: Starting LLM stream");

      for await (const chunk of this.llm.stream(messages, { temperature: 0.7 }, signal)) {
        console.log(`[chatService:chat] TRACE: Received LLM chunk, length=${chunk.length}`);
        const parsed = thinkingParser.processChunk(chunk);
        const generator = this.processThinkingChunk(parsed, thinkingParser, state);

        let result = generator.next();
        while (!result.done) {
          yield result.value;
          result = generator.next();
        }
        state = result.value;
      }

      // Finalize parsing
      console.log("[chatService:chat] TRACE: Finalizing parsing");
      const finalParsed = thinkingParser.finalize();
      state.fullContent = finalParsed.content;
      state.fullThinking = finalParsed.thinking || "";

      console.log("[chatService:chat] TRACE: Building statistics");
      const statistics = this.buildStatistics(startTime, contextTimeMs, contextSize, state);

      yield { type: "activity", message: "Complete", phase: "complete" };
      console.log("[chatService:chat] TRACE: Yielding complete event");
      yield {
        type: "complete",
        content: state.fullContent,
        thinking: state.fullThinking || null,
        statistics,
      };
      console.log("[chatService:chat] TRACE: END (success)");
    } catch (error) {
      console.log("[chatService:chat] TRACE: Caught error:", error);
      if ((error as Error).name === "AbortError") {
        console.log("[chatService:chat] TRACE: END (aborted)");
        yield { type: "error", error: new DOMException("Chat aborted", "AbortError") };
        return;
      }
      console.log("[chatService:chat] TRACE: END (error)");
      yield { type: "error", error: error as Error };
    }
  }

  /**
   * Detect if message should be delegated to a specialist agent
   */
  detectDelegation(message: string): DelegationDetection {
    console.log("[chatService:detectDelegation] TRACE: START");
    const lowerMessage = message.toLowerCase();
    const keywords = this.config.delegationKeywords;

    // Check edit keywords
    console.log("[chatService:detectDelegation] TRACE: Checking edit keywords");
    const editScore = this.calculateKeywordScore(lowerMessage, keywords.edit);
    if (editScore > 0.5) {
      console.log(
        `[chatService:detectDelegation] TRACE: END (edit delegation, score=${editScore})`,
      );
      return {
        shouldDelegate: true,
        targetAgent: "note-editor" as AgentType,
        instruction: message,
        confidence: editScore,
      };
    }

    // Check classify keywords
    console.log("[chatService:detectDelegation] TRACE: Checking classify keywords");
    const classifyScore = this.calculateKeywordScore(lowerMessage, keywords.classify);
    if (classifyScore > 0.5) {
      console.log(
        `[chatService:detectDelegation] TRACE: END (classify delegation, score=${classifyScore})`,
      );
      return {
        shouldDelegate: true,
        targetAgent: "classifier" as AgentType,
        instruction: message,
        confidence: classifyScore,
      };
    }

    // Check link keywords
    console.log("[chatService:detectDelegation] TRACE: Checking link keywords");
    const linkScore = this.calculateKeywordScore(lowerMessage, keywords.link);
    if (linkScore > 0.5) {
      console.log(
        `[chatService:detectDelegation] TRACE: END (link delegation, score=${linkScore})`,
      );
      return {
        shouldDelegate: true,
        targetAgent: "link-finder" as AgentType,
        instruction: message,
        confidence: linkScore,
      };
    }

    // Check for explicit slash commands
    console.log("[chatService:detectDelegation] TRACE: Checking slash commands");
    if (lowerMessage.startsWith("/edit") || lowerMessage.startsWith("/improve")) {
      console.log("[chatService:detectDelegation] TRACE: END (edit slash command)");
      return {
        shouldDelegate: true,
        targetAgent: "note-editor" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    if (lowerMessage.startsWith("/classify") || lowerMessage.startsWith("/para")) {
      console.log("[chatService:detectDelegation] TRACE: END (classify slash command)");
      return {
        shouldDelegate: true,
        targetAgent: "classifier" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    if (lowerMessage.startsWith("/link") || lowerMessage.startsWith("/connect")) {
      console.log("[chatService:detectDelegation] TRACE: END (link slash command)");
      return {
        shouldDelegate: true,
        targetAgent: "link-finder" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    console.log("[chatService:detectDelegation] TRACE: END (no delegation)");
    return {
      shouldDelegate: false,
      confidence: 0,
    };
  }

  /**
   * Calculate keyword match score
   */
  private calculateKeywordScore(message: string, keywords: string[]): number {
    console.log(
      `[chatService:calculateKeywordScore] TRACE: START keywords.length=${keywords.length}`,
    );
    let matches = 0;
    let totalWeight = 0;

    for (const keyword of keywords) {
      const weight = keyword.length > 5 ? 2 : 1; // Longer keywords are more specific
      totalWeight += weight;

      if (message.includes(keyword)) {
        matches += weight;
      }
    }

    const score = totalWeight > 0 ? matches / totalWeight : 0;
    console.log(`[chatService:calculateKeywordScore] TRACE: END score=${score}`);
    return score;
  }

  /**
   * Build system prompt for chat
   */
  private buildSystemPrompt(noteContext: ChatNoteContext | null): string {
    console.log(
      `[chatService:buildSystemPrompt] TRACE: START hasNoteContext=${noteContext !== null}`,
    );
    const parts: string[] = [];

    // Base Notient identity (Tier 1)
    console.log("[chatService:buildSystemPrompt] TRACE: Building base identity");
    parts.push(buildBaseIdentity(this.profile));

    // Chat-specific instructions
    console.log("[chatService:buildSystemPrompt] TRACE: Adding chat-specific instructions");
    parts.push(`
CHAT MODE:
You are engaged in conversational dialogue about the user's notes.
- Answer questions about note content with precision
- Cite specific sections using [[Note Title#Heading]] format
- Suggest connections to other notes when relevant
- Be helpful but honest about what's NOT in the notes
- Keep responses conversational and focused`);

    // Add note context if available
    if (noteContext) {
      console.log("[chatService:buildSystemPrompt] TRACE: Formatting note context");
      parts.push(this.formatNoteContext(noteContext));
    } else {
      console.log("[chatService:buildSystemPrompt] TRACE: No note context");
      parts.push(`
CONTEXT:
No specific note is currently selected. Answer general questions or ask the user to open a note for context-specific help.`);
    }

    const result = parts.join("\n");
    console.log(`[chatService:buildSystemPrompt] TRACE: END promptLength=${result.length}`);
    return result;
  }

  /**
   * Format note context for the prompt
   */
  private formatNoteContext(note: ChatNoteContext): string {
    console.log(`[chatService:formatNoteContext] TRACE: START title=${note.title}`);
    const lines: string[] = ["\nCURRENT NOTE:"];

    lines.push(`Title: ${note.title}`);
    lines.push(`Path: ${note.path}`);
    lines.push(`Word count: ${note.wordCount}`);

    if (note.frontmatter && Object.keys(note.frontmatter).length > 0) {
      lines.push(`Frontmatter: ${JSON.stringify(note.frontmatter)}`);
    }

    // Truncate content if too long
    const content =
      note.content.length > CHAT_LIMITS.MAX_CONTENT_LENGTH
        ? `${note.content.slice(0, CHAT_LIMITS.MAX_CONTENT_LENGTH)}...\n[Content truncated - ${note.wordCount} words total]`
        : note.content;

    lines.push(`\nContent:\n${content}`);

    const result = lines.join("\n");
    console.log(`[chatService:formatNoteContext] TRACE: END resultLength=${result.length}`);
    return result;
  }

  /**
   * Build messages array for LLM
   */
  private buildMessages(
    systemPrompt: string,
    userMessage: string,
    history: ChatMessage[],
  ): ChatMessage[] {
    console.log(`[chatService:buildMessages] TRACE: START historyLength=${history.length}`);
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    // Add chat history (limit to recent messages to manage context window)
    const recentHistory = history.slice(-10);
    console.log(
      `[chatService:buildMessages] TRACE: Adding ${recentHistory.length} history messages`,
    );
    for (const msg of recentHistory) {
      if (msg.role !== "system") {
        messages.push(msg);
      }
    }

    // Add current user message
    messages.push({ role: "user", content: userMessage });

    console.log(`[chatService:buildMessages] TRACE: END totalMessages=${messages.length}`);
    return messages;
  }

  /**
   * Get current configuration
   */
  getConfig(): ChatServiceConfig {
    console.log("[chatService:getConfig] TRACE: START");
    const config = { ...this.config };
    console.log("[chatService:getConfig] TRACE: END");
    return config;
  }

  /**
   * Check if LLM is ready
   */
  get isReady(): boolean {
    console.log("[chatService:get:isReady] TRACE: START");
    const ready = this.llm.isReady;
    console.log(`[chatService:get:isReady] TRACE: END value=${ready}`);
    return ready;
  }
}
