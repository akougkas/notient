/**
 * Note Editor Agent
 *
 * Specialist agent for editing note content and frontmatter.
 * Temperature: 0.3 (precise, deterministic)
 * Output: Structured JSON (ProposedAction[])
 * Context Priority: Note + edit instructions
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Content Architect)
 */

import type { UserProfile } from "../../types/profile";
import type { ProposedAction, ProposedActionType, RiskLevel } from "../agentic/types";
import { SUPPORTED_ACTION_TYPES } from "../agentic/types";
import type { LLMProvider } from "../llm/provider";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, NoteEditOutput, StructuredOutput } from "./types";

// Risk map for actions
const RISK_MAP: Record<string, RiskLevel> = {
  frontmatter_set: "low",
  frontmatter_add_tags: "low",
  append_section: "low",
  append_related_links: "medium",
  move_note: "medium",
};

/**
 * Note Editor agent implementation
 */
export class NoteEditorAgent extends BaseAgent {
  private profile?: UserProfile;

  constructor(llm: LLMProvider, profile?: UserProfile) {
    super(llm, "note-editor");
    this.profile = profile;
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Build system prompt for note editing
   * Uses two-tier identity: Core Notient + Content Architect
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Build context string
    const contextParts: string[] = [];

    // Add current note content
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 4000));

    // Add user's edit request
    contextParts.push(`\nUSER REQUEST:\n${context.query}`);

    // Add related notes for link suggestions
    if (context.relatedNotes?.length) {
      const noteList = context.relatedNotes
        .slice(0, 5)
        .map((n) => `- [[${n.title}]] (${n.path})`)
        .join("\n");
      contextParts.push(`\nAVAILABLE NOTES FOR LINKING:\n${noteList}`);
    }

    // Add PARA context for move suggestions
    if (context.para) {
      const paraInfo = [
        `Projects: ${context.para.projects.join(", ") || "none"}`,
        `Areas: ${context.para.areas.join(", ") || "none"}`,
        `Resources: ${context.para.resources.join(", ") || "none"}`,
        `Archive: ${context.para.archive.join(", ") || "none"}`,
      ].join("\n");
      contextParts.push(`\nPARA FOLDERS:\n${paraInfo}`);
    }

    // Use unified identity system: Tier 1 (Core Notient) + Tier 2 (Content Architect)
    return buildAgentSystemPrompt("note-editor", this.profile, contextParts.join("\n"));
  }

  /**
   * Parse structured output from LLM
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput {
    const parsed = this.parseJSON<NoteEditOutput>(rawOutput);

    if (!parsed || !Array.isArray(parsed.actions)) {
      return {
        kind: "structured",
        agentType: "note-editor",
        schema: "NoteEditOutput",
        data: { actions: [] },
      };
    }

    // Validate and sanitize actions
    const validActions = this.validateActions(parsed.actions, context.currentNote.path);

    return {
      kind: "structured",
      agentType: "note-editor",
      schema: "NoteEditOutput",
      data: { actions: validActions },
    };
  }

  /**
   * Execute note editor agent (non-streaming for JSON output)
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", agentType: "note-editor" };
    yield { type: "progress", agentType: "note-editor", progress: 10 };

    const systemPrompt = this.buildSystemPrompt(context);
    const messages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: `Analyze and propose edits for this note. Output only valid JSON.`,
      },
    ];

    this.log(`Generating edit proposals for ${context.currentNote.path}`);

    try {
      yield { type: "progress", agentType: "note-editor", progress: 30 };

      // Non-streaming call for structured JSON
      const rawOutput = await this.completeLLM(messages);

      yield { type: "progress", agentType: "note-editor", progress: 70 };

      // Parse and validate
      const output = this.parseOutput(rawOutput, context);
      const editOutput = output.data as NoteEditOutput;

      this.log(`Generated ${editOutput.actions.length} edit proposals`);

      yield { type: "progress", agentType: "note-editor", progress: 100 };
      yield { type: "complete", agentType: "note-editor", output };
    } catch (error) {
      yield { type: "error", agentType: "note-editor", error: error as Error };
    }
  }

  /**
   * Validate and sanitize proposed actions
   */
  private validateActions(actions: unknown[], targetPath: string): ProposedAction[] {
    const validActions: ProposedAction[] = [];
    const seenIds = new Set<string>();

    for (const rawAction of actions.slice(0, 10)) {
      if (!this.isValidAction(rawAction)) continue;

      const action = rawAction as Partial<ProposedAction>;

      // Validate action type
      const actionType = action.type as ProposedActionType;
      if (!SUPPORTED_ACTION_TYPES.includes(actionType)) {
        this.warn(`Unknown or unsupported action type: ${action.type}`);
        continue;
      }

      // Enforce target path (security)
      const normalizedTarget = targetPath;

      // Generate unique ID
      const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Validate payload based on type
      if (!this.validatePayload(actionType, action.payload)) {
        this.warn(`Invalid payload for action type: ${actionType}`);
        continue;
      }

      validActions.push({
        id,
        type: actionType,
        risk: RISK_MAP[actionType] || "medium",
        title: String(action.title || "").slice(0, 50),
        reason: String(action.reason || "No reason provided"),
        target: normalizedTarget,
        requiresWriteLock: true,
        payload: action.payload,
      } as ProposedAction);
    }

    return validActions;
  }

  /**
   * Check if action has required fields
   */
  private isValidAction(action: unknown): action is Partial<ProposedAction> {
    if (!action || typeof action !== "object") return false;
    const a = action as Record<string, unknown>;
    return typeof a.type === "string" && typeof a.payload === "object";
  }

  /**
   * Validate payload structure for action type
   */
  private validatePayload(type: ProposedActionType, payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const p = payload as Record<string, unknown>;

    switch (type) {
      case "frontmatter_set":
        return typeof p.key === "string" && p.key.length > 0;

      case "frontmatter_add_tags":
        return Array.isArray(p.tags) && p.tags.every((t) => typeof t === "string");

      case "append_section":
        return typeof p.content === "string";

      case "append_related_links":
        return Array.isArray(p.links) && p.links.every((l) => typeof l === "string");

      case "move_note":
        return typeof p.to === "string" && p.to.length > 0;

      default:
        return false;
    }
  }
}
