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
import { generateId } from "../ids";
import type { LLMProvider } from "../llm/provider";
import type { SkillRegistry } from "../skills/registry";
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
  create_note: "low",
  create_canvas: "low",
  create_base: "low",
};

/**
 * Note Editor agent implementation
 */
export class NoteEditorAgent extends BaseAgent {
  private profile?: UserProfile;
  private skillRegistry?: SkillRegistry;

  constructor(llm: LLMProvider, profile?: UserProfile, skillRegistry?: SkillRegistry) {
    super(llm, "note-editor");
    this.profile = profile;
    this.skillRegistry = skillRegistry;
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Inject Skill Registry (if not provided in constructor)
   */
  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
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
   * Robust handling: sanitizes control chars, handles parse failures gracefully
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput {
    let parsed: NoteEditOutput | null = null;

    try {
      const sanitized = this.sanitizeLLMOutput(rawOutput);
      parsed = this.parseJSON<NoteEditOutput>(sanitized);
    } catch (error) {
      this.warn("JSON parse failed, returning empty proposals:", error);
    }

    // Graceful fallback: return empty proposals on any parse failure
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
    // 1. Check for Skills (Dynamic Injection)
    let activeSkill = null;
    let systemPrompt = this.buildSystemPrompt(context);
    let creationMode = false;

    if (this.skillRegistry) {
      const skills = this.skillRegistry.identifyRelevantSkills(context.query);
      for (const skill of skills) {
        // Inject skill knowledge
        systemPrompt += `\n\n${skill.systemPrompt}`;
        this.log(`Injected skill: ${skill.name}`);

        // Check if this is a creation skill (Canvas/Base)
        if (skill.id === "json-canvas" || skill.id === "obsidian-bases") {
          activeSkill = skill;
          creationMode = true;
        }
      }
    }

    // Emit started event with active skill
    yield { type: "started", agentType: "note-editor", activeSkill: activeSkill?.name };
    yield {
      type: "progress",
      agentType: "note-editor",
      progress: 10,
      activeSkill: activeSkill?.name,
    };

    // 2. Build Messages
    const messages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: creationMode
          ? "Create the file based on the request. Output ONLY valid JSON matching the schema."
          : "Analyze and propose edits for this note. Output only valid JSON.",
      },
    ];

    this.log(
      `Generating ${creationMode ? "content" : "edit proposals"} for ${context.currentNote.path}`,
    );

    try {
      yield {
        type: "progress",
        agentType: "note-editor",
        progress: 30,
        activeSkill: activeSkill?.name,
      };

      // 3. Configure Options (Schema Injection)
      const options = this.getCompletionOptions();
      if (creationMode && activeSkill?.schema) {
        options.responseFormat = activeSkill.schema;
        this.log(`Using strict schema for ${activeSkill.name}`);
      }

      // 4. Call LLM
      const rawOutput = await this.llm.complete(messages, options);

      yield {
        type: "progress",
        agentType: "note-editor",
        progress: 70,
        activeSkill: activeSkill?.name,
      };

      // 5. Parse Output
      let output: StructuredOutput;

      if (creationMode && activeSkill) {
        // SPECIAL MODE: Wrap raw content in a creation action
        const content = this.sanitizeLLMOutput(rawOutput);

        // Validate JSON integrity check
        try {
          JSON.parse(content);
        } catch (e) {
          throw new Error(`Generated invalid JSON for ${activeSkill.name}`);
        }

        const actionType = activeSkill.id === "json-canvas" ? "create_canvas" : "create_base";
        const extension = activeSkill.id === "json-canvas" ? "canvas" : "base";

        // Determine filename from query or default
        // Simple heuristic: look for "named X" or use "Untitled"
        // In a real system, we might ask LLM for the filename too, but for now we use target from context or generate one
        const filename = `Untitled.${extension}`; // This should ideally be smarter, but the user usually provides a path in context or we can extract it.
        // Actually, context.currentNote.path might be the target if the user said "create X here".
        // But usually creation happens in a new file.
        // Let's assume the Orchestrator passed a target path if known, or we default.
        // For now, we will assume the Orchestrator/Chat provided a target path in the context or we use a timestamp.
        const targetPath = context.currentNote.path.endsWith(".md")
          ? context.currentNote.path.replace(".md", `.${extension}`)
          : `${context.currentNote.path}.${extension}`;

        const action: ProposedAction = {
          id: generateId("act"),
          type: actionType as any, // Cast to ProposedActionType
          risk: "low",
          title: `Create ${activeSkill.name}`,
          reason: "User requested creation of specialized file",
          target: targetPath,
          requiresWriteLock: true,
          payload: {
            path: targetPath,
            content: content,
          },
        } as any; // Cast to satisfy specific payload types

        output = {
          kind: "structured",
          agentType: "note-editor",
          schema: "NoteEditOutput",
          data: { actions: [action] },
        };
      } else {
        // STANDARD MODE: Parse ProposedAction[]
        output = this.parseOutput(rawOutput, context);
      }

      const editOutput = output.data as NoteEditOutput;
      this.log(`Generated ${editOutput.actions.length} actions`);

      yield {
        type: "progress",
        agentType: "note-editor",
        progress: 100,
        activeSkill: activeSkill?.name,
      };
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

    if (!Array.isArray(actions)) return [];

    for (const rawAction of actions.slice(0, 10)) {
      if (!this.isValidAction(rawAction)) continue;

      const action = rawAction as Partial<ProposedAction>;

      // Validate action type
      const actionType = action.type as ProposedActionType;
      // Allow new creation types if they pass through here (though usually handled in creationMode block)
      if (
        !SUPPORTED_ACTION_TYPES.includes(actionType) &&
        !["create_canvas", "create_base"].includes(actionType)
      ) {
        this.warn(`Unknown or unsupported action type: ${action.type}`);
        continue;
      }

      // Enforce target path (security)
      const normalizedTarget = targetPath;

      // Generate unique ID (standardized format: act_{uuid8})
      const id = generateId("act");
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

      case "create_note":
      case "create_canvas":
      case "create_base":
        return typeof p.path === "string" && typeof p.content === "string";

      default:
        return false;
    }
  }
}
