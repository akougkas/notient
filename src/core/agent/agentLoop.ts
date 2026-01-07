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
} from "./types";
import { NotientPromptBuilder } from "./promptBuilder";
import { inferTaskType } from "./taskInference";

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

    // Phase 4: Complete
    yield { type: "progress", progress: 100 };

    yield {
      type: "complete",
      result: {
        type: "chat",
        data: fullResponse,
        citations,
      },
    };
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
