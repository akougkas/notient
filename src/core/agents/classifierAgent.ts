/**
 * Classifier Agent
 *
 * Specialist agent for PARA classification and tagging.
 * Temperature: 0.2 (highly deterministic)
 * Output: Structured JSON (ClassificationOutput)
 * Context Priority: Note + PARA folder structure
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Knowledge Taxonomist)
 */

import type { UserProfile } from "../../types/profile";
import type { LLMProvider } from "../llm/provider";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, ClassificationOutput, StructuredOutput } from "./types";

/**
 * Classifier agent implementation
 */
export class ClassifierAgent extends BaseAgent {
  private profile?: UserProfile;

  constructor(llm: LLMProvider, profile?: UserProfile) {
    console.log("[classifierAgent:constructor] TRACE: START");
    super(llm, "classifier");
    this.profile = profile;
    console.log("[classifierAgent:constructor] TRACE: END");
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    console.log(`[classifierAgent:setProfile] TRACE: START hasProfile=${!!profile}`);
    this.profile = profile;
    console.log("[classifierAgent:setProfile] TRACE: END");
  }

  /**
   * Build system prompt for classification
   * Uses two-tier identity: Core Notient + Knowledge Taxonomist
   */
  protected buildSystemPrompt(context: AgentContext): string {
    console.log(
      `[classifierAgent:buildSystemPrompt] TRACE: START noteTitle=${context.currentNote.title}`,
    );
    // Build context string
    const contextParts: string[] = [];

    // Add current note (full content for accurate classification)
    console.log("[classifierAgent:buildSystemPrompt] TRACE: formatting note for prompt");
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 3000));

    // Add PARA folder structure (critical for classification)
    if (context.para) {
      console.log("[classifierAgent:buildSystemPrompt] TRACE: adding PARA folders");
      const paraFolders = [
        `Inbox folders: ${context.para.inbox.join(", ") || "none configured"}`,
        `Project folders: ${context.para.projects.join(", ") || "none configured"}`,
        `Area folders: ${context.para.areas.join(", ") || "none configured"}`,
        `Resource folders: ${context.para.resources.join(", ") || "none configured"}`,
        `Archive folders: ${context.para.archive.join(", ") || "none configured"}`,
      ].join("\n");
      contextParts.push(`\nCONFIGURED PARA FOLDERS:\n${paraFolders}`);
    }

    // Add current folder context
    const currentFolder = context.currentNote.path.split("/").slice(0, -1).join("/");
    if (currentFolder) {
      contextParts.push(`\nCURRENT LOCATION: ${currentFolder}`);
    }

    // Add user's specific classification request if any
    if (context.query && context.query !== "classify") {
      contextParts.push(`\nUSER CONTEXT: ${context.query}`);
    }

    // Use unified identity system: Tier 1 (Core Notient) + Tier 2 (Knowledge Taxonomist)
    console.log("[classifierAgent:buildSystemPrompt] TRACE: calling buildAgentSystemPrompt");
    const result = buildAgentSystemPrompt("classifier", this.profile, contextParts.join("\n"));
    console.log(`[classifierAgent:buildSystemPrompt] TRACE: END promptLength=${result.length}`);
    return result;
  }

  /**
   * Parse classification output from LLM
   * Robust handling: sanitizes control chars, handles parse failures gracefully
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput {
    console.log(`[classifierAgent:parseOutput] TRACE: START rawOutputLength=${rawOutput.length}`);
    let parsed: ClassificationOutput | null = null;

    try {
      console.log("[classifierAgent:parseOutput] TRACE: sanitizing output");
      const sanitized = this.sanitizeLLMOutput(rawOutput);
      console.log("[classifierAgent:parseOutput] TRACE: parsing JSON");
      parsed = this.parseJSON<ClassificationOutput>(sanitized);
      console.log(`[classifierAgent:parseOutput] TRACE: parsed=${!!parsed}`);
    } catch (error) {
      this.warn("JSON parse failed, using defaults:", error);
    }

    // Validate and provide defaults (graceful degradation)
    console.log("[classifierAgent:parseOutput] TRACE: validating classification");
    const classification: ClassificationOutput = {
      paraCategory: this.validateCategory(parsed?.paraCategory) || "inbox",
      confidence: this.validateConfidence(parsed?.confidence) || 0.5,
      reasoning: parsed?.reasoning || "Unable to determine classification",
      suggestedTags: this.validateTags(parsed?.suggestedTags) || [],
      suggestedFolder: this.validateFolder(parsed?.suggestedFolder, context.para),
    };

    console.log(`[classifierAgent:parseOutput] TRACE: END category=${classification.paraCategory}`);
    return {
      kind: "structured",
      agentType: "classifier",
      schema: "ClassificationOutput",
      data: classification,
    };
  }

  /**
   * Execute classifier agent
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    console.log(`[classifierAgent:execute] TRACE: START noteTitle=${context.currentNote.title}`);
    console.log("[classifierAgent:execute] TRACE: yielding started event");
    yield { type: "started", agentType: "classifier" };
    console.log("[classifierAgent:execute] TRACE: yielded started event");
    console.log("[classifierAgent:execute] TRACE: yielding progress 10");
    yield { type: "progress", agentType: "classifier", progress: 10 };
    console.log("[classifierAgent:execute] TRACE: yielded progress 10");

    console.log("[classifierAgent:execute] TRACE: building system prompt");
    const systemPrompt = this.buildSystemPrompt(context);
    console.log(
      `[classifierAgent:execute] TRACE: system prompt built, length=${systemPrompt.length}`,
    );
    const messages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content:
          "Classify this note using PARA methodology. Consider its content, structure, and purpose. Output only valid JSON.",
      },
    ];

    this.log(`Classifying note: ${context.currentNote.title}`);

    try {
      console.log("[classifierAgent:execute] TRACE: yielding progress 30");
      yield { type: "progress", agentType: "classifier", progress: 30 };
      console.log("[classifierAgent:execute] TRACE: yielded progress 30");

      console.log("[classifierAgent:execute] TRACE: calling completeLLM");
      const rawOutput = await this.completeLLM(messages);
      console.log(
        `[classifierAgent:execute] TRACE: completeLLM returned, length=${rawOutput.length}`,
      );

      console.log("[classifierAgent:execute] TRACE: yielding progress 70");
      yield { type: "progress", agentType: "classifier", progress: 70 };
      console.log("[classifierAgent:execute] TRACE: yielded progress 70");

      console.log("[classifierAgent:execute] TRACE: parsing output");
      const output = this.parseOutput(rawOutput, context);
      const classification = output.data as ClassificationOutput;
      console.log(
        `[classifierAgent:execute] TRACE: output parsed, category=${classification.paraCategory}`,
      );

      this.log(
        `Classification: ${classification.paraCategory} (confidence: ${classification.confidence})`,
      );

      console.log("[classifierAgent:execute] TRACE: yielding progress 100");
      yield { type: "progress", agentType: "classifier", progress: 100 };
      console.log("[classifierAgent:execute] TRACE: yielded progress 100");
      console.log("[classifierAgent:execute] TRACE: yielding complete event");
      yield { type: "complete", agentType: "classifier", output };
      console.log("[classifierAgent:execute] TRACE: yielded complete event");
      console.log("[classifierAgent:execute] TRACE: END (success)");
    } catch (error) {
      console.log(`[classifierAgent:execute] TRACE: caught error: ${(error as Error).message}`);
      console.log("[classifierAgent:execute] TRACE: yielding error event");
      yield { type: "error", agentType: "classifier", error: error as Error };
      console.log("[classifierAgent:execute] TRACE: yielded error event");
      console.log("[classifierAgent:execute] TRACE: END (error)");
    }
  }

  /**
   * Validate PARA category
   */
  private validateCategory(
    category: string | undefined,
  ): ClassificationOutput["paraCategory"] | null {
    console.log(`[classifierAgent:validateCategory] TRACE: START category=${category}`);
    const valid = ["project", "area", "resource", "archive", "inbox"];
    if (category && valid.includes(category)) {
      console.log("[classifierAgent:validateCategory] TRACE: END (valid)");
      return category as ClassificationOutput["paraCategory"];
    }
    console.log("[classifierAgent:validateCategory] TRACE: END (invalid)");
    return null;
  }

  /**
   * Validate confidence score
   */
  private validateConfidence(confidence: number | undefined): number | null {
    console.log(`[classifierAgent:validateConfidence] TRACE: START confidence=${confidence}`);
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
      console.log("[classifierAgent:validateConfidence] TRACE: END (valid)");
      return confidence;
    }
    console.log("[classifierAgent:validateConfidence] TRACE: END (invalid)");
    return null;
  }

  /**
   * Validate and clean tags
   */
  private validateTags(tags: unknown): string[] | null {
    console.log(`[classifierAgent:validateTags] TRACE: START isArray=${Array.isArray(tags)}`);
    if (!Array.isArray(tags)) {
      console.log("[classifierAgent:validateTags] TRACE: END (not array)");
      return null;
    }

    const result = tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().replace(/\s+/g, "-"))
      .filter((t) => t.length > 0 && t.length < 50)
      .slice(0, 10);
    console.log(`[classifierAgent:validateTags] TRACE: END tagsCount=${result.length}`);
    return result;
  }

  /**
   * Validate suggested folder against PARA structure
   */
  private validateFolder(
    folder: string | undefined,
    para: AgentContext["para"],
  ): string | undefined {
    console.log(`[classifierAgent:validateFolder] TRACE: START folder=${folder}`);
    if (!folder || typeof folder !== "string") {
      console.log("[classifierAgent:validateFolder] TRACE: END (no folder)");
      return undefined;
    }

    // Check if folder exists in PARA configuration
    if (para) {
      const allFolders = [
        ...para.inbox,
        ...para.projects,
        ...para.areas,
        ...para.resources,
        ...para.archive,
      ];

      if (allFolders.some((f) => folder.startsWith(f))) {
        console.log("[classifierAgent:validateFolder] TRACE: END (valid folder)");
        return folder;
      }
    }

    console.log("[classifierAgent:validateFolder] TRACE: END (invalid folder)");
    return undefined;
  }
}
