/**
 * Action Pipeline
 *
 * Multi-phase execution pipeline for Intelligence 2.0 actions.
 * Handles preparation, analysis, planning, batching, and progressive disclosure.
 */

import type { LMStudioService } from "../../services/lmstudio";
import type { ProposedAction, RiskLevel } from "../agentic/types";
import type { SearchPipeline } from "../search/pipeline";
import type { WorkflowComplexity } from "./actionOrchestrator";
import type { AgentPrompt, IntelligenceActionType } from "./prompts";

/**
 * Pipeline execution phase
 */
export type PipelinePhase =
  | "preparation"
  | "analysis"
  | "planning"
  | "batching"
  | "complete"
  | "error";

/**
 * Events emitted during pipeline execution
 */
export type PipelineEvent =
  | { type: "phase"; phase: PipelinePhase; progress: number }
  | { type: "chunk"; content: string }
  | { type: "analysis"; analysis: string }
  | { type: "actions"; actions: ProposedAction[] }
  | { type: "batches"; batches: ActionBatch[] }
  | { type: "complete"; result: PipelineResult }
  | { type: "error"; error: Error };

/**
 * A batch of related actions
 */
export interface ActionBatch {
  id: string;
  title: string;
  actions: ProposedAction[];
  dependencies: string[];
}

/**
 * Result of executing a single batch
 */
export interface BatchExecutionResult {
  batchId: string;
  success: boolean;
  appliedCount: number;
  failedCount: number;
  errors: string[];
}

/**
 * Callback type for applying a single action
 */
export type ActionApplierFn = (
  action: ProposedAction,
) => Promise<{ success: boolean; error?: string }>;

/**
 * Execute batches in dependency order (topological sort)
 * Ensures create actions run before update actions, which run before link actions
 *
 * @param batches - Array of ActionBatch objects with dependencies
 * @param applyAction - Callback function to apply a single action
 * @returns Results for each batch in execution order
 */
export async function executeBatchesInOrder(
  batches: ActionBatch[],
  applyAction: ActionApplierFn,
): Promise<BatchExecutionResult[]> {
  const results: BatchExecutionResult[] = [];
  const completed = new Set<string>();

  // Build a map for quick lookup
  const batchMap = new Map(batches.map((b) => [b.id, b]));

  // Topological sort using Kahn's algorithm
  const sortedBatches = topologicalSort(batches);

  for (const batch of sortedBatches) {
    // Verify all dependencies are completed
    const missingDeps = batch.dependencies.filter(
      (dep) => batchMap.has(dep) && !completed.has(dep),
    );

    if (missingDeps.length > 0) {
      // This shouldn't happen with correct topological sort, but be defensive
      results.push({
        batchId: batch.id,
        success: false,
        appliedCount: 0,
        failedCount: batch.actions.length,
        errors: [`Missing dependencies: ${missingDeps.join(", ")}`],
      });
      continue;
    }

    // Execute all actions in this batch
    const batchResult: BatchExecutionResult = {
      batchId: batch.id,
      success: true,
      appliedCount: 0,
      failedCount: 0,
      errors: [],
    };

    for (const action of batch.actions) {
      const result = await applyAction(action);
      if (result.success) {
        batchResult.appliedCount++;
      } else {
        batchResult.failedCount++;
        batchResult.errors.push(result.error || `Failed to apply action: ${action.id}`);
      }
    }

    // Batch is successful if at least one action succeeded
    batchResult.success = batchResult.appliedCount > 0;
    results.push(batchResult);
    completed.add(batch.id);
  }

  return results;
}

/**
 * Topological sort of batches based on dependencies
 * Uses Kahn's algorithm for deterministic ordering
 */
function topologicalSort(batches: ActionBatch[]): ActionBatch[] {
  const batchMap = new Map(batches.map((b) => [b.id, b]));
  const inDegree = new Map<string, number>();
  const result: ActionBatch[] = [];

  // Initialize in-degree for all batches
  for (const batch of batches) {
    inDegree.set(batch.id, 0);
  }

  // Calculate in-degree (count of dependencies that exist in our batch set)
  for (const batch of batches) {
    for (const dep of batch.dependencies) {
      if (batchMap.has(dep)) {
        inDegree.set(batch.id, (inDegree.get(batch.id) || 0) + 1);
      }
    }
  }

  // Start with batches that have no dependencies (in-degree = 0)
  const queue: ActionBatch[] = batches.filter((b) => (inDegree.get(b.id) || 0) === 0);

  while (queue.length > 0) {
    const batch = queue.shift();
    if (!batch) break; // Shouldn't happen, but satisfy the linter
    result.push(batch);

    // Reduce in-degree for batches that depend on this one
    for (const other of batches) {
      if (other.dependencies.includes(batch.id)) {
        const newDegree = (inDegree.get(other.id) || 0) - 1;
        inDegree.set(other.id, newDegree);
        if (newDegree === 0) {
          queue.push(other);
        }
      }
    }
  }

  // If result doesn't contain all batches, there's a cycle (shouldn't happen with our batch types)
  if (result.length !== batches.length) {
    console.warn("[ActionPipeline] Cycle detected in batch dependencies, returning original order");
    return batches;
  }

  return result;
}

/**
 * Result of pipeline execution
 */
export interface PipelineResult {
  actionType: IntelligenceActionType;
  analysis: string;
  actions: ProposedAction[];
  batches?: ActionBatch[];
  citations: string[];
}

/**
 * Configuration for action pipeline
 */
export interface ActionPipelineConfig {
  actionType: IntelligenceActionType;
  prompt: AgentPrompt;
  complexity: WorkflowComplexity;
  context: {
    notePath: string;
    noteTitle: string;
    noteContent: string;
    relatedNotes?: Array<{
      path: string;
      title: string;
      content: string;
    }>;
    config?: Record<string, unknown>;
  };
  triggerConfig?: Record<string, unknown>;
  llm: LMStudioService;
  search: SearchPipeline;
  /** Set of existing vault paths for duplicate detection */
  existingPaths?: Set<string>;
}

/**
 * Action Pipeline - Multi-phase execution for Intelligence 2.0 actions
 */
export interface ActionPipeline {
  execute(): AsyncGenerator<PipelineEvent>;
}

/**
 * Create an action pipeline
 */
export function createActionPipeline(config: ActionPipelineConfig): ActionPipeline {
  return new ActionPipelineImpl(config);
}

/**
 * Implementation of ActionPipeline
 */
class ActionPipelineImpl implements ActionPipeline {
  private config: ActionPipelineConfig;

  constructor(config: ActionPipelineConfig) {
    this.config = config;
  }

  async *execute(): AsyncGenerator<PipelineEvent> {
    try {
      // Phase 1: Preparation
      yield { type: "phase", phase: "preparation", progress: 10 };
      const preparedContext = await this.prepare();

      // Phase 2: Analysis (streaming)
      yield { type: "phase", phase: "analysis", progress: 30 };
      let rawResponse = "";

      const userPrompt = this.buildUserPrompt(preparedContext);
      const systemPrompt = this.config.prompt.system;

      // Stream the LLM response
      for await (const chunk of this.streamAnalysis(systemPrompt, userPrompt)) {
        rawResponse += chunk;
        yield { type: "chunk", content: chunk };
      }

      // Phase 3: Planning
      yield { type: "phase", phase: "planning", progress: 70 };
      const { parsedAnalysis, actions } = this.parseResponse(rawResponse);

      yield { type: "analysis", analysis: parsedAnalysis };
      yield { type: "actions", actions };

      // Phase 4: Batch Handling (if applicable)
      let batches: ActionBatch[] | undefined;
      if (this.config.complexity === "batch" && actions.length > 0) {
        yield { type: "phase", phase: "batching", progress: 85 };
        batches = this.createBatches(actions);
        yield { type: "batches", batches };
      }

      // Phase 5: Complete
      yield { type: "phase", phase: "complete", progress: 100 };

      const result: PipelineResult = {
        actionType: this.config.actionType,
        analysis: parsedAnalysis,
        actions,
        batches,
        citations: preparedContext.citations,
      };

      yield { type: "complete", result };
    } catch (error) {
      yield { type: "phase", phase: "error", progress: 0 };
      yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Prepare context for analysis
   */
  private async prepare(): Promise<{
    noteContent: string;
    relatedNotes: string;
    citations: string[];
  }> {
    const { context, search } = this.config;
    const citations: string[] = [];

    // Get related notes via search if not provided
    let relatedNotes = context.relatedNotes || [];
    if (relatedNotes.length === 0 && search) {
      try {
        // Use standard search options
        const searchResults = await search.search(context.noteTitle, {
          topK: 5,
          minScore: 0.3,
          includeContent: true,
        });

        // Filter out current note
        const filteredResults = searchResults.filter((r) => r.path !== context.notePath);

        relatedNotes = filteredResults.map((r) => ({
          path: r.path,
          title: r.title,
          // Get text from the first chunk or empty string
          content: r.chunks?.[0]?.text || "",
        }));

        for (const r of filteredResults) {
          citations.push(r.path);
        }
      } catch {
        // Ignore search errors, proceed without related notes
      }
    }

    // Format related notes for prompt
    const formattedRelated = relatedNotes
      .map((note, i) => `[Note ${i + 1}]: "${note.title}" (${note.path})\n${note.content}`)
      .join("\n\n");

    return {
      noteContent: context.noteContent,
      relatedNotes: formattedRelated,
      citations,
    };
  }

  /**
   * Build user prompt from template
   */
  private buildUserPrompt(preparedContext: {
    noteContent: string;
    relatedNotes: string;
  }): string {
    const { context, triggerConfig } = this.config;
    let prompt = this.config.prompt.userTemplate;

    // Replace placeholders
    prompt = prompt.replace(/\{\{noteTitle\}\}/g, context.noteTitle);
    prompt = prompt.replace(/\{\{notePath\}\}/g, context.notePath);
    prompt = prompt.replace(/\{\{noteContent\}\}/g, preparedContext.noteContent);
    prompt = prompt.replace(/\{\{relatedNotes\}\}/g, preparedContext.relatedNotes);

    // Handle optional placeholders from triggerConfig
    if (triggerConfig) {
      prompt = prompt.replace(/\{\{sourceUrl\}\}/g, String(triggerConfig.sourceUrl || ""));
      prompt = prompt.replace(/\{\{contentType\}\}/g, String(triggerConfig.contentType || ""));
      prompt = prompt.replace(
        /\{\{targetAudience\}\}/g,
        String(triggerConfig.targetAudience || ""),
      );
    }

    return prompt;
  }

  /**
   * Stream LLM analysis
   */
  private async *streamAnalysis(systemPrompt: string, userPrompt: string): AsyncGenerator<string> {
    const { llm } = this.config;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];

    // Use the chatStream method from LMStudioService
    for await (const chunk of llm.chatStream(messages)) {
      yield chunk;
    }
  }

  /**
   * Parse LLM response into analysis and actions
   */
  private parseResponse(rawResponse: string): {
    parsedAnalysis: string;
    actions: ProposedAction[];
  } {
    const actions: ProposedAction[] = [];
    let parsedAnalysis = "";

    try {
      // Extract JSON using multiple strategies
      const jsonStr = this.extractJson(rawResponse);
      if (!jsonStr) {
        return { parsedAnalysis: rawResponse, actions: [] };
      }

      const parsed = JSON.parse(jsonStr);

      // Extract analysis - standardized field lookup
      parsedAnalysis =
        parsed.analysis ||
        parsed.synthesis_overview ||
        parsed.summary ||
        parsed.current_note_summary ||
        "";

      // Convert to proposed actions based on action type
      const proposedActions = this.convertToActions(parsed);
      actions.push(...proposedActions);
    } catch {
      // If JSON parsing fails, return raw response as analysis
      parsedAnalysis = rawResponse;
    }

    return { parsedAnalysis, actions };
  }

  /**
   * Extract JSON from LLM response with multiple strategies
   */
  private extractJson(response: string): string | null {
    // Strategy 1: Check for markdown code fences (```json ... ```)
    const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      const fenceContent = fenceMatch[1].trim();
      // Verify it looks like JSON
      if (fenceContent.startsWith("{") || fenceContent.startsWith("[")) {
        // Try to parse to validate, return if valid
        try {
          JSON.parse(fenceContent);
          return fenceContent;
        } catch {
          // Continue to other strategies
        }
      }
    }

    // Strategy 2: Find balanced JSON object braces
    const jsonStart = response.indexOf("{");
    if (jsonStart !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = jsonStart; i < response.length; i++) {
        const char = response[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"' && !escape) {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") depth++;
          if (char === "}") {
            depth--;
            if (depth === 0) {
              const candidate = response.slice(jsonStart, i + 1);
              try {
                JSON.parse(candidate);
                return candidate;
              } catch {
                // Continue looking for another valid JSON
              }
            }
          }
        }
      }
    }

    // Strategy 3: Simple regex fallback (greedy match)
    const simpleMatch = response.match(/\{[\s\S]*\}/);
    if (simpleMatch) {
      try {
        JSON.parse(simpleMatch[0]);
        return simpleMatch[0];
      } catch {
        // Failed
      }
    }

    return null;
  }

  /**
   * Convert parsed response to proposed actions - delegates to type-specific converters
   */
  private convertToActions(parsed: Record<string, unknown>): ProposedAction[] {
    const converters: Record<string, () => ProposedAction[]> = {
      atomic: () => this.convertAtomicActions(parsed),
      synthesis: () => this.convertSynthesisActions(parsed),
      clipping: () => this.convertClippingActions(parsed),
      task: () => this.convertTaskActions(parsed),
      brand: () => this.convertBrandActions(parsed),
      connection: () => this.convertConnectionActions(parsed),
      enhance: () => this.convertEnhanceActions(parsed),
      antagonist: () => this.convertAntagonistActions(parsed),
    };

    const converter = converters[this.config.actionType];
    return converter ? converter() : [];
  }

  /** Generate unique action ID */
  private genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Get today's date in YYYY-MM-DD format */
  private today(): string {
    return new Date().toISOString().split("T")[0];
  }

  /** Check if a path already exists in vault (for duplicate detection) */
  private pathExists(path: string): boolean {
    const existing = this.config.existingPaths;
    if (!existing) return false;
    // Normalize path for comparison (remove leading slash, ensure .md)
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return existing.has(normalizedPath) || existing.has(normalizedPath.replace(/\.md$/, ""));
  }

  /** Convert atomic split response to actions */
  private convertAtomicActions(parsed: Record<string, unknown>): ProposedAction[] {
    const actions: ProposedAction[] = [];
    const { context } = this.config;
    const atomicNotes = parsed.proposed_atomic_notes as
      | Array<{
          title: string;
          core_concept: string;
          content_outline: string[];
          connections?: string[];
          priority: string;
        }>
      | undefined;

    if (!atomicNotes) return actions;

    for (const note of atomicNotes) {
      const proposedPath = `${note.title}.md`;

      // Skip if note already exists in vault
      if (this.pathExists(proposedPath)) {
        continue;
      }

      actions.push({
        id: this.genId("create"),
        type: "create_note",
        risk: "low" as RiskLevel,
        title: `Create "${note.title}"`,
        reason: note.core_concept,
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          path: proposedPath,
          content: this.buildAtomicContent(note),
          frontmatter: { created: this.today(), tags: ["atomic"], type: "atomic" },
        },
      } as ProposedAction);
    }

    if (parsed.original_note_restructure) {
      actions.push({
        id: this.genId("restructure"),
        type: "restructure_note",
        risk: "medium" as RiskLevel,
        title: "Restructure original note",
        reason: String(parsed.original_note_restructure),
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          content: "",
          extractedSections: atomicNotes.map((n) => ({
            heading: n.title,
            newNotePath: `${n.title}.md`,
          })),
        },
      } as ProposedAction);
    }

    return actions;
  }

  /** Convert synthesis response to actions */
  private convertSynthesisActions(parsed: Record<string, unknown>): ProposedAction[] {
    const { context } = this.config;
    const synthesisNote = parsed.synthesis_note as
      | {
          title: string;
          frontmatter?: Record<string, unknown>;
          content: string;
          key_insights?: string[];
        }
      | undefined;

    if (!synthesisNote) return [];

    return [
      {
        id: this.genId("synthesis"),
        type: "create_synthesis_note",
        risk: "low" as RiskLevel,
        title: `Create synthesis: "${synthesisNote.title}"`,
        reason: String(parsed.synthesis_overview || "Create synthesis note"),
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          path: `${synthesisNote.title}.md`,
          content: synthesisNote.content,
          frontmatter: synthesisNote.frontmatter || {
            created: this.today(),
            tags: ["synthesis"],
            type: "synthesis",
          },
        },
      } as ProposedAction,
    ];
  }

  /** Convert clipping response to actions */
  private convertClippingActions(parsed: Record<string, unknown>): ProposedAction[] {
    const actions: ProposedAction[] = [];
    const { context } = this.config;
    const atomicConcepts = parsed.atomic_concepts as
      | Array<{ title: string; content: string; frontmatter?: Record<string, unknown> }>
      | undefined;

    if (!atomicConcepts) return actions;

    for (const concept of atomicConcepts) {
      const proposedPath = `${parsed.folder_recommendation || "3-resources"}/${concept.title}.md`;

      // Skip if note already exists in vault
      if (this.pathExists(proposedPath)) {
        continue;
      }

      actions.push({
        id: this.genId("clipping"),
        type: "create_note",
        risk: "low" as RiskLevel,
        title: `Create "${concept.title}"`,
        reason: "Extract from clipping",
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          path: proposedPath,
          content: concept.content,
          frontmatter: concept.frontmatter || {
            created: this.today(),
            tags: ["clipping-processed"],
            type: "atomic",
          },
        },
      } as ProposedAction);
    }

    return actions;
  }

  /** Convert task extraction response to actions */
  private convertTaskActions(parsed: Record<string, unknown>): ProposedAction[] {
    const { context } = this.config;
    const tasks = parsed.tasks as
      | Array<{ text: string; category: string; deadline?: string; project_area?: string }>
      | undefined;

    if (!tasks || tasks.length === 0) return [];

    return [
      {
        id: this.genId("task"),
        type: "create_task_note",
        risk: "low" as RiskLevel,
        title: `Extract ${tasks.length} tasks`,
        reason: String(parsed.summary || "Extract tasks from note"),
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          path: `tasks-from-${context.noteTitle.replace(/[^a-zA-Z0-9-]/g, "-")}.md`,
          tasks: tasks.map((t) => ({
            text: t.text,
            category: t.category as "immediate" | "planned" | "backlog" | "blocked",
            deadline: t.deadline,
            project: t.project_area,
          })),
          decisions: parsed.decisions as
            | Array<{ decision: string; rationale: string; date?: string }>
            | undefined,
        },
      } as ProposedAction,
    ];
  }

  /** Convert brand check response to actions */
  private convertBrandActions(parsed: Record<string, unknown>): ProposedAction[] {
    const { context } = this.config;
    const brandAlignment = parsed.brand_alignment as Record<string, unknown> | undefined;
    const overallScore = parsed.overall_score as number | undefined;

    if (!brandAlignment) return [];

    const revSuggestions = parsed.revision_suggestions as Record<string, string[]> | undefined;
    return [
      {
        id: this.genId("brand"),
        type: "append_review_section",
        risk: "low" as RiskLevel,
        title: `Brand review: ${overallScore ?? 0}/10`,
        reason: `Brand alignment check: ${parsed.final_recommendation || "completed"}`,
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          reviewType: "brand",
          score: overallScore ?? 0,
          findings: {
            strengths: (parsed.strengths as string[]) || [],
            concerns: (parsed.concerns as string[]) || [],
            suggestions: revSuggestions?.high_priority || [],
          },
          date: this.today(),
        },
      } as ProposedAction,
    ];
  }

  /** Convert connection response to actions */
  private convertConnectionActions(parsed: Record<string, unknown>): ProposedAction[] {
    const { context } = this.config;
    const connections = parsed.suggested_connections as
      | Array<{ target: string; type: string; context: string; score: number }>
      | undefined;

    if (!connections || connections.length === 0) return [];

    const links = connections.map((c) => c.target.replace(/\[\[|\]\]/g, ""));
    return [
      {
        id: this.genId("connection"),
        type: "append_related_links",
        risk: "medium" as RiskLevel,
        title: `Add ${links.length} connections`,
        reason: `${String(parsed.current_note_summary || "Add semantic connections")} (${connections.map((c) => c.type).join(", ")})`,
        target: context.notePath,
        requiresWriteLock: true,
        payload: { links },
      },
    ];
  }

  /** Convert enhance response to actions */
  private convertEnhanceActions(parsed: Record<string, unknown>): ProposedAction[] {
    const actions: ProposedAction[] = [];
    const { context } = this.config;
    const enhancedNote = parsed.enhanced_note as
      | { title: string; frontmatter?: Record<string, unknown>; content: string }
      | undefined;

    if (!enhancedNote) return actions;

    if (enhancedNote.frontmatter) {
      for (const [key, value] of Object.entries(enhancedNote.frontmatter)) {
        if (key === "tags" && Array.isArray(value)) {
          actions.push({
            id: this.genId("enhance-tags"),
            type: "frontmatter_add_tags",
            risk: "low" as RiskLevel,
            title: `Add ${value.length} tags`,
            reason: `Enhance with tags: ${value.join(", ")}`,
            target: context.notePath,
            requiresWriteLock: true,
            payload: { tags: value },
          });
        } else {
          actions.push({
            id: this.genId("enhance-fm"),
            type: "frontmatter_set",
            risk: "low" as RiskLevel,
            title: `Set ${key}`,
            reason: `Enhance frontmatter: ${key}`,
            target: context.notePath,
            requiresWriteLock: true,
            payload: { key, value },
          });
        }
      }
    }

    const nextActions = parsed.next_actions as string[] | undefined;
    if (nextActions && nextActions.length > 0) {
      actions.push({
        id: this.genId("enhance-actions"),
        type: "append_section",
        risk: "low" as RiskLevel,
        title: "Add next actions",
        reason: `${nextActions.length} follow-up actions identified`,
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          heading: "Next Actions",
          content: nextActions.map((a) => `- [ ] ${a}`).join("\n"),
        },
      });
    }

    return actions;
  }

  /**
   * Convert antagonist critique response to actions (PART 1.2)
   *
   * Antagonist agent provides:
   * - claims_analyzed: Key claims identified in the note
   * - critique: Array of {claim, weakness, counterpoint, severity}
   * - probing_questions: Questions that challenge assumptions
   * - steelman_argument: Best possible version of the argument
   */
  private convertAntagonistActions(parsed: Record<string, unknown>): ProposedAction[] {
    const { context } = this.config;
    const critique = parsed.critique as
      | Array<{ claim: string; weakness: string; counterpoint: string; severity: string }>
      | undefined;
    const probingQuestions = parsed.probing_questions as string[] | undefined;
    const steelmanArgument = parsed.steelman_argument as string | undefined;

    // Need at least some critique to generate an action
    if (!critique || critique.length === 0) {
      return [];
    }

    // Count high-severity critiques to determine overall rating
    const highSeverityCount = critique.filter((c) => c.severity === "high").length;
    const mediumSeverityCount = critique.filter((c) => c.severity === "medium").length;

    // Calculate a score (10 = no issues, 0 = all high severity)
    const baseScore = 10;
    const score = Math.max(0, baseScore - highSeverityCount * 3 - mediumSeverityCount * 1);

    return [
      {
        id: this.genId("antagonist"),
        type: "append_review_section",
        risk: "low" as RiskLevel,
        title: `Devil's Advocate: ${score}/10`,
        reason: `Critical analysis: ${critique.length} weaknesses identified`,
        target: context.notePath,
        requiresWriteLock: true,
        payload: {
          reviewType: "antagonist",
          score,
          findings: {
            strengths: steelmanArgument ? [steelmanArgument] : [],
            concerns: critique.map(
              (c) => `**${c.claim}**: ${c.weakness} (Counter: ${c.counterpoint})`,
            ),
            suggestions: probingQuestions || [],
          },
          date: this.today(),
        },
      } as ProposedAction,
    ];
  }

  /**
   * Build atomic note content from outline
   */
  private buildAtomicContent(note: {
    title: string;
    core_concept: string;
    content_outline: string[];
    connections?: string[];
  }): string {
    let content = `# ${note.title}\n\n`;
    content += `${note.core_concept}\n\n`;

    if (note.content_outline.length > 0) {
      content += "## Key Points\n\n";
      for (const point of note.content_outline) {
        content += `- ${point}\n`;
      }
      content += "\n";
    }

    if (note.connections && note.connections.length > 0) {
      content += "## Related\n\n";
      for (const conn of note.connections) {
        content += `- ${conn}\n`;
      }
    }

    return content;
  }

  /**
   * Create action batches for batch operations
   */
  private createBatches(actions: ProposedAction[]): ActionBatch[] {
    const batches: ActionBatch[] = [];

    // Define action type groups
    const createTypes = ["create_note", "create_synthesis_note", "create_task_note"];
    const updateTypes = ["restructure_note"];
    const linkTypes = ["append_related_links", "batch_append_links"];

    // Group create actions
    const createActions = actions.filter((a) => createTypes.includes(a.type));

    if (createActions.length > 0) {
      batches.push({
        id: "batch-create",
        title: `Create ${createActions.length} note${createActions.length > 1 ? "s" : ""}`,
        actions: createActions,
        dependencies: [],
      });
    }

    // Group update actions
    const updateActions = actions.filter((a) => updateTypes.includes(a.type));

    if (updateActions.length > 0) {
      batches.push({
        id: "batch-update",
        title: "Update source note",
        actions: updateActions,
        dependencies: ["batch-create"], // Wait for notes to exist
      });
    }

    // Group link actions
    const linkActions = actions.filter((a) => linkTypes.includes(a.type));

    if (linkActions.length > 0) {
      batches.push({
        id: "batch-links",
        title: "Create connections",
        actions: linkActions,
        dependencies: ["batch-create", "batch-update"],
      });
    }

    // Other actions
    const handledTypes = [...createTypes, ...updateTypes, ...linkTypes];
    const otherActions = actions.filter((a) => !handledTypes.includes(a.type));

    if (otherActions.length > 0) {
      batches.push({
        id: "batch-other",
        title: "Additional actions",
        actions: otherActions,
        dependencies: [],
      });
    }

    return batches;
  }
}
