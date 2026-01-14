/**
 * Chat Service - Hybrid Mode (Phase 5)
 *
 * Hybrid chat orchestrator that handles both pure conversation AND agent delegation.
 *
 * Key features:
 * - Direct LLM calls for fast chat (pure conversation)
 * - Delegation to Orchestrator for agent tasks (/classify, /enhance, etc.)
 * - Thinking token extraction (<think> tags, reasoning_content)
 * - Activity trail events for UI breadcrumbs
 * - Statistics collection (tokens/sec, response time, etc.)
 * - Reasoning summary extraction for storage
 *
 * Hybrid Mode Flow:
 * 1. Detect if message requires agent delegation
 * 2a. If delegation: route to Orchestrator, stream agent events
 * 2b. If conversation: use direct LLM for fast response
 */

import type { UserProfile } from "../../types/profile";
import { buildBaseIdentity } from "../agent/identity";
import type { ChiefOfStaff } from "../agents/chiefOfStaff";
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

/**
 * ChatService - Hybrid Mode Orchestrator (Phase 5)
 *
 * Can either handle pure conversation directly OR delegate to the
 * Orchestrator (ChiefOfStaff) for agent tasks.
 */
export class ChatService {
  private config: ChatServiceConfig;
  private profile?: UserProfile;
  private orchestrator: ChiefOfStaff | null = null;

  constructor(
    private llm: LLMProvider,
    profile?: UserProfile,
    config?: Partial<ChatServiceConfig>,
  ) {
    this.profile = profile;
    this.config = { ...DEFAULT_CHAT_CONFIG, ...config };
  }

  /**
   * Inject Orchestrator for agent delegation (Phase 5 hybrid mode)
   * Called from main.ts after both services are initialized.
   */
  setOrchestrator(orchestrator: ChiefOfStaff): void {
    this.orchestrator = orchestrator;
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
   * Process a parsed chunk and yield appropriate events.
   * Returns updated thinking state.
   */
  private *processThinkingChunk(
    parsed: ReturnType<ThinkingParser["processChunk"]>,
    thinkingParser: ThinkingParser,
    state: ThinkingState,
  ): Generator<ChatStreamEvent, ThinkingState> {
    const updatedState = { ...state };

    if (parsed.thinkingJustStarted) {
      yield { type: "activity", message: "Reasoning...", phase: "thinking" };
    }

    if (parsed.thinkingChunk) {
      updatedState.fullThinking += parsed.thinkingChunk;
      yield { type: "thinking", content: parsed.thinkingChunk };
    }

    if (parsed.thinkingJustEnded) {
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
      updatedState.fullContent += parsed.contentChunk;
      yield { type: "chunk", content: parsed.contentChunk };
    }

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
    return stats;
  }

  /**
   * Chat with streaming response - Hybrid Mode (Phase 5)
   *
   * Routes messages to either:
   * - Orchestrator for agent tasks (commands, workflows)
   * - Direct LLM for pure conversation
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
    yield { type: "started" };

    // Phase 5 Hybrid Mode: Check for delegation first
    const delegation = this.detectDelegation(message);

    if (delegation.shouldDelegate && delegation.confidence > 0.7 && this.orchestrator) {
      // Delegate to Orchestrator for agent tasks
      yield* this.handleDelegatedRequest(message, noteContext, history, delegation, signal);
      return;
    }

    // Pure conversation - use direct LLM for fast response
    yield* this.handleDirectConversation(message, noteContext, history, signal);
  }

  /**
   * Handle delegated request via Orchestrator (Phase 5)
   * Routes to the 4-Agent Swarm for agent tasks.
   */
  private async *handleDelegatedRequest(
    message: string,
    noteContext: ChatNoteContext | null,
    history: ChatMessage[],
    delegation: DelegationDetection,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    if (!this.orchestrator) {
      // Fallback to direct conversation if no orchestrator
      yield* this.handleDirectConversation(message, noteContext, history, signal);
      return;
    }

    // Emit delegation start event for UI
    yield { type: "delegation:start", delegation };
    yield {
      type: "activity",
      message: `Delegating to ${delegation.targetAgent || "agent"}...`,
      phase: "delegation",
    };

    // Build Orchestrator request
    const request = {
      source: "chat" as const,
      intent: message,
      noteContext: noteContext
        ? {
            title: noteContext.title,
            path: noteContext.path,
            content: noteContext.content,
            frontmatter: noteContext.frontmatter,
            wordCount: noteContext.wordCount,
          }
        : undefined,
      chatHistory: history,
    };

    try {
      // Stream Orchestrator events back to chat
      for await (const event of this.orchestrator.handleRequest(request, signal)) {
        yield { type: "delegation:event", event };
      }

      yield { type: "delegation:complete" };
      yield { type: "activity", message: "Complete", phase: "complete" };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        yield { type: "error", error: new DOMException("Delegation aborted", "AbortError") };
        return;
      }
      yield { type: "error", error: error as Error };
    }
  }

  /**
   * Handle direct conversation with LLM (existing chat logic)
   * Used for pure conversation that doesn't require agent delegation.
   */
  private async *handleDirectConversation(
    message: string,
    noteContext: ChatNoteContext | null,
    history: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    const startTime = Date.now();

    // Build context
    yield { type: "activity", message: "Building context...", phase: "context" };
    const contextStartTime = Date.now();

    const systemPrompt = this.buildSystemPrompt(noteContext);
    const messages = this.buildMessages(systemPrompt, message, history);
    const contextSize = messages.reduce((acc, m) => acc + m.content.length, 0);
    const contextTimeMs = Date.now() - contextStartTime;

    // Initialize thinking parser and state
    const thinkingParser = new ThinkingParser(this.config.thinkingConfig);
    let state: ThinkingState = {
      fullContent: "",
      fullThinking: "",
      thinkingTimeMs: 0,
      generationStartTime: Date.now(),
    };

    try {
      yield { type: "activity", message: "Generating response...", phase: "generating" };

      for await (const chunk of this.llm.stream(messages, { temperature: 0.7 }, signal)) {
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
      const finalParsed = thinkingParser.finalize();
      state.fullContent = finalParsed.content;
      state.fullThinking = finalParsed.thinking || "";

      const statistics = this.buildStatistics(startTime, contextTimeMs, contextSize, state);

      yield { type: "activity", message: "Complete", phase: "complete" };
      yield {
        type: "complete",
        content: state.fullContent,
        thinking: state.fullThinking || null,
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
   * Detect if message should be delegated to the Orchestrator (Phase 5)
   *
   * Detection happens via:
   * 1. Explicit slash commands (/classify, /enhance, /connect, etc.)
   * 2. Natural language intent matching ("classify this note", "find related", etc.)
   * 3. Action requests ("move this to", "create a note about", etc.)
   *
   * The Orchestrator then routes to the appropriate agent in the 4-Agent Swarm.
   */
  detectDelegation(message: string): DelegationDetection {
    const lowerMessage = message.toLowerCase().trim();

    // === Pattern 1: Explicit slash commands (highest confidence) ===
    const commandMatch = lowerMessage.match(
      /^\/(classify|enhance|connect|atomize|synthesize|challenge|extract-tasks|edit|improve|link|para|organize)/i,
    );
    if (commandMatch) {
      const command = commandMatch[1].toLowerCase();

      // Map commands to target agents in 4-Agent Swarm
      if (["edit", "improve", "enhance"].includes(command)) {
        return {
          shouldDelegate: true,
          targetAgent: "note-editor" as AgentType,
          instruction: message,
          confidence: 1.0,
        };
      }

      // Workflow commands → Worker agent
      return {
        shouldDelegate: true,
        targetAgent: "worker" as AgentType,
        workflow: command,
        instruction: message,
        confidence: 1.0,
      };
    }

    // === Pattern 2: Natural language intent detection ===
    const intents: Array<{
      pattern: RegExp;
      targetAgent: AgentType;
      workflow?: string;
      confidence: number;
    }> = [
      // Edit intents → NoteEditor
      {
        pattern: /\b(edit|change|update|modify|fix|rewrite|restructure)\s*(this|the)?\s*note\b/i,
        targetAgent: "note-editor",
        confidence: 0.85,
      },
      {
        pattern: /\b(add|append|insert)\s*(a|to|section|paragraph)/i,
        targetAgent: "note-editor",
        confidence: 0.8,
      },
      {
        pattern: /\b(improve|enhance)\s*(this|the)?\s*(note|content|writing)/i,
        targetAgent: "note-editor",
        confidence: 0.85,
      },

      // Classification intents → Worker (classify workflow)
      {
        pattern: /\b(classify|categorize|organize)\s*(this|the)?\s*note\b/i,
        targetAgent: "worker",
        workflow: "classify",
        confidence: 0.9,
      },
      {
        pattern: /\bpara\b|\bwhat folder\b|\bwhere.*belong/i,
        targetAgent: "worker",
        workflow: "classify",
        confidence: 0.85,
      },

      // Connection intents → Worker (connect workflow)
      {
        pattern: /\b(find|show|suggest)\s*(related|similar|connected)\s*notes?\b/i,
        targetAgent: "worker",
        workflow: "connect",
        confidence: 0.85,
      },
      {
        pattern: /\bconnections?\b|\bbacklinks?\b|\blink.*to\b/i,
        targetAgent: "worker",
        workflow: "connect",
        confidence: 0.8,
      },

      // Search intents → ContextBuilder
      {
        pattern: /\b(search|find|look for)\s*(in|across|through)?\s*(the)?\s*vault\b/i,
        targetAgent: "context-builder",
        confidence: 0.75,
      },

      // Atomize intents → Worker (atomize workflow)
      {
        pattern: /\b(break|split|atomize|decompose)\s*(down|into|this)\b/i,
        targetAgent: "worker",
        workflow: "atomize",
        confidence: 0.85,
      },
    ];

    for (const intent of intents) {
      if (intent.pattern.test(lowerMessage)) {
        return {
          shouldDelegate: true,
          targetAgent: intent.targetAgent,
          workflow: intent.workflow,
          instruction: message,
          confidence: intent.confidence,
        };
      }
    }

    // === Pattern 3: Keyword-based fallback (legacy support) ===
    const keywords = this.config.delegationKeywords;

    const editScore = this.calculateKeywordScore(lowerMessage, keywords.edit);
    if (editScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "note-editor" as AgentType,
        instruction: message,
        confidence: editScore * 0.8, // Lower confidence for keyword-only
      };
    }

    const classifyScore = this.calculateKeywordScore(lowerMessage, keywords.classify);
    if (classifyScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "worker" as AgentType,
        workflow: "classify",
        instruction: message,
        confidence: classifyScore * 0.8,
      };
    }

    const linkScore = this.calculateKeywordScore(lowerMessage, keywords.link);
    if (linkScore > 0.5) {
      return {
        shouldDelegate: true,
        targetAgent: "worker" as AgentType,
        workflow: "connect",
        instruction: message,
        confidence: linkScore * 0.8,
      };
    }

    // No delegation needed - pure conversation
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

    const score = totalWeight > 0 ? matches / totalWeight : 0;
    return score;
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

    const result = parts.join("\n");
    return result;
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
    const content =
      note.content.length > CHAT_LIMITS.MAX_CONTENT_LENGTH
        ? `${note.content.slice(0, CHAT_LIMITS.MAX_CONTENT_LENGTH)}...\n[Content truncated - ${note.wordCount} words total]`
        : note.content;

    lines.push(`\nContent:\n${content}`);

    const result = lines.join("\n");
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
    const config = { ...this.config };
    return config;
  }

  /**
   * Check if LLM is ready
   */
  get isReady(): boolean {
    const ready = this.llm.isReady;
    return ready;
  }
}
