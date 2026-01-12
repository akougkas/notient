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
    super(llm, "classifier");
    this.profile = profile;
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Build system prompt for classification
   * Uses two-tier identity: Core Notient + Knowledge Taxonomist
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Build context string
    const contextParts: string[] = [];

    // Add current note (full content for accurate classification)
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 3000));

    // Add PARA folder structure (critical for classification)
    if (context.para) {
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
    const result = buildAgentSystemPrompt("classifier", this.profile, contextParts.join("\n"));
    return result;
  }

  /**
   * Parse classification output from LLM
   * Robust handling: sanitizes control chars, handles parse failures gracefully
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput {
    let parsed: ClassificationOutput | null = null;

    try {
      const sanitized = this.sanitizeLLMOutput(rawOutput);
      parsed = this.parseJSON<ClassificationOutput>(sanitized);
    } catch (error) {
      this.warn("JSON parse failed, using defaults:", error);
    }

    // Validate and provide defaults (graceful degradation)
    const classification: ClassificationOutput = {
      paraCategory: this.validateCategory(parsed?.paraCategory) || "inbox",
      confidence: this.validateConfidence(parsed?.confidence) || 0.5,
      reasoning: parsed?.reasoning || "Unable to determine classification",
      suggestedTags: this.validateTags(parsed?.suggestedTags) || [],
      suggestedFolder: this.validateFolder(parsed?.suggestedFolder, context.para),
    };

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
    yield { type: "started", agentType: "classifier" };
    yield { type: "progress", agentType: "classifier", progress: 10 };

    const systemPrompt = this.buildSystemPrompt(context);
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
      yield { type: "progress", agentType: "classifier", progress: 30 };

      const rawOutput = await this.completeLLM(messages);

      yield { type: "progress", agentType: "classifier", progress: 70 };

      const output = this.parseOutput(rawOutput, context);
      const classification = output.data as ClassificationOutput;
      console.log(
        `[ClassifierAgent] Classification: ${classification.paraCategory} (confidence: ${classification.confidence})`,
      );

      yield { type: "progress", agentType: "classifier", progress: 100 };
      yield { type: "complete", agentType: "classifier", output };
    } catch (error) {
      yield { type: "error", agentType: "classifier", error: error as Error };
    }
  }

  /**
   * Validate PARA category
   */
  private validateCategory(
    category: string | undefined,
  ): ClassificationOutput["paraCategory"] | null {
    const valid = ["project", "area", "resource", "archive", "inbox"];
    if (category && valid.includes(category)) {
      return category as ClassificationOutput["paraCategory"];
    }
    return null;
  }

  /**
   * Validate confidence score
   */
  private validateConfidence(confidence: number | undefined): number | null {
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
      return confidence;
    }
    return null;
  }

  /**
   * Validate and clean tags
   */
  private validateTags(tags: unknown): string[] | null {
    if (!Array.isArray(tags)) {
      return null;
    }

    const result = tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().replace(/\s+/g, "-"))
      .filter((t) => t.length > 0 && t.length < 50)
      .slice(0, 10);
    return result;
  }

  /**
   * Validate suggested folder against PARA structure
   */
  private validateFolder(
    folder: string | undefined,
    para: AgentContext["para"],
  ): string | undefined {
    if (!folder || typeof folder !== "string") {
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
        return folder;
      }
    }

    return undefined;
  }
}
