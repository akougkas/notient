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
 */

import type { UserProfile } from "../../types/profile";
import { buildBaseIdentity } from "../agent/identity";
import type { AgentType } from "../agents/types";
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
    this.profile = profile;
    this.config = { ...DEFAULT_CHAT_CONFIG, ...config };
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ChatServiceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Update LLM provider
   */
  setLLM(llm: LLMProvider): void {
    this.llm = llm;
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
    const startTime = Date.now();

    yield { type: "started" };

    // Check for delegation first
    const delegation = this.detectDelegation(message);
    if (delegation.shouldDelegate && delegation.confidence > 0.7) {
      yield {
        type: "activity",
        message: `Detected ${delegation.targetAgent} intent - will delegate...`,
        phase: "delegation",
      };
      // Note: Actual delegation would be handled by caller
      // This service just detects and signals - caller routes to ChiefOfStaff
    }

    // Build context
    yield { type: "activity", message: "Building context...", phase: "context" };
    const contextStartTime = Date.now();

    const systemPrompt = this.buildSystemPrompt(noteContext);
    const messages = this.buildMessages(systemPrompt, message, history);
    const contextSize = messages.reduce((acc, m) => acc + m.content.length, 0);

    const contextTimeMs = Date.now() - contextStartTime;

    // Initialize thinking parser and statistics tracking
    const thinkingParser = new ThinkingParser(this.config.thinkingConfig);
    let thinkingTimeMs = 0;
    let generationStartTime = Date.now();
    let fullContent = "";
    let fullThinking = "";
    let tokenCount = 0;

    try {
      // Stream from LLM
      yield { type: "activity", message: "Generating response...", phase: "generating" };

      for await (const chunk of this.llm.stream(messages, { temperature: 0.7 }, signal)) {
        const parsed = thinkingParser.processChunk(chunk);

        // Handle thinking tokens
        if (parsed.thinkingJustStarted) {
          yield { type: "activity", message: "Reasoning...", phase: "thinking" };
        }

        if (parsed.thinkingChunk) {
          fullThinking += parsed.thinkingChunk;
          yield { type: "thinking", content: parsed.thinkingChunk };
        }

        if (parsed.thinkingJustEnded) {
          thinkingTimeMs = thinkingParser.getThinkingDurationMs();
          generationStartTime = Date.now(); // Reset generation timer after thinking
          yield {
            type: "thinking-complete",
            content: thinkingParser.getThinkingContent(),
            durationMs: thinkingTimeMs,
          };
          yield { type: "activity", message: "Generating response...", phase: "generating" };
        }

        // Handle main content
        if (parsed.contentChunk) {
          fullContent += parsed.contentChunk;
          yield { type: "chunk", content: parsed.contentChunk };
        }
      }

      // Finalize parsing
      const finalParsed = thinkingParser.finalize();
      fullContent = finalParsed.content;
      fullThinking = finalParsed.thinking || "";

      // Calculate statistics
      const totalTimeMs = Date.now() - startTime;
      const generationTimeMs = totalTimeMs - thinkingTimeMs - contextTimeMs;
      tokenCount = estimateTokenCount(fullContent) + estimateTokenCount(fullThinking);
      const thinkingTokenCount = estimateTokenCount(fullThinking);
      const tokensPerSecond = generationTimeMs > 0 ? (tokenCount / generationTimeMs) * 1000 : 0;

      const statistics: ChatStatistics = {
        responseTimeMs: totalTimeMs,
        thinkingTimeMs,
        generationTimeMs,
        tokenCount,
        tokensPerSecond,
        contextWindowUsed: contextSize,
        contextWindowMax: this.config.contextWindowMax,
        modelName: this.config.modelName,
        thinkingTokenCount,
      };

      yield { type: "activity", message: "Complete", phase: "complete" };
      yield {
        type: "complete",
        content: fullContent,
        thinking: fullThinking || null,
        statistics,
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        yield { type: "error", error: new DOMException("Chat aborted", "AbortError") };
        return;
      }
      yield { type: "error", error: error as Error };
    }
  }

  /**
   * Detect if message should be delegated to a specialist agent
   */
  detectDelegation(message: string): DelegationDetection {
    const lowerMessage = message.toLowerCase();
    const keywords = this.config.delegationKeywords;

    // Check edit keywords
    const editScore = this.calculateKeywordScore(lowerMessage, keywords.edit);
    if (editScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "note-editor" as AgentType,
        instruction: message,
        confidence: editScore,
      };
    }

    // Check classify keywords
    const classifyScore = this.calculateKeywordScore(lowerMessage, keywords.classify);
    if (classifyScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "classifier" as AgentType,
        instruction: message,
        confidence: classifyScore,
      };
    }

    // Check link keywords
    const linkScore = this.calculateKeywordScore(lowerMessage, keywords.link);
    if (linkScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "link-finder" as AgentType,
        instruction: message,
        confidence: linkScore,
      };
    }

    // Check for explicit slash commands
    if (lowerMessage.startsWith("/edit") || lowerMessage.startsWith("/improve")) {
      return {
        shouldDelegate: true,
        targetAgent: "note-editor" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    if (lowerMessage.startsWith("/classify") || lowerMessage.startsWith("/para")) {
      return {
        shouldDelegate: true,
        targetAgent: "classifier" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    if (lowerMessage.startsWith("/link") || lowerMessage.startsWith("/connect")) {
      return {
        shouldDelegate: true,
        targetAgent: "link-finder" as AgentType,
        instruction: message,
        confidence: 1.0,
      };
    }

    return {
      shouldDelegate: false,
      confidence: 0,
    };
  }

  /**
   * Calculate keyword match score
   */
  private calculateKeywordScore(message: string, keywords: string[]): number {
    let matches = 0;
    let totalWeight = 0;

    for (const keyword of keywords) {
      const weight = keyword.length > 5 ? 2 : 1; // Longer keywords are more specific
      totalWeight += weight;

      if (message.includes(keyword)) {
        matches += weight;
      }
    }

    return totalWeight > 0 ? matches / totalWeight : 0;
  }

  /**
   * Build system prompt for chat
   */
  private buildSystemPrompt(noteContext: ChatNoteContext | null): string {
    const parts: string[] = [];

    // Base Notient identity (Tier 1)
    parts.push(buildBaseIdentity(this.profile));

    // Chat-specific instructions
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
      parts.push(this.formatNoteContext(noteContext));
    } else {
      parts.push(`
CONTEXT:
No specific note is currently selected. Answer general questions or ask the user to open a note for context-specific help.`);
    }

    return parts.join("\n");
  }

  /**
   * Format note context for the prompt
   */
  private formatNoteContext(note: ChatNoteContext): string {
    const lines: string[] = ["\nCURRENT NOTE:"];

    lines.push(`Title: ${note.title}`);
    lines.push(`Path: ${note.path}`);
    lines.push(`Word count: ${note.wordCount}`);

    if (note.frontmatter && Object.keys(note.frontmatter).length > 0) {
      lines.push(`Frontmatter: ${JSON.stringify(note.frontmatter)}`);
    }

    // Truncate content if too long
    const maxContentLength = 4000;
    const content =
      note.content.length > maxContentLength
        ? `${note.content.slice(0, maxContentLength)}...\n[Content truncated - ${note.wordCount} words total]`
        : note.content;

    lines.push(`\nContent:\n${content}`);

    return lines.join("\n");
  }

  /**
   * Build messages array for LLM
   */
  private buildMessages(
    systemPrompt: string,
    userMessage: string,
    history: ChatMessage[],
  ): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    // Add chat history (limit to recent messages to manage context window)
    const recentHistory = history.slice(-10);
    for (const msg of recentHistory) {
      if (msg.role !== "system") {
        messages.push(msg);
      }
    }

    // Add current user message
    messages.push({ role: "user", content: userMessage });

    return messages;
  }

  /**
   * Get current configuration
   */
  getConfig(): ChatServiceConfig {
    return { ...this.config };
  }

  /**
   * Check if LLM is ready
   */
  get isReady(): boolean {
    return this.llm.isReady;
  }
}
