/**
 * Agent Task Queue
 *
 * Manages a queue of agent tasks for sequential execution.
 * Tasks are processed one at a time, with support for cancellation
 * and progress tracking.
 *
 * Architecture Note:
 * This bridges the legacy AgentTask interface with the new ChiefOfStaff
 * multi-agent system. It converts between:
 * - AgentTask ↔ ChiefOfStaffTask
 * - AgentEvent ↔ AgentStreamEvent
 *
 * IMPORTANT: TaskQueue is for EXPERT AGENTS ONLY (note-editor, classifier, connection).
 * Tasks MUST have a valid taskType that maps to an expert agent.
 * Chat conversations go through ChatService directly, NOT through TaskQueue.
 * Invalid task types will cause the task to fail - no silent fallback to chat.
 */

import type { Insight, ProposedAction } from "../agentic/types";
import type { ChiefOfStaff, ChiefOfStaffTask } from "../agents/chiefOfStaff";
import type { AgentEvent, ConversationalOutput, StructuredOutput } from "../agents/types";
import type { WorkflowAgentType } from "../agents/workerAgent";
import type { ConversationStore } from "../chat/conversationStore";
import type { ExtendedChatMessage } from "../chat/types";
import type { EventBus } from "../events/eventBus";
import { generateId } from "../ids";
import type { AgentStreamEvent, AgentTask, TaskResult } from "./types";

/**
 * Callback for task update notifications
 */
type TaskUpdateCallback = (task: AgentTask) => void;

/** Maximum number of queued tasks to prevent memory exhaustion */
const MAX_QUEUE_SIZE = 20;

/**
 * Manages agent tasks in a queue with sequential execution
 */
export class AgentTaskQueue {
  private tasks: AgentTask[] = [];
  private currentTask: AgentTask | null = null;
  private currentAbortController: AbortController | null = null;
  private onTaskUpdateCallback?: TaskUpdateCallback;
  private conversationStore?: ConversationStore;
  /** Guard against concurrent processNext() calls */
  private processing = false;

  constructor(
    private agent: ChiefOfStaff | null,
    private eventBus: EventBus,
  ) {}

  /**
   * Check if the agent is available for task execution
   */
  isAgentAvailable(): boolean {
    const result = this.agent !== null;
    return result;
  }

  /**
   * Set the agent (for late binding when LLM becomes available)
   */
  setAgent(agent: ChiefOfStaff): void {
    this.agent = agent;
  }

  /**
   * Set the conversation store for persistence (Phase 2)
   */
  setConversationStore(store: ConversationStore): void {
    this.conversationStore = store;
  }

  /**
   * Enqueue a new task
   * @param task - Task data (without id, status, startedAt)
   * @returns The task ID
   */
  enqueue(task: Omit<AgentTask, "id" | "status" | "startedAt">): string {
    // Check LLM availability first - provide clear error message
    if (!this.agent) {
      console.error("[AgentTaskQueue] Cannot enqueue task - LLM agent not available");
      throw new Error(
        "LM Studio connection required for agent tasks. Please ensure LM Studio is running.",
      );
    }

    // Backpressure: reject if queue is full (prevents memory exhaustion)
    const queuedCount = this.tasks.filter((t) => t.status === "queued").length;
    if (queuedCount >= MAX_QUEUE_SIZE) {
      console.warn(`[AgentTaskQueue] Queue full (${queuedCount} tasks), rejecting new task`);
      throw new Error("Task queue is full. Please wait for current tasks to complete.");
    }

    const id = generateId("tsk");

    // Phase 2: Handle conversation persistence
    const newMessages = task.chatHistory || [];
    let mergedChatHistory = newMessages;

    if (this.conversationStore && task.notePath) {
      // Load persisted conversation history
      const persistedHistory = this.conversationStore.getHistory(task.notePath);
      // Convert ExtendedChatMessage to ChatMessage for the agent
      const simplifiedHistory = persistedHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Deduplicate: only add new messages not already in persisted history
      // Compare by content since new messages don't have IDs yet
      const existingContents = new Set(simplifiedHistory.map((m) => m.content));
      const uniqueNewMessages = newMessages.filter((m) => !existingContents.has(m.content));

      // Merge: persisted history + only truly new messages
      mergedChatHistory = [...simplifiedHistory, ...uniqueNewMessages];

      // Limit total chat history to prevent unbounded growth (keep last 100 messages)
      const MAX_HISTORY_SIZE = 100;
      if (mergedChatHistory.length > MAX_HISTORY_SIZE) {
        mergedChatHistory = mergedChatHistory.slice(-MAX_HISTORY_SIZE);
      }

      // Persist the new user messages (only truly new ones)
      for (let i = 0; i < uniqueNewMessages.length; i++) {
        const msg = uniqueNewMessages[i];
        if (msg.role === "user") {
          const userMessage: ExtendedChatMessage = {
            id: generateId("msg"),
            role: "user",
            content: msg.content,
            timestamp: new Date(),
          };
          this.conversationStore.appendMessage(task.notePath, userMessage);
        }
      }
    }

    const newTask: AgentTask = {
      ...task,
      id,
      status: "queued",
      startedAt: new Date(),
      progress: 0,
      chatHistory: mergedChatHistory,
    };

    this.tasks.push(newTask);
    this.emitUpdate(newTask);

    // Trigger processing (async)
    void this.processNext();

    return id;
  }

  /**
   * Cancel a task
   * @param taskId - ID of the task to cancel
   */
  cancel(taskId: string): void {
    const task = this.getById(taskId);
    if (!task) {
      return;
    }

    if (task.status === "running" || task.status === "queued") {
      // Abort any ongoing streaming
      if (this.currentTask?.id === taskId && this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }

      task.status = "cancelled";
      task.completedAt = new Date();
      this.emitUpdate(task);

      // If it was running, clear currentTask to proceed
      if (this.currentTask?.id === taskId) {
        this.currentTask = null;
        queueMicrotask(() => this.processNext());
      }
    }
  }

  /**
   * Cancel all running and queued tasks
   */
  cancelAll(): void {
    for (const task of this.tasks.filter((t) => t.status === "running" || t.status === "queued")) {
      this.cancel(task.id);
    }
  }

  /**
   * Get all tasks
   */
  getAll(): AgentTask[] {
    const result = [...this.tasks];
    return result;
  }

  /**
   * Get a task by ID
   */
  getById(taskId: string): AgentTask | undefined {
    const result = this.tasks.find((t) => t.id === taskId);
    return result;
  }

  /**
   * Wait for a task to complete, fail, or be cancelled.
   * Uses event-driven waiting instead of polling.
   * @param taskId - ID of the task to wait for
   * @param options - Optional timeout and abort signal
   * @returns The completed task
   */
  waitForCompletion(
    taskId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentTask> {
    return new Promise((resolve, reject) => {
      const task = this.getById(taskId);
      if (!task) {
        reject(new Error(`Task not found: ${taskId}`));
        return;
      }

      // If already in terminal state, resolve immediately
      if (task.status === "completed") {
        resolve(task);
        return;
      }
      if (task.status === "failed" || task.status === "cancelled") {
        reject(new Error(task.error || `Task ${task.status}`));
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
      };

      // Listen for task updates
      unsubscribe = this.eventBus.on("agent:task-update", (event) => {
        if (event.task.id !== taskId) {
          return;
        }

        if (event.task.status === "completed") {
          cleanup();
          resolve(event.task);
        } else if (event.task.status === "failed" || event.task.status === "cancelled") {
          cleanup();
          reject(new Error(event.task.error || `Task ${event.task.status}`));
        }
      });

      // Set up timeout
      if (options?.timeoutMs) {
        timeoutId = setTimeout(() => {
          cleanup();
          // Cancel the task on timeout
          this.cancel(taskId);
          reject(new Error("Task timeout"));
        }, options.timeoutMs);
      }

      // Handle abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          cleanup();
          this.cancel(taskId);
          reject(new Error("Task aborted"));
          return;
        }

        abortHandler = () => {
          cleanup();
          this.cancel(taskId);
          reject(new Error("Task aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  /**
   * Register a callback for task updates
   */
  onTaskUpdate(callback: TaskUpdateCallback): void {
    this.onTaskUpdateCallback = callback;
  }

  /**
   * Clear all completed/cancelled tasks
   */
  clearCompleted(): void {
    const beforeCount = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.status === "queued" || t.status === "running");
    const afterCount = this.tasks.length;
  }

  /**
   * Process the next task in the queue.
   * Protected against concurrent invocations.
   */
  private async processNext(): Promise<void> {
    // Guard against concurrent processing
    if (this.processing || this.currentTask) {
      return;
    }
    this.processing = true;

    try {
      const next = this.tasks.find((t) => t.status === "queued");
      if (!next) {
        return;
      }

      this.currentTask = next;
      next.status = "running";
      this.emitUpdate(next);

      await this.runTask(next);
    } finally {
      this.processing = false;
      this.scheduleNextIfQueued();
    }
  }

  /**
   * Execute a single task with error handling and status updates.
   */
  private async runTask(task: AgentTask): Promise<void> {
    try {
      await this.executeTask(task);

      if (task.status === "running") {
        task.status = "completed";
        task.completedAt = new Date();
        task.progress = 100;
      }
    } catch (error) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        task.completedAt = new Date();
      }
    } finally {
      this.emitUpdate(task);
      this.currentTask = null;
      this.currentAbortController = null;
    }
  }

  /**
   * Schedule next task processing only if there are queued tasks.
   * Prevents infinite loop when queue is empty.
   */
  private scheduleNextIfQueued(): void {
    const hasQueued = this.tasks.some((t) => t.status === "queued");
    if (hasQueued) {
      queueMicrotask(() => this.processNext());
    }
  }

  /**
   * Convert legacy AgentTask to ChiefOfStaffTask
   */
  private toChiefOfStaffTask(task: AgentTask): ChiefOfStaffTask {
    // Get the user query from chat history
    const userMessages = task.chatHistory.filter((m) => m.role === "user");
    const query = userMessages[userMessages.length - 1]?.content || "";

    const targetAgent = this.mapTaskTypeToAgent(task.taskType);

    // Map taskType to targetWorkflow for Quick Actions
    const targetWorkflow = this.mapTaskTypeToWorkflow(task.taskType);

    const result = {
      query,
      notePath: task.notePath,
      noteTitle: task.noteTitle,
      chatHistory: task.chatHistory,
      // Map legacy taskType to targetAgent if appropriate
      targetAgent,
      // Map taskType to explicit workflow (fixes Quick Actions defaulting to "enhance")
      targetWorkflow,
    };
    return result;
  }

  /**
   * Map taskType to workflow type for Quick Actions.
   * Ensures Quick Actions route to the correct workflow instead of defaulting to "enhance".
   *
   * Mapping:
   * - "classifier" → "enhance" (enhance workflow handles PARA classification)
   * - "connection" → "connection" (connection workflow)
   * - "enrich" → "enhance" (explicit enhance)
   */
  private mapTaskTypeToWorkflow(taskType?: string): WorkflowAgentType | undefined {
    switch (taskType) {
      case "classifier":
      case "classify":
        return "enhance"; // enhance workflow includes PARA classification
      case "connection":
      case "link":
        return "connection";
      case "enrich":
        return "enhance";
      default:
        return undefined;
    }
  }

  /**
   * Map taskType to expert agent type.
   *
   * IMPORTANT: TaskQueue is for EXPERT AGENTS ONLY. Every task MUST have a valid
   * taskType that maps to an expert agent. If taskType is missing or invalid,
   * we throw an error - NO fallback to chat routing.
   *
   * Valid expert agents: note-editor, worker
   * Legacy names are supported for backwards compatibility.
   *
   * @throws Error if taskType is missing or doesn't map to an expert agent
   */
  private mapTaskTypeToAgent(taskType?: string): "note-editor" | "worker" {
    switch (taskType) {
      case "note-editor":
      case "enrich":
        return "note-editor";
      case "worker":
      case "classifier":
      case "classify":
      case "connection":
      case "link":
        return "worker";
      default:
        throw new Error(
          `TaskQueue requires a valid expert agent taskType. Got: "${taskType ?? "undefined"}". Valid types: note-editor, worker (or legacy: enrich, classify, link). For chat conversations, use ChatService directly.`,
        );
    }
  }

  /**
   * Extract actions from AgentOutput
   */
  private extractActions(output: StructuredOutput | ConversationalOutput): ProposedAction[] {
    if (output.kind === "structured") {
      const data = output.data as { actions?: ProposedAction[] };
      const actions = data.actions || [];
      return actions;
    }
    return [];
  }

  /**
   * Map expert agent type to result type for structured outputs.
   *
   * Note: This only handles expert agent types since TaskQueue is for expert agents only.
   * The "chat" fallback is kept for conversational outputs from expert agents that
   * include explanatory text alongside their structured data.
   */
  private mapAgentTypeToResultType(agentType: string | undefined): TaskResult["type"] {
    switch (agentType) {
      case "note-editor":
        return "action_plan";
      case "worker":
        // Worker handles multiple workflow types, return appropriate type
        return "action_plan";
      default:
        // Expert agents may produce conversational explanations alongside structured output
        return "chat";
    }
  }

  /**
   * Build TaskResult from conversational output
   */
  private buildConversationalResult(
    output: ConversationalOutput,
    fullResponse: string,
    citations: string[],
    actions: ProposedAction[],
  ): { result: TaskResult; resultData: unknown; actions: ProposedAction[] } {
    const resultData = output.content || fullResponse;
    const allActions = [...actions];

    // Include delegated results' actions
    if (output.delegatedResults) {
      for (const dr of output.delegatedResults) {
        allActions.push(...this.extractActions(dr.output));
      }
    }

    const result = {
      result: {
        type: "chat" as const,
        data: resultData,
        citations,
        actions: allActions.length > 0 ? allActions : undefined,
      },
      resultData,
      actions: allActions,
    };
    return result;
  }

  /**
   * Build TaskResult from structured output
   */
  private buildStructuredResult(
    output: StructuredOutput,
    citations: string[],
  ): { result: TaskResult; resultData: unknown; actions: ProposedAction[] } {
    const resultType = this.mapAgentTypeToResultType(output.agentType);
    const resultData = output.data;
    const actions = this.extractActions(output);

    const result = {
      result: {
        type: resultType,
        data: resultData,
        citations,
        actions: actions.length > 0 ? actions : undefined,
      },
      resultData,
      actions,
    };
    return result;
  }

  /**
   * Persist assistant message to conversation store
   */
  private persistAssistantMessage(notePath: string, content: string): void {
    if (!this.conversationStore) {
      return;
    }

    const assistantMessage: ExtendedChatMessage = {
      id: generateId("msg"),
      role: "assistant",
      content,
      timestamp: new Date(),
    };
    this.conversationStore.appendMessage(notePath, assistantMessage);
  }

  /**
   * Handle the complete event from agent execution
   */
  private handleCompleteEvent(
    event: AgentEvent & { type: "complete" },
    task: AgentTask,
    fullResponse: string,
    citations: string[],
    actions: ProposedAction[],
  ): void {
    const output = event.output;
    let built: { result: TaskResult; resultData: unknown; actions: ProposedAction[] };

    if (output.kind === "conversational") {
      built = this.buildConversationalResult(output, fullResponse, citations, actions);
    } else if (output.kind === "structured") {
      built = this.buildStructuredResult(output, citations);
    } else {
      // Internal output (context-builder) - treat as chat
      built = {
        result: { type: "chat", data: fullResponse, citations },
        resultData: fullResponse,
        actions: [],
      };
    }

    // Format assistant content for chat history
    const assistantContent =
      typeof built.resultData === "string"
        ? built.resultData
        : fullResponse || JSON.stringify(built.resultData);

    task.chatHistory.push({
      role: "assistant",
      content: assistantContent,
    });
    task.result = built.result;

    // Emit insight:created (wraps actions in Insight container)
    // This is the primary event flow: Agent → Insight container → UI extracts actions
    if (built.actions.length > 0 && task.notePath) {
      // Get agentType from structured output if available
      const agentType = output.kind === "structured" ? output.agentType : undefined;
      this.emitInsightCreated(built.actions, task, fullResponse, agentType);
    }

    // Persist assistant message to conversation store (async, debounced)
    if (task.notePath) {
      this.persistAssistantMessage(task.notePath, assistantContent);
    }
  }

  /**
   * Emit insight:created event with an Insight container.
   * This is the correct event flow per ID-ARCHITECTURE-SPEC.md:
   * Agent returns → Create Insight container → emit insight:created once
   * → UI extracts actions from Insight for pending review
   */
  private emitInsightCreated(
    actions: ProposedAction[],
    task: AgentTask,
    fullResponse: string,
    agentType: string | undefined,
  ): void {
    // Ensure all actions have IDs
    for (const action of actions) {
      if (!action.id) {
        action.id = generateId("act");
      }
    }

    // Extract reasoning from the response (first paragraph or up to 500 chars)
    const reasoning = this.extractReasoning(fullResponse);

    // Generate a 1-liner summary for InsightStream UI
    const summary = this.generateSummary(actions, agentType);

    // Create Insight container
    const insight: Insight = {
      id: generateId("ins"),
      timestamp: Date.now(),
      agentType: agentType || task.taskType || "unknown",
      noteContext: {
        path: task.notePath || "",
        title: task.noteTitle || "Unknown",
      },
      reasoning,
      actions,
      suggestions: [], // Future: extract suggestions from agent output
      summary,
    };

    // Emit single insight:created event (UI extracts actions for pending review)
    this.eventBus.emit("insight:created", {
      insight,
      source: `task:${task.id}`,
    });
  }

  /**
   * Extract reasoning from agent response.
   * Looks for reasoning patterns or takes first substantive paragraph.
   */
  private extractReasoning(response: string): string {
    if (!response) return "No reasoning provided.";

    // Try to find explicit reasoning section
    const reasoningMatch = response.match(
      /(?:reasoning|rationale|explanation):\s*(.+?)(?:\n\n|$)/is,
    );
    if (reasoningMatch) {
      return reasoningMatch[1].trim().slice(0, 500);
    }

    // Otherwise take the first substantive text (skip JSON)
    const cleanResponse = response.replace(/```[\s\S]*?```/g, "").trim();
    const firstParagraph = cleanResponse.split("\n\n")[0] || cleanResponse;
    return firstParagraph.slice(0, 500) || "No reasoning provided.";
  }

  /**
   * Generate a 1-liner summary for InsightStream UI.
   */
  private generateSummary(actions: ProposedAction[], agentType: string | undefined): string {
    if (actions.length === 0) return "No actions proposed.";

    const actionTypes = [...new Set(actions.map((a) => a.type))];
    const actionCount = actions.length;

    if (actionCount === 1) {
      return actions[0].title || `Proposed ${actions[0].type}`;
    }

    const agentLabel = agentType === "note-editor" ? "Edit" : agentType || "Agent";
    return `${agentLabel}: ${actionCount} actions (${actionTypes.join(", ")})`;
  }

  /**
   * Process a single agent event during task execution
   */
  private processAgentEvent(
    event: AgentEvent,
    task: AgentTask,
    state: { fullResponse: string; citations: string[]; actions: ProposedAction[] },
  ): void {
    if (event.type === "started") {
      task.progress = 5;
      this.emitUpdate(task);
      return;
    }

    if (event.type === "progress") {
      task.progress = event.progress;
      this.emitUpdate(task);
      return;
    }

    if (event.type === "chunk") {
      state.fullResponse += event.content;
      return;
    }

    if (event.type === "citations") {
      state.citations.push(...event.paths);
      return;
    }

    if (event.type === "delegation-started") {
      task.progress = Math.min(task.progress || 0, 50) + 10;
      this.emitUpdate(task);
      return;
    }

    if (event.type === "delegation-complete") {
      if (event.result.output.kind === "structured") {
        state.actions.push(...this.extractActions(event.result.output));
      }
      return;
    }

    if (event.type === "complete") {
      this.handleCompleteEvent(event, task, state.fullResponse, state.citations, state.actions);
      return;
    }

    if (event.type === "error") {
      throw event.error;
    }
  }

  /**
   * Create fallback result when no complete event received
   */
  private createFallbackResult(
    task: AgentTask,
    fullResponse: string,
    citations: string[],
    actions: ProposedAction[],
  ): void {
    if (task.result || !fullResponse) {
      return;
    }

    task.chatHistory.push({
      role: "assistant",
      content: fullResponse,
    });
    task.result = {
      type: "chat",
      data: fullResponse,
      citations,
      actions: actions.length > 0 ? actions : undefined,
    };
  }

  /**
   * Execute a task using the ChiefOfStaff (multi-agent system)
   */
  private async executeTask(task: AgentTask): Promise<void> {
    if (!this.agent) {
      throw new Error("Agent not available");
    }

    this.currentAbortController = new AbortController();
    const chiefTask = this.toChiefOfStaffTask(task);
    const state = { fullResponse: "", citations: [] as string[], actions: [] as ProposedAction[] };

    try {
      for await (const event of this.agent.execute(chiefTask, this.currentAbortController.signal)) {
        if (task.status !== "running") {
          break;
        }
        this.processAgentEvent(event, task, state);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      throw error;
    }

    this.createFallbackResult(task, state.fullResponse, state.citations, state.actions);
  }

  /**
   * Emit a task update event
   */
  private emitUpdate(task: AgentTask): void {
    if (this.onTaskUpdateCallback) {
      this.onTaskUpdateCallback(task);
    }
    this.eventBus.emit("agent:task-update", { task });
  }
}
