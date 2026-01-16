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
import type { ResponseFormat } from "../llm/types";
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

/** Result of skill injection during execute() */
interface SkillInjectionResult {
  systemPrompt: string;
  activeSkill: { id: string; name: string; schema?: ResponseFormat } | null;
  creationMode: boolean;
}

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

  // ===========================================================================
  // Execute Helpers (Reduce Cognitive Complexity)
  // ===========================================================================

  /**
   * Inject relevant skills into the system prompt
   * Returns updated prompt and active skill info for creation mode
   */
  private injectSkills(context: AgentContext): SkillInjectionResult {
    let systemPrompt = this.buildSystemPrompt(context);
    let activeSkill: SkillInjectionResult["activeSkill"] = null;
    let creationMode = false;

    if (!this.skillRegistry) {
      return { systemPrompt, activeSkill, creationMode };
    }

    const skills = this.skillRegistry.identifyRelevantSkills(context.query);
    for (const skill of skills) {
      systemPrompt += `\n\n${skill.systemPrompt}`;
      this.log(`Injected skill: ${skill.name}`);

      if (skill.id === "json-canvas" || skill.id === "obsidian-bases") {
        // Cast schema from JsonSchemaFormat to ResponseFormat (compatible types)
        activeSkill = {
          id: skill.id,
          name: skill.name,
          schema: skill.schema as ResponseFormat | undefined,
        };
        creationMode = true;
      }
    }

    return { systemPrompt, activeSkill, creationMode };
  }

  /**
   * Build creation action from LLM output for Canvas/Base skills
   */
  private buildCreationAction(
    rawOutput: string,
    activeSkill: NonNullable<SkillInjectionResult["activeSkill"]>,
    context: AgentContext,
  ): StructuredOutput {
    const content = this.sanitizeLLMOutput(rawOutput);

    // Validate JSON integrity
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`Generated invalid JSON for ${activeSkill.name}`);
    }

    const actionType = activeSkill.id === "json-canvas" ? "create_canvas" : "create_base";
    const extension = activeSkill.id === "json-canvas" ? "canvas" : "base";

    // Determine target path
    const targetPath = context.currentNote.path.endsWith(".md")
      ? context.currentNote.path.replace(".md", `.${extension}`)
      : `${context.currentNote.path}.${extension}`;

    const action: ProposedAction = {
      id: generateId("act"),
      type: actionType as ProposedActionType,
      risk: "low",
      title: `Create ${activeSkill.name}`,
      reason: "User requested creation of specialized file",
      target: targetPath,
      requiresWriteLock: true,
      payload: { path: targetPath, content },
    } as ProposedAction;

    return {
      kind: "structured",
      agentType: "note-editor",
      schema: "NoteEditOutput",
      data: { actions: [action] },
    };
  }

  /**
   * Execute note editor agent (non-streaming for JSON output)
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    // 1. Inject skills and determine mode
    const { systemPrompt, activeSkill, creationMode } = this.injectSkills(context);

    // Emit started event
    yield { type: "started", agentType: "note-editor", activeSkill: activeSkill?.name };
    yield {
      type: "progress",
      agentType: "note-editor",
      progress: 10,
      activeSkill: activeSkill?.name,
    };

    // 2. Build messages
    const userContent = creationMode
      ? "Create the file based on the request. Output ONLY valid JSON matching the schema."
      : "Analyze and propose edits for this note. Output only valid JSON.";

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userContent },
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

      // 3. Configure options and call LLM
      const options = this.getCompletionOptions();
      if (creationMode && activeSkill?.schema) {
        options.responseFormat = activeSkill.schema;
        this.log(`Using strict schema for ${activeSkill.name}`);
      }

      const rawOutput = await this.llm.complete(messages, options);
      yield {
        type: "progress",
        agentType: "note-editor",
        progress: 70,
        activeSkill: activeSkill?.name,
      };

      // 4. Parse output based on mode
      const output =
        creationMode && activeSkill
          ? this.buildCreationAction(rawOutput, activeSkill, context)
          : this.parseOutput(rawOutput, context);

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
    if (!payload || typeof payload !== "object") {
      console.debug(`[Note Editor] Invalid payload for ${type}: not an object`, payload);
      return false;
    }
    const p = payload as Record<string, unknown>;

    switch (type) {
      case "frontmatter_set":
        return this.validateFrontmatterSetPayload(p);
      case "frontmatter_add_tags":
        return this.validateFrontmatterAddTagsPayload(p);
      case "append_section":
        return this.validateAppendSectionPayload(p);
      case "append_related_links":
        return this.validateAppendRelatedLinksPayload(p);
      case "move_note":
        return this.validateMoveNotePayload(p);
      case "create_note":
      case "create_canvas":
      case "create_base":
        return this.validateCreateFilePayload(p, type);
      default:
        console.debug(`[Note Editor] Unknown action type: ${type}`);
        return false;
    }
  }

  /**
   * Validate frontmatter_set payload
   */
  private validateFrontmatterSetPayload(p: Record<string, unknown>): boolean {
    // Check standard format: { key: string, value: any }
    const hasKey = typeof p.key === "string" && p.key.length > 0;
    const hasValue = "value" in p;

    if (hasKey && hasValue) {
      return true;
    }

    // Handle LLM variations - check all common key field names
    const altKey = p.field || p.property || p.name || p.attribute || p.setting || p.frontmatterKey;
    const altValue = p.newValue ?? p.frontmatterValue ?? p.value;

    if (typeof altKey === "string" && altKey.length > 0 && altValue !== undefined) {
      // Normalize to standard format
      p.key = altKey as string;
      p.value = altValue;
      console.warn(
        `[Note Editor] Normalized frontmatter_set payload from alternate format. key: ${p.key}`,
      );
      return true;
    }

    // Handle shorthand format: { someKey: someValue }
    // If payload has exactly one key (not "key" or "value"), treat it as shorthand
    const keys = Object.keys(p);
    if (keys.length === 1 && keys[0] !== "key" && keys[0] !== "value") {
      const shorthandKey = keys[0];
      const shorthandValue = p[shorthandKey];
      // Normalize to standard format
      p.key = shorthandKey;
      p.value = shorthandValue;
      console.log(
        `[Note Editor] Normalized shorthand payload: {${shorthandKey}} -> {key: ${shorthandKey}, value: ${JSON.stringify(shorthandValue)}}`,
      );
      return true;
    }

    console.warn(
      "[Note Editor] Invalid payload for frontmatter_set. Expected { key: string, value: any }. Got:",
      JSON.stringify(p, null, 2),
    );
    return false;
  }

  /**
   * Validate frontmatter_add_tags payload
   */
  private validateFrontmatterAddTagsPayload(p: Record<string, unknown>): boolean {
    const valid = Array.isArray(p.tags) && p.tags.every((t) => typeof t === "string");
    if (!valid) {
      console.debug(
        "[Note Editor] Invalid payload for frontmatter_add_tags. Expected { tags: string[] }. Got:",
        JSON.stringify(p, null, 2),
      );
    }
    return valid;
  }

  /**
   * Validate append_section payload
   */
  private validateAppendSectionPayload(p: Record<string, unknown>): boolean {
    const valid = typeof p.content === "string";
    if (!valid) {
      console.debug(
        "[Note Editor] Invalid payload for append_section. Expected { content: string }. Got:",
        JSON.stringify(p, null, 2),
      );
    }
    return valid;
  }

  /**
   * Validate append_related_links payload
   */
  private validateAppendRelatedLinksPayload(p: Record<string, unknown>): boolean {
    const valid = Array.isArray(p.links) && p.links.every((l) => typeof l === "string");
    if (!valid) {
      console.debug(
        "[Note Editor] Invalid payload for append_related_links. Expected { links: string[] }. Got:",
        JSON.stringify(p, null, 2),
      );
    }
    return valid;
  }

  /**
   * Validate move_note payload
   */
  private validateMoveNotePayload(p: Record<string, unknown>): boolean {
    const valid = typeof p.to === "string" && p.to.length > 0;
    if (!valid) {
      console.debug(
        "[Note Editor] Invalid payload for move_note. Expected { to: string }. Got:",
        JSON.stringify(p, null, 2),
      );
    }
    return valid;
  }

  /**
   * Validate create_note/create_canvas/create_base payload
   */
  private validateCreateFilePayload(p: Record<string, unknown>, type: string): boolean {
    const valid = typeof p.path === "string" && typeof p.content === "string";
    if (!valid) {
      console.debug(
        `[Note Editor] Invalid payload for ${type}. Expected { path: string, content: string }. Got:`,
        JSON.stringify(p, null, 2),
      );
    }
    return valid;
  }
}
