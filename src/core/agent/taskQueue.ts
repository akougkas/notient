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

import type { ProposedAction } from "../agentic/types";
import type { ChiefOfStaff, ChiefOfStaffTask } from "../agents/chiefOfStaff";
import type { AgentEvent, ConversationalOutput, StructuredOutput } from "../agents/types";
import type { ConversationStore } from "../chat/conversationStore";
import type { ExtendedChatMessage } from "../chat/types";
import type { EventBus } from "../events/eventBus";
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
  ) {
    console.log("[taskQueue:constructor] TRACE: START");
    console.log(`[taskQueue:constructor] TRACE: agent=${agent ? "provided" : "null"}`);
    console.log("[taskQueue:constructor] TRACE: END");
  }

  /**
   * Check if the agent is available for task execution
   */
  isAgentAvailable(): boolean {
    console.log("[taskQueue:isAgentAvailable] TRACE: START");
    const result = this.agent !== null;
    console.log(`[taskQueue:isAgentAvailable] TRACE: result=${result}`);
    console.log("[taskQueue:isAgentAvailable] TRACE: END");
    return result;
  }

  /**
   * Set the agent (for late binding when LLM becomes available)
   */
  setAgent(agent: ChiefOfStaff): void {
    console.log("[taskQueue:setAgent] TRACE: START");
    this.agent = agent;
    console.log("[taskQueue:setAgent] TRACE: agent set");
    console.log("[taskQueue:setAgent] TRACE: END");
  }

  /**
   * Set the conversation store for persistence (Phase 2)
   */
  setConversationStore(store: ConversationStore): void {
    console.log("[taskQueue:setConversationStore] TRACE: START");
    this.conversationStore = store;
    console.log("[taskQueue:setConversationStore] TRACE: store set");
    console.log("[taskQueue:setConversationStore] TRACE: END");
  }

  /**
   * Enqueue a new task
   * @param task - Task data (without id, status, startedAt)
   * @returns The task ID
   */
  enqueue(task: Omit<AgentTask, "id" | "status" | "startedAt">): string {
    console.log("[taskQueue:enqueue] TRACE: START");
    // Check LLM availability first - provide clear error message
    if (!this.agent) {
      console.log("[taskQueue:enqueue] TRACE: agent not available, throwing");
      console.error("[AgentTaskQueue] Cannot enqueue task - LLM agent not available");
      throw new Error(
        "LM Studio connection required for agent tasks. Please ensure LM Studio is running.",
      );
    }

    // Backpressure: reject if queue is full (prevents memory exhaustion)
    console.log("[taskQueue:enqueue] TRACE: checking queue size");
    const queuedCount = this.tasks.filter((t) => t.status === "queued").length;
    console.log(`[taskQueue:enqueue] TRACE: queuedCount=${queuedCount}`);
    if (queuedCount >= MAX_QUEUE_SIZE) {
      console.log("[taskQueue:enqueue] TRACE: queue full, throwing");
      console.warn(`[AgentTaskQueue] Queue full (${queuedCount} tasks), rejecting new task`);
      throw new Error("Task queue is full. Please wait for current tasks to complete.");
    }

    const id = crypto.randomUUID();
    console.log(`[taskQueue:enqueue] TRACE: generated id=${id}`);

    // Phase 2: Handle conversation persistence
    const newMessages = task.chatHistory || [];
    let mergedChatHistory = newMessages;

    console.log("[taskQueue:enqueue] TRACE: checking conversationStore");
    if (this.conversationStore && task.notePath) {
      console.log(
        `[taskQueue:enqueue] TRACE: loading persisted history for notePath=${task.notePath}`,
      );
      // Load persisted conversation history
      const persistedHistory = this.conversationStore.getHistory(task.notePath);
      console.log(`[taskQueue:enqueue] TRACE: persistedHistory length=${persistedHistory.length}`);
      // Convert ExtendedChatMessage to ChatMessage for the agent
      const simplifiedHistory = persistedHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Deduplicate: only add new messages not already in persisted history
      // Compare by content since new messages don't have IDs yet
      const existingContents = new Set(simplifiedHistory.map((m) => m.content));
      const uniqueNewMessages = newMessages.filter((m) => !existingContents.has(m.content));
      console.log(`[taskQueue:enqueue] TRACE: uniqueNewMessages count=${uniqueNewMessages.length}`);

      // Merge: persisted history + only truly new messages
      mergedChatHistory = [...simplifiedHistory, ...uniqueNewMessages];

      // Limit total chat history to prevent unbounded growth (keep last 100 messages)
      const MAX_HISTORY_SIZE = 100;
      if (mergedChatHistory.length > MAX_HISTORY_SIZE) {
        console.log(`[taskQueue:enqueue] TRACE: trimming chat history to ${MAX_HISTORY_SIZE}`);
        mergedChatHistory = mergedChatHistory.slice(-MAX_HISTORY_SIZE);
      }

      // Persist the new user messages (only truly new ones)
      console.log("[taskQueue:enqueue] TRACE: persisting new user messages");
      for (let i = 0; i < uniqueNewMessages.length; i++) {
        const msg = uniqueNewMessages[i];
        console.log(
          `[taskQueue:enqueue] TRACE: processing uniqueNewMessage index=${i} role=${msg.role}`,
        );
        if (msg.role === "user") {
          const userMessage: ExtendedChatMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: msg.content,
            timestamp: new Date(),
          };
          console.log("[taskQueue:enqueue] TRACE: before appendMessage");
          this.conversationStore.appendMessage(task.notePath, userMessage);
          console.log("[taskQueue:enqueue] TRACE: after appendMessage");
        }
      }
    }

    console.log("[taskQueue:enqueue] TRACE: creating newTask object");
    const newTask: AgentTask = {
      ...task,
      id,
      status: "queued",
      startedAt: new Date(),
      progress: 0,
      chatHistory: mergedChatHistory,
    };

    console.log("[taskQueue:enqueue] TRACE: pushing to tasks array");
    this.tasks.push(newTask);
    console.log("[taskQueue:enqueue] TRACE: before emitUpdate");
    this.emitUpdate(newTask);
    console.log("[taskQueue:enqueue] TRACE: after emitUpdate");

    // Trigger processing (async)
    console.log("[taskQueue:enqueue] TRACE: calling processNext");
    void this.processNext();

    console.log(`[taskQueue:enqueue] TRACE: END returning id=${id}`);
    return id;
  }

  /**
   * Cancel a task
   * @param taskId - ID of the task to cancel
   */
  cancel(taskId: string): void {
    console.log(`[taskQueue:cancel] TRACE: START taskId=${taskId}`);
    const task = this.getById(taskId);
    if (!task) {
      console.log("[taskQueue:cancel] TRACE: task not found, returning");
      return;
    }

    console.log(`[taskQueue:cancel] TRACE: task.status=${task.status}`);
    if (task.status === "running" || task.status === "queued") {
      // Abort any ongoing streaming
      if (this.currentTask?.id === taskId && this.currentAbortController) {
        console.log("[taskQueue:cancel] TRACE: aborting current task");
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }

      console.log("[taskQueue:cancel] TRACE: setting status to cancelled");
      task.status = "cancelled";
      task.completedAt = new Date();
      console.log("[taskQueue:cancel] TRACE: before emitUpdate");
      this.emitUpdate(task);
      console.log("[taskQueue:cancel] TRACE: after emitUpdate");

      // If it was running, clear currentTask to proceed
      if (this.currentTask?.id === taskId) {
        console.log("[taskQueue:cancel] TRACE: clearing currentTask and scheduling processNext");
        this.currentTask = null;
        queueMicrotask(() => this.processNext());
      }
    } else {
      console.log("[taskQueue:cancel] TRACE: task not in cancellable state");
    }
    console.log("[taskQueue:cancel] TRACE: END");
  }

  /**
   * Get all tasks
   */
  getAll(): AgentTask[] {
    console.log("[taskQueue:getAll] TRACE: START");
    const result = [...this.tasks];
    console.log(`[taskQueue:getAll] TRACE: returning ${result.length} tasks`);
    console.log("[taskQueue:getAll] TRACE: END");
    return result;
  }

  /**
   * Get a task by ID
   */
  getById(taskId: string): AgentTask | undefined {
    console.log(`[taskQueue:getById] TRACE: START taskId=${taskId}`);
    const result = this.tasks.find((t) => t.id === taskId);
    console.log(`[taskQueue:getById] TRACE: found=${result ? "yes" : "no"}`);
    console.log("[taskQueue:getById] TRACE: END");
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
    console.log(`[taskQueue:waitForCompletion] TRACE: START taskId=${taskId}`);
    return new Promise((resolve, reject) => {
      console.log("[taskQueue:waitForCompletion] TRACE: inside Promise executor");
      const task = this.getById(taskId);
      if (!task) {
        console.log("[taskQueue:waitForCompletion] TRACE: task not found, rejecting");
        reject(new Error(`Task not found: ${taskId}`));
        return;
      }

      // If already in terminal state, resolve immediately
      console.log(`[taskQueue:waitForCompletion] TRACE: task.status=${task.status}`);
      if (task.status === "completed") {
        console.log("[taskQueue:waitForCompletion] TRACE: already completed, resolving");
        resolve(task);
        return;
      }
      if (task.status === "failed" || task.status === "cancelled") {
        console.log("[taskQueue:waitForCompletion] TRACE: already failed/cancelled, rejecting");
        reject(new Error(task.error || `Task ${task.status}`));
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        console.log("[taskQueue:waitForCompletion:cleanup] TRACE: START");
        if (timeoutId) {
          console.log("[taskQueue:waitForCompletion:cleanup] TRACE: clearing timeout");
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (unsubscribe) {
          console.log("[taskQueue:waitForCompletion:cleanup] TRACE: unsubscribing");
          unsubscribe();
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          console.log("[taskQueue:waitForCompletion:cleanup] TRACE: removing abort handler");
          options.signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        console.log("[taskQueue:waitForCompletion:cleanup] TRACE: END");
      };

      // Listen for task updates
      console.log("[taskQueue:waitForCompletion] TRACE: subscribing to agent:task-update");
      unsubscribe = this.eventBus.on("agent:task-update", (event) => {
        console.log(
          `[taskQueue:waitForCompletion:handler] TRACE: received event for task=${event.task.id}`,
        );
        if (event.task.id !== taskId) {
          console.log("[taskQueue:waitForCompletion:handler] TRACE: not our task, ignoring");
          return;
        }

        console.log(
          `[taskQueue:waitForCompletion:handler] TRACE: event.task.status=${event.task.status}`,
        );
        if (event.task.status === "completed") {
          console.log("[taskQueue:waitForCompletion:handler] TRACE: completed, resolving");
          cleanup();
          resolve(event.task);
        } else if (event.task.status === "failed" || event.task.status === "cancelled") {
          console.log("[taskQueue:waitForCompletion:handler] TRACE: failed/cancelled, rejecting");
          cleanup();
          reject(new Error(event.task.error || `Task ${event.task.status}`));
        }
      });

      // Set up timeout
      if (options?.timeoutMs) {
        console.log(
          `[taskQueue:waitForCompletion] TRACE: setting timeout for ${options.timeoutMs}ms`,
        );
        timeoutId = setTimeout(() => {
          console.log("[taskQueue:waitForCompletion:timeout] TRACE: timeout triggered");
          cleanup();
          // Cancel the task on timeout
          this.cancel(taskId);
          reject(new Error("Task timeout"));
        }, options.timeoutMs);
      }

      // Handle abort signal
      if (options?.signal) {
        console.log("[taskQueue:waitForCompletion] TRACE: checking abort signal");
        if (options.signal.aborted) {
          console.log("[taskQueue:waitForCompletion] TRACE: already aborted, rejecting");
          cleanup();
          this.cancel(taskId);
          reject(new Error("Task aborted"));
          return;
        }

        console.log("[taskQueue:waitForCompletion] TRACE: adding abort listener");
        abortHandler = () => {
          console.log("[taskQueue:waitForCompletion:abortHandler] TRACE: abort triggered");
          cleanup();
          this.cancel(taskId);
          reject(new Error("Task aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
      console.log("[taskQueue:waitForCompletion] TRACE: Promise executor done, waiting for events");
    });
  }

  /**
   * Register a callback for task updates
   */
  onTaskUpdate(callback: TaskUpdateCallback): void {
    console.log("[taskQueue:onTaskUpdate] TRACE: START");
    this.onTaskUpdateCallback = callback;
    console.log("[taskQueue:onTaskUpdate] TRACE: callback registered");
    console.log("[taskQueue:onTaskUpdate] TRACE: END");
  }

  /**
   * Clear all completed/cancelled tasks
   */
  clearCompleted(): void {
    console.log("[taskQueue:clearCompleted] TRACE: START");
    const beforeCount = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.status === "queued" || t.status === "running");
    const afterCount = this.tasks.length;
    console.log(`[taskQueue:clearCompleted] TRACE: cleared ${beforeCount - afterCount} tasks`);
    console.log("[taskQueue:clearCompleted] TRACE: END");
  }

  /**
   * Process the next task in the queue.
   * Protected against concurrent invocations.
   */
  private async processNext(): Promise<void> {
    console.log("[taskQueue:processNext] TRACE: START");
    // Guard against concurrent processing
    if (this.processing || this.currentTask) {
      console.log("[taskQueue:processNext] TRACE: already processing, returning");
      return;
    }
    this.processing = true;

    try {
      const next = this.tasks.find((t) => t.status === "queued");
      if (!next) {
        console.log("[taskQueue:processNext] TRACE: no queued task");
        return;
      }

      console.log(`[taskQueue:processNext] TRACE: running task id=${next.id}`);
      this.currentTask = next;
      next.status = "running";
      this.emitUpdate(next);

      await this.runTask(next);
    } finally {
      this.processing = false;
      this.scheduleNextIfQueued();
    }
    console.log("[taskQueue:processNext] TRACE: END");
  }

  /**
   * Execute a single task with error handling and status updates.
   */
  private async runTask(task: AgentTask): Promise<void> {
    try {
      console.log("[taskQueue:runTask] TRACE: executing");
      await this.executeTask(task);
      console.log("[taskQueue:runTask] TRACE: completed");

      if (task.status === "running") {
        task.status = "completed";
        task.completedAt = new Date();
        task.progress = 100;
      }
    } catch (error) {
      console.log("[taskQueue:runTask] TRACE: failed", error);
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
      console.log("[taskQueue:scheduleNextIfQueued] TRACE: scheduling next");
      queueMicrotask(() => this.processNext());
    } else {
      console.log("[taskQueue:scheduleNextIfQueued] TRACE: queue empty, not scheduling");
    }
  }

  /**
   * Convert legacy AgentTask to ChiefOfStaffTask
   */
  private toChiefOfStaffTask(task: AgentTask): ChiefOfStaffTask {
    console.log("[taskQueue:toChiefOfStaffTask] TRACE: START");
    // Get the user query from chat history
    const userMessages = task.chatHistory.filter((m) => m.role === "user");
    const query = userMessages[userMessages.length - 1]?.content || "";
    console.log(`[taskQueue:toChiefOfStaffTask] TRACE: extracted query length=${query.length}`);

    console.log(`[taskQueue:toChiefOfStaffTask] TRACE: mapping taskType=${task.taskType}`);
    const targetAgent = this.mapTaskTypeToAgent(task.taskType);
    console.log(`[taskQueue:toChiefOfStaffTask] TRACE: targetAgent=${targetAgent}`);

    const result = {
      query,
      notePath: task.notePath,
      noteTitle: task.noteTitle,
      chatHistory: task.chatHistory,
      // Map legacy taskType to targetAgent if appropriate
      targetAgent,
    };
    console.log("[taskQueue:toChiefOfStaffTask] TRACE: END");
    return result;
  }

  /**
   * Map taskType to expert agent type.
   *
   * IMPORTANT: TaskQueue is for EXPERT AGENTS ONLY. Every task MUST have a valid
   * taskType that maps to an expert agent. If taskType is missing or invalid,
   * we throw an error - NO fallback to chat routing.
   *
   * Valid expert agents: note-editor, classifier, connection
   * Legacy names are supported for backwards compatibility.
   *
   * @throws Error if taskType is missing or doesn't map to an expert agent
   */
  private mapTaskTypeToAgent(taskType?: string): "note-editor" | "classifier" | "connection" {
    console.log(`[taskQueue:mapTaskTypeToAgent] TRACE: START taskType=${taskType}`);
    let result: "note-editor" | "classifier" | "connection";
    switch (taskType) {
      // New agent names (pass through)
      case "note-editor":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched note-editor");
        result = "note-editor";
        break;
      case "classifier":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched classifier");
        result = "classifier";
        break;
      case "connection":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched connection");
        result = "connection";
        break;
      // Legacy task names (map to new agents)
      case "enrich":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched legacy enrich -> note-editor");
        result = "note-editor";
        break;
      case "classify":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched legacy classify -> classifier");
        result = "classifier";
        break;
      case "link":
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: matched legacy link -> connection");
        result = "connection";
        break;
      default:
        console.log("[taskQueue:mapTaskTypeToAgent] TRACE: no match, throwing error");
        throw new Error(
          `TaskQueue requires a valid expert agent taskType. Got: "${taskType ?? "undefined"}". Valid types: note-editor, classifier, connection (or legacy: enrich, classify, link). For chat conversations, use ChatService directly.`,
        );
    }
    console.log(`[taskQueue:mapTaskTypeToAgent] TRACE: END result=${result}`);
    return result;
  }

  /**
   * Extract actions from AgentOutput
   */
  private extractActions(output: StructuredOutput | ConversationalOutput): ProposedAction[] {
    console.log(`[taskQueue:extractActions] TRACE: START kind=${output.kind}`);
    if (output.kind === "structured") {
      const data = output.data as { actions?: ProposedAction[] };
      const actions = data.actions || [];
      console.log(`[taskQueue:extractActions] TRACE: extracted ${actions.length} actions`);
      console.log("[taskQueue:extractActions] TRACE: END");
      return actions;
    }
    console.log("[taskQueue:extractActions] TRACE: not structured, returning empty");
    console.log("[taskQueue:extractActions] TRACE: END");
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
    console.log(`[taskQueue:mapAgentTypeToResultType] TRACE: START agentType=${agentType}`);
    let result: TaskResult["type"];
    switch (agentType) {
      case "note-editor":
        console.log(
          "[taskQueue:mapAgentTypeToResultType] TRACE: matched note-editor -> action_plan",
        );
        result = "action_plan";
        break;
      case "classifier":
        console.log(
          "[taskQueue:mapAgentTypeToResultType] TRACE: matched classifier -> classification",
        );
        result = "classification";
        break;
      case "connection":
        console.log("[taskQueue:mapAgentTypeToResultType] TRACE: matched connection -> links");
        result = "links";
        break;
      default:
        // Expert agents may produce conversational explanations alongside structured output
        console.log("[taskQueue:mapAgentTypeToResultType] TRACE: default -> chat");
        result = "chat";
        break;
    }
    console.log(`[taskQueue:mapAgentTypeToResultType] TRACE: END result=${result}`);
    return result;
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
    console.log("[taskQueue:buildConversationalResult] TRACE: START");
    const resultData = output.content || fullResponse;
    console.log(
      `[taskQueue:buildConversationalResult] TRACE: resultData length=${typeof resultData === "string" ? resultData.length : "non-string"}`,
    );
    const allActions = [...actions];
    console.log(
      `[taskQueue:buildConversationalResult] TRACE: initial actions count=${allActions.length}`,
    );

    // Include delegated results' actions
    if (output.delegatedResults) {
      console.log(
        `[taskQueue:buildConversationalResult] TRACE: processing delegatedResults count=${output.delegatedResults.length}`,
      );
      for (let i = 0; i < output.delegatedResults.length; i++) {
        const dr = output.delegatedResults[i];
        console.log(
          `[taskQueue:buildConversationalResult] TRACE: extracting from delegatedResult index=${i}`,
        );
        allActions.push(...this.extractActions(dr.output));
      }
    }

    console.log(
      `[taskQueue:buildConversationalResult] TRACE: final actions count=${allActions.length}`,
    );
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
    console.log("[taskQueue:buildConversationalResult] TRACE: END");
    return result;
  }

  /**
   * Build TaskResult from structured output
   */
  private buildStructuredResult(
    output: StructuredOutput,
    citations: string[],
  ): { result: TaskResult; resultData: unknown; actions: ProposedAction[] } {
    console.log("[taskQueue:buildStructuredResult] TRACE: START");
    console.log("[taskQueue:buildStructuredResult] TRACE: calling mapAgentTypeToResultType");
    const resultType = this.mapAgentTypeToResultType(output.agentType);
    const resultData = output.data;
    console.log("[taskQueue:buildStructuredResult] TRACE: calling extractActions");
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
    console.log("[taskQueue:buildStructuredResult] TRACE: END");
    return result;
  }

  /**
   * Persist assistant message to conversation store
   */
  private persistAssistantMessage(notePath: string, content: string): void {
    console.log(`[taskQueue:persistAssistantMessage] TRACE: START notePath=${notePath}`);
    if (!this.conversationStore) {
      console.log("[taskQueue:persistAssistantMessage] TRACE: no conversationStore, returning");
      return;
    }

    console.log("[taskQueue:persistAssistantMessage] TRACE: creating assistantMessage");
    const assistantMessage: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date(),
    };
    console.log("[taskQueue:persistAssistantMessage] TRACE: before appendMessage");
    this.conversationStore.appendMessage(notePath, assistantMessage);
    console.log("[taskQueue:persistAssistantMessage] TRACE: after appendMessage");
    console.log("[taskQueue:persistAssistantMessage] TRACE: END");
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
    console.log("[taskQueue:handleCompleteEvent] TRACE: START");
    const output = event.output;
    let built: { result: TaskResult; resultData: unknown; actions: ProposedAction[] };

    console.log(`[taskQueue:handleCompleteEvent] TRACE: Building result, kind=${output.kind}`);
    if (output.kind === "conversational") {
      console.log("[taskQueue:handleCompleteEvent] TRACE: calling buildConversationalResult");
      built = this.buildConversationalResult(output, fullResponse, citations, actions);
    } else if (output.kind === "structured") {
      console.log("[taskQueue:handleCompleteEvent] TRACE: calling buildStructuredResult");
      built = this.buildStructuredResult(output, citations);
    } else {
      // Internal output (context-builder) - treat as chat
      console.log("[taskQueue:handleCompleteEvent] TRACE: internal output, building chat result");
      built = {
        result: { type: "chat", data: fullResponse, citations },
        resultData: fullResponse,
        actions: [],
      };
    }
    console.log("[taskQueue:handleCompleteEvent] TRACE: Result built");

    // Format assistant content for chat history
    console.log("[taskQueue:handleCompleteEvent] TRACE: Formatting assistant content");
    const assistantContent =
      typeof built.resultData === "string"
        ? built.resultData
        : fullResponse || JSON.stringify(built.resultData);

    console.log("[taskQueue:handleCompleteEvent] TRACE: Pushing to chatHistory");
    task.chatHistory.push({
      role: "assistant",
      content: assistantContent,
    });
    task.result = built.result;
    console.log("[taskQueue:handleCompleteEvent] TRACE: END");

    // DISABLED: ConversationStore persistence suspected as freeze cause
    // The flush() calls JSON.stringify(data, null, 2) + fd.sync() which blocks main thread
    // if (task.notePath) {
    //   this.persistAssistantMessage(task.notePath, assistantContent);
    // }
  }

  /**
   * Process a single agent event during task execution
   */
  private processAgentEvent(
    event: AgentEvent,
    task: AgentTask,
    state: { fullResponse: string; citations: string[]; actions: ProposedAction[] },
  ): void {
    console.log(`[taskQueue:processAgentEvent] TRACE: START event.type=${event.type}`);
    if (event.type === "started") {
      console.log("[taskQueue:processAgentEvent] TRACE: handling started event");
      task.progress = 5;
      console.log("[taskQueue:processAgentEvent] TRACE: before emitUpdate (started)");
      this.emitUpdate(task);
      console.log("[taskQueue:processAgentEvent] TRACE: after emitUpdate (started)");
      console.log("[taskQueue:processAgentEvent] TRACE: END (started)");
      return;
    }

    if (event.type === "progress") {
      console.log(
        `[taskQueue:processAgentEvent] TRACE: handling progress event, progress=${event.progress}`,
      );
      task.progress = event.progress;
      console.log("[taskQueue:processAgentEvent] TRACE: before emitUpdate (progress)");
      this.emitUpdate(task);
      console.log("[taskQueue:processAgentEvent] TRACE: after emitUpdate (progress)");
      console.log("[taskQueue:processAgentEvent] TRACE: END (progress)");
      return;
    }

    if (event.type === "chunk") {
      console.log(
        `[taskQueue:processAgentEvent] TRACE: handling chunk event, chunk length=${event.content.length}`,
      );
      state.fullResponse += event.content;
      console.log("[taskQueue:processAgentEvent] TRACE: END (chunk)");
      return;
    }

    if (event.type === "citations") {
      console.log(
        `[taskQueue:processAgentEvent] TRACE: handling citations event, paths count=${event.paths.length}`,
      );
      state.citations.push(...event.paths);
      console.log("[taskQueue:processAgentEvent] TRACE: END (citations)");
      return;
    }

    if (event.type === "delegation-started") {
      console.log("[taskQueue:processAgentEvent] TRACE: handling delegation-started event");
      task.progress = Math.min(task.progress || 0, 50) + 10;
      console.log("[taskQueue:processAgentEvent] TRACE: before emitUpdate (delegation-started)");
      this.emitUpdate(task);
      console.log("[taskQueue:processAgentEvent] TRACE: after emitUpdate (delegation-started)");
      console.log("[taskQueue:processAgentEvent] TRACE: END (delegation-started)");
      return;
    }

    if (event.type === "delegation-complete") {
      console.log("[taskQueue:processAgentEvent] TRACE: handling delegation-complete event");
      if (event.result.output.kind === "structured") {
        console.log(
          "[taskQueue:processAgentEvent] TRACE: extracting actions from structured delegation result",
        );
        state.actions.push(...this.extractActions(event.result.output));
      }
      console.log("[taskQueue:processAgentEvent] TRACE: END (delegation-complete)");
      return;
    }

    if (event.type === "complete") {
      console.log(
        "[taskQueue:processAgentEvent] TRACE: Received complete event, calling handleCompleteEvent",
      );
      this.handleCompleteEvent(event, task, state.fullResponse, state.citations, state.actions);
      console.log("[taskQueue:processAgentEvent] TRACE: handleCompleteEvent finished");
      console.log("[taskQueue:processAgentEvent] TRACE: END (complete)");
      return;
    }

    if (event.type === "error") {
      console.log("[taskQueue:processAgentEvent] TRACE: handling error event, throwing");
      throw event.error;
    }

    console.log("[taskQueue:processAgentEvent] TRACE: END (unhandled event type)");
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
    console.log("[taskQueue:createFallbackResult] TRACE: START");
    console.log(
      `[taskQueue:createFallbackResult] TRACE: task.result=${task.result ? "exists" : "null"} fullResponse.length=${fullResponse.length}`,
    );
    if (task.result || !fullResponse) {
      console.log(
        "[taskQueue:createFallbackResult] TRACE: skipping (already has result or no response)",
      );
      console.log("[taskQueue:createFallbackResult] TRACE: END (skipped)");
      return;
    }

    console.log("[taskQueue:createFallbackResult] TRACE: pushing to chatHistory");
    task.chatHistory.push({
      role: "assistant",
      content: fullResponse,
    });
    console.log("[taskQueue:createFallbackResult] TRACE: setting task.result");
    task.result = {
      type: "chat",
      data: fullResponse,
      citations,
      actions: actions.length > 0 ? actions : undefined,
    };
    console.log("[taskQueue:createFallbackResult] TRACE: END");
  }

  /**
   * Execute a task using the ChiefOfStaff (multi-agent system)
   */
  private async executeTask(task: AgentTask): Promise<void> {
    console.log("[taskQueue:executeTask] TRACE: START");
    if (!this.agent) {
      console.log("[taskQueue:executeTask] TRACE: agent not available, throwing");
      throw new Error("Agent not available");
    }

    console.log("[taskQueue:executeTask] TRACE: creating AbortController");
    this.currentAbortController = new AbortController();
    console.log("[taskQueue:executeTask] TRACE: calling toChiefOfStaffTask");
    const chiefTask = this.toChiefOfStaffTask(task);
    console.log("[taskQueue:executeTask] TRACE: toChiefOfStaffTask returned");
    const state = { fullResponse: "", citations: [] as string[], actions: [] as ProposedAction[] };

    try {
      console.log("[taskQueue:executeTask] TRACE: Starting for-await loop");
      let eventIndex = 0;
      for await (const event of this.agent.execute(chiefTask, this.currentAbortController.signal)) {
        console.log(
          `[taskQueue:executeTask] TRACE: Got event index=${eventIndex} type=${event.type}`,
        );
        if (task.status !== "running") {
          console.log("[taskQueue:executeTask] TRACE: task no longer running, breaking loop");
          break;
        }
        console.log("[taskQueue:executeTask] TRACE: calling processAgentEvent");
        this.processAgentEvent(event, task, state);
        console.log(`[taskQueue:executeTask] TRACE: processAgentEvent done for type=${event.type}`);
        eventIndex++;
      }
      console.log(
        `[taskQueue:executeTask] TRACE: for-await loop completed, total events=${eventIndex}`,
      );
    } catch (error) {
      console.log("[taskQueue:executeTask] TRACE: for-await threw error", error);
      if ((error as Error).name === "AbortError") {
        console.log("[taskQueue:executeTask] TRACE: AbortError, returning");
        return;
      }
      console.log("[taskQueue:executeTask] TRACE: re-throwing error");
      throw error;
    }

    console.log("[taskQueue:executeTask] TRACE: Calling createFallbackResult");
    this.createFallbackResult(task, state.fullResponse, state.citations, state.actions);
    console.log("[taskQueue:executeTask] TRACE: END");
  }

  /**
   * Emit a task update event
   */
  private emitUpdate(task: AgentTask): void {
    console.log(`[taskQueue:emitUpdate] TRACE: START task.id=${task.id} status=${task.status}`);
    if (this.onTaskUpdateCallback) {
      console.log("[taskQueue:emitUpdate] TRACE: calling onTaskUpdateCallback");
      this.onTaskUpdateCallback(task);
      console.log("[taskQueue:emitUpdate] TRACE: onTaskUpdateCallback done");
    } else {
      console.log("[taskQueue:emitUpdate] TRACE: no onTaskUpdateCallback");
    }
    // NUCLEAR TEST: Commenting out to isolate freeze cause
    // console.log("[taskQueue:emitUpdate] TRACE: before eventBus.emit");
    // this.eventBus.emit("agent:task-update", { task });
    // console.log("[taskQueue:emitUpdate] TRACE: after eventBus.emit");
    console.log("[taskQueue:emitUpdate] TRACE: END");
  }
}
