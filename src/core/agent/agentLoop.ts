/**
 * Notient Agent Loop
 *
 * Core agent execution - orchestrates LLM, search, context.
 * This is the "brain" of Notient that coordinates all AI operations.
 */

import type { LLMProvider, ChatMessage } from "../llm";
import type { SearchPipeline } from "../search/pipeline";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type {
  AgentTask,
  TaskResult,
  AgentStreamEvent,
  NoteContext,
  PromptParams,
} from "./types";
import { NotientPromptBuilder } from "./promptBuilder";
import { inferTaskType } from "./taskInference";
import {
  type ProposedAction,
  type ActionPlanResponse,
  ACTION_RISK_MAP,
  MAX_ACTIONS_PER_RESPONSE,
  SUPPORTED_ACTION_TYPES,
} from "../agentic/types";
import { normalizePath } from "obsidian";

/**
 * Core agent that orchestrates LLM, search, and context
 */
export class NotientAgent {
  private promptBuilder: NotientPromptBuilder;

  constructor(
    private llm: LLMProvider,
    private search: SearchPipeline | null,
    private contextBuilder: VaultContextBuilder | null,
    private obsidian: ObsidianFacade
  ) {
    this.promptBuilder = new NotientPromptBuilder();
  }

  /**
   * Execute a task and return the result
   * @param task - The task to execute
   * @returns The task result
   */
  async execute(task: AgentTask): Promise<TaskResult> {
    let fullResponse = "";
    const citations: string[] = [];

    for await (const event of this.executeStreaming(task)) {
      switch (event.type) {
        case "chunk":
          fullResponse += event.content;
          break;
        case "citations":
          citations.push(...event.paths);
          break;
        case "complete":
          return event.result;
        case "error":
          throw event.error;
      }
    }

    // Fallback result if stream ended without complete event
    return {
      type: "chat",
      data: fullResponse,
      citations,
    };
  }

  /**
   * Execute a task with streaming events
   * @param task - The task to execute
   * @param signal - Optional AbortSignal for cancellation
   * @yields Agent stream events
   */
  async *executeStreaming(
    task: AgentTask,
    signal?: AbortSignal
  ): AsyncIterable<AgentStreamEvent> {
    // Get the user query from chat history
    const userMessages = task.chatHistory.filter((m) => m.role === "user");
    const query = userMessages[userMessages.length - 1]?.content;

    if (!query) {
      yield { type: "error", error: new Error("No query provided for task") };
      return;
    }

    // Infer task type from query
    const taskType = inferTaskType(query);

    // Phase 1: Load the CURRENT note content
    yield { type: "progress", progress: 5 };

    let currentNoteData: NoteContext | undefined;

    if (task.notePath && task.notePath !== "unknown") {
      try {
        const content = await this.obsidian.readFileByPath(task.notePath);
        if (content) {
          currentNoteData = {
            title: task.noteTitle,
            path: task.notePath,
            content: content,
          };
          console.log(
            `[NotientAgent] Loaded current note: ${task.notePath} (${content.length} chars)`
          );
        }
      } catch (error) {
        console.warn(
          `[NotientAgent] Failed to load current note ${task.notePath}:`,
          error
        );
      }
    }

    // Phase 2: Search for related context
    yield { type: "progress", progress: 10 };

    const citations: string[] = [];
    let contextSummary = "No vault context available.";
    const relevantNotes: Array<{ title: string; path: string; text: string }> = [];

    if (this.search) {
      try {
        // Search using both the query AND the note title for better context
        const searchQuery = currentNoteData
          ? `${query} ${currentNoteData.title}`
          : query;

        const searchResults = await this.search.search(searchQuery, {
          topK: 7,
          enableReranking: this.llm.isReady,
        });

        yield { type: "progress", progress: 20 };

        // Build context from search results
        if (this.contextBuilder && searchResults.length > 0) {
          const context = this.contextBuilder.buildForQuery(query, searchResults);
          contextSummary = context?.contextSummary || contextSummary;
        }

        // Extract citations and relevant notes (exclude current note)
        for (const result of searchResults) {
          if (currentNoteData && result.path === currentNoteData.path) {
            continue;
          }

          if (relevantNotes.length >= 5) break;

          citations.push(result.path);
          relevantNotes.push({
            title: result.title,
            path: result.path,
            text: result.chunks[0]?.text || "",
          });
        }

        // Emit citations
        if (citations.length > 0) {
          yield { type: "citations", paths: citations };
        }

        yield { type: "progress", progress: 30 };
      } catch (error) {
        console.warn(
          "[NotientAgent] Search failed, continuing with current note only:",
          error
        );
      }
    }

    // Check if aborted during search
    if (signal?.aborted) {
      return;
    }

    // Phase 3: Generate AI response
    yield { type: "progress", progress: 40 };

    // Build system prompt with FULL context
    const systemPrompt = this.promptBuilder.buildSystemPrompt({
      currentNote: currentNoteData,
      relatedNotes: relevantNotes,
      contextSummary,
      taskType,
      query,
    });

    console.log(
      `[NotientAgent] Built prompt: ${systemPrompt.length} chars, ` +
        `currentNote=${!!currentNoteData}, relatedNotes=${relevantNotes.length}`
    );

    // Build message list for LLM (last 10 for sliding window)
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...task.chatHistory.slice(-10).map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
    ];

    // Stream the response
    let fullResponse = "";

    try {
      for await (const chunk of this.llm.stream(messages, undefined, signal)) {
        if (signal?.aborted) break;

        fullResponse += chunk;
        yield { type: "chunk", content: chunk };

        // Update progress during streaming (40-90%)
        const progressDelta = Math.min(50, fullResponse.length / 20);
        yield { type: "progress", progress: Math.min(90, 40 + progressDelta) };
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      yield { type: "error", error: error as Error };
      return;
    }

    // Check if aborted during streaming
    if (signal?.aborted) {
      return;
    }

    // Phase 4: Generate action plan (for agentic task types)
    yield { type: "progress", progress: 92 };

    let actions: ProposedAction[] = [];
    const agenticTaskTypes = ["enrich", "link", "classify"];

    if (taskType && agenticTaskTypes.includes(taskType)) {
      try {
        const actionPlanPrompt = this.promptBuilder.buildActionPlanPrompt({
          currentNote: currentNoteData,
          relatedNotes: relevantNotes,
          contextSummary,
          taskType,
          query,
        });

        // Build messages for action plan generation
        const actionMessages: ChatMessage[] = [
          { role: "system", content: actionPlanPrompt },
          {
            role: "user",
            content: `Based on my request "${query}" and the note content, propose specific actions to improve this note. Output only valid JSON.`,
          },
        ];

        yield { type: "progress", progress: 95 };

        // Non-streaming call for structured JSON output
        const actionPlanJson = await this.llm.complete(actionMessages);

        // Parse and validate the action plan
        actions = this.parseActionPlan(actionPlanJson, task.notePath);

        if (actions.length > 0) {
          yield { type: "actions", actions };
        }
      } catch (error) {
        console.warn("[NotientAgent] Failed to generate action plan:", error);
        // Continue without actions - not a fatal error
      }
    }

    // Phase 5: Complete
    yield { type: "progress", progress: 100 };

    const resultType = actions.length > 0 ? "action_plan" : "chat";

    yield {
      type: "complete",
      result: {
        type: resultType,
        data: fullResponse,
        citations,
        actions: actions.length > 0 ? actions : undefined,
      },
    };
  }

  /**
   * Parse LLM action plan JSON with robust error handling
   * Validates and sanitizes the response per LLM Output Validation Rules
   */
  private parseActionPlan(jsonStr: string, notePath: string): ProposedAction[] {
    try {
      // Strip markdown code fences if present
      let cleaned = jsonStr.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
      }
      cleaned = cleaned.trim();

      // Extract first JSON object if there's extra text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[NotientAgent] No JSON object found in action plan response");
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as ActionPlanResponse;

      if (!parsed.actions || !Array.isArray(parsed.actions)) {
        console.warn("[NotientAgent] Invalid action plan structure: missing actions array");
        return [];
      }

      // Validate and transform actions
      const validActions: ProposedAction[] = [];
      const normalizedNotePath = normalizePath(notePath);

      for (const rawAction of parsed.actions.slice(0, MAX_ACTIONS_PER_RESPONSE)) {
        // Skip unsupported action types
        if (!SUPPORTED_ACTION_TYPES.includes(rawAction.type)) {
          console.warn(`[NotientAgent] Skipping unsupported action type: ${rawAction.type}`);
          continue;
        }

        // Validate required fields
        if (!rawAction.type || !rawAction.title || !rawAction.payload) {
          console.warn("[NotientAgent] Skipping action with missing required fields");
          continue;
        }

        // Normalize and validate target path
        let target = rawAction.target
          ? normalizePath(rawAction.target)
          : normalizedNotePath;

        // Override target if it doesn't match task's note path (safety)
        if (target !== normalizedNotePath) {
          console.warn(
            `[NotientAgent] Overriding action target from ${target} to ${normalizedNotePath}`
          );
          target = normalizedNotePath;
        }

        // Reject non-.md files
        if (!target.endsWith(".md")) {
          console.warn(`[NotientAgent] Skipping action targeting non-markdown file: ${target}`);
          continue;
        }

        // Override risk level based on action type (don't trust LLM)
        const correctRisk = ACTION_RISK_MAP[rawAction.type];

        // Generate unique ID
        const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Build the validated action
        const validAction = {
          id,
          type: rawAction.type,
          risk: correctRisk,
          title: rawAction.title.slice(0, 50),
          reason: rawAction.reason || "No reason provided",
          target,
          requiresWriteLock: true,
          payload: rawAction.payload,
        } as ProposedAction;

        // Type-specific payload validation
        if (!this.validateActionPayload(validAction)) {
          console.warn(`[NotientAgent] Skipping action with invalid payload: ${rawAction.type}`);
          continue;
        }

        // For move_note, override payload.from for safety
        if (validAction.type === "move_note") {
          validAction.payload.from = normalizedNotePath;
        }

        validActions.push(validAction);
      }

      return validActions;
    } catch (error) {
      console.warn("[NotientAgent] Failed to parse action plan JSON:", error);
      return [];
    }
  }

  /**
   * Validate action-specific payload fields
   */
  private validateActionPayload(action: ProposedAction): boolean {
    switch (action.type) {
      case "frontmatter_set":
        return (
          typeof action.payload.key === "string" &&
          action.payload.key.length > 0
        );

      case "frontmatter_add_tags":
        return (
          Array.isArray(action.payload.tags) &&
          action.payload.tags.length > 0 &&
          action.payload.tags.every((t: unknown) => typeof t === "string")
        );

      case "append_section":
        return typeof action.payload.content === "string";

      case "append_related_links":
        return (
          Array.isArray(action.payload.links) &&
          action.payload.links.length > 0 &&
          action.payload.links.every((l: unknown) => typeof l === "string")
        );

      case "move_note":
        return typeof action.payload.to === "string" && action.payload.to.length > 0;

      default:
        return false;
    }
  }

  /**
   * Update the LLM provider (e.g., after reconnection)
   */
  updateLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

  /**
   * Update the search pipeline (e.g., after reconnection)
   */
  updateSearch(search: SearchPipeline | null): void {
    this.search = search;
  }

  /**
   * Update the context builder
   */
  updateContextBuilder(contextBuilder: VaultContextBuilder | null): void {
    this.contextBuilder = contextBuilder;
  }
}
