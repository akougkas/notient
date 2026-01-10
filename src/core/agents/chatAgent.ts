/**
 * Chat Agent
 *
 * Conversational agent for dialogue with user about current note.
 * Temperature: 0.7 (creative but grounded)
 * Output: Conversational (streamed)
 * Context Priority: Note + chat history + can delegate to other agents
 *
 * This is the primary user-facing agent that can invoke specialist agents
 * when the conversation requires structured actions.
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Senior Advisor & Liaison)
 */

import type { UserProfile } from "../../types/profile";
import type { ChatMessage } from "../llm";
import type { LLMProvider } from "../llm/provider";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type {
  AgentContext,
  AgentEvent,
  AgentType,
  ConversationalOutput,
  DelegatedResult,
  DelegationRequest,
} from "./types";

/**
 * Delegation triggers detected in chat
 */
interface DelegationTrigger {
  agentType: AgentType;
  instruction: string;
  confidence: number;
}

/**
 * Chat agent for conversational interactions
 */
export class ChatAgent extends BaseAgent {
  private profile?: UserProfile;
  private delegationHandler?: (request: DelegationRequest) => Promise<DelegatedResult>;

  constructor(llm: LLMProvider, profile?: UserProfile) {
    super(llm, "chat");
    this.profile = profile;
  }

  /**
   * Update user profile for personalization
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Set handler for delegation requests
   * This is called by the Chief of Staff to enable agent-to-agent communication
   */
  setDelegationHandler(handler: (request: DelegationRequest) => Promise<DelegatedResult>): void {
    this.delegationHandler = handler;
  }

  /**
   * Build system prompt for chat agent
   * Uses two-tier identity: Core Notient + Senior Advisor & Liaison
   */
  protected buildSystemPrompt(context: AgentContext): string {
    const parts: string[] = [];

    // Build context string for identity system
    const contextParts: string[] = [];

    // Add current note
    contextParts.push(this.formatNoteForPrompt(context.currentNote));

    // Add context summary if available
    if (context.contextSummary) {
      contextParts.push(`\nVAULT CONTEXT:\n${context.contextSummary}`);
    }

    // Add related notes if available
    if (context.relatedNotes?.length) {
      contextParts.push(this.formatRelatedNotes(context.relatedNotes));
    }

    // Add active agents info for session awareness
    if (context.activeAgents.length > 0) {
      contextParts.push(`\nACTIVE SESSION AGENTS: ${context.activeAgents.join(", ")}`);
    }

    // Use unified identity system: Tier 1 (Core Notient) + Tier 2 (Senior Advisor)
    parts.push(buildAgentSystemPrompt("chat", this.profile, contextParts.join("\n")));

    return parts.join("\n");
  }

  /**
   * Parse conversational output
   */
  protected parseOutput(rawOutput: string, context: AgentContext): ConversationalOutput {
    // Extract citations from the response
    const citations = this.extractCitations(rawOutput);

    return {
      kind: "conversational",
      content: rawOutput,
      citations,
    };
  }

  /**
   * Execute chat agent with streaming
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", agentType: "chat" };

    // Build messages
    const systemPrompt = this.buildSystemPrompt(context);
    const messages = this.buildMessages(systemPrompt, context);

    this.log(`Starting chat with ${messages.length} messages`);

    // Stream the response
    let fullResponse = "";
    const delegatedResults: DelegatedResult[] = [];

    try {
      for await (const chunk of this.streamLLM(messages, signal)) {
        fullResponse += chunk;
        yield { type: "chunk", agentType: "chat", content: chunk };

        // Check for delegation triggers mid-stream
        const trigger = this.detectDelegationTrigger(fullResponse);
        if (
          trigger &&
          this.delegationHandler &&
          !this.hasDelegated(delegatedResults, trigger.agentType)
        ) {
          yield { type: "delegation-started", from: "chat", to: trigger.agentType };

          try {
            const request = this.createDelegationRequest(trigger.agentType, trigger.instruction);
            if (request) {
              const result = await this.delegationHandler(request);
              delegatedResults.push(result);
              yield { type: "delegation-complete", from: "chat", to: trigger.agentType, result };
            }
          } catch (error) {
            this.warn(`Delegation to ${trigger.agentType} failed:`, error);
          }
        }

        // Update progress based on response length
        const progress = Math.min(90, 20 + Math.floor(fullResponse.length / 50));
        yield { type: "progress", agentType: "chat", progress };
      }

      // Extract citations
      const citations = this.extractCitations(fullResponse);
      if (citations.length > 0) {
        yield { type: "citations", agentType: "chat", paths: citations };
      }

      // Build final output
      const output: ConversationalOutput = {
        kind: "conversational",
        content: fullResponse,
        citations,
        delegatedResults: delegatedResults.length > 0 ? delegatedResults : undefined,
      };

      yield { type: "progress", agentType: "chat", progress: 100 };
      yield { type: "complete", agentType: "chat", output };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        yield {
          type: "error",
          agentType: "chat",
          error: new DOMException("Chat aborted", "AbortError"),
        };
        return;
      }
      yield { type: "error", agentType: "chat", error: error as Error };
    }
  }

  /**
   * Detect delegation triggers in the response
   */
  private detectDelegationTrigger(text: string): DelegationTrigger | null {
    // Only support explicit delegation markers - no implicit keyword detection
    // Reason: Implicit triggers fire on LLM OUTPUT keywords like "connections" or "classify"
    // even when user asked for a simple summary, causing cascading agent activations
    const delegateMatch = text.match(/\[DELEGATE:(\w+-?\w*)\]/i);
    if (delegateMatch) {
      const agentType = delegateMatch[1] as AgentType;
      if (this.canDelegateTo(agentType)) {
        return {
          agentType,
          instruction: this.extractInstructionForAgent(text, agentType),
          confidence: 1.0,
        };
      }
    }

    return null;
  }

  /**
   * Extract specific instruction for delegated agent from context
   */
  private extractInstructionForAgent(text: string, agentType: AgentType): string {
    // Find sentence containing the delegation trigger
    const sentences = text.split(/[.!?]+/);
    const triggerSentence = sentences.find(
      (s) => s.toLowerCase().includes(agentType) || s.includes("[DELEGATE:"),
    );

    return triggerSentence?.trim() || `Process this note as ${agentType}`;
  }

  /**
   * Check if we've already delegated to this agent
   */
  private hasDelegated(results: DelegatedResult[], agentType: AgentType): boolean {
    return results.some((r) => r.agentType === agentType);
  }

  /**
   * Extract wiki-link citations from text
   */
  private extractCitations(text: string): string[] {
    const citations: string[] = [];
    const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;

    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const noteName = match[1].split("#")[0]; // Remove heading/block refs
      if (!citations.includes(noteName)) {
        citations.push(noteName);
      }
    }

    return citations;
  }
}
