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
  ) {}

  /**
   * Check if the agent is available for task execution
   */
  isAgentAvailable(): boolean {
    return this.agent !== null;
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

    const id = crypto.randomUUID();

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
      for (const msg of uniqueNewMessages) {
        if (msg.role === "user") {
          const userMessage: ExtendedChatMessage = {
            id: crypto.randomUUID(),
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
    if (!task) return;

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
   * Get all tasks
   */
  getAll(): AgentTask[] {
    return [...this.tasks];
  }

  /**
   * Get a task by ID
   */
  getById(taskId: string): AgentTask | undefined {
    return this.tasks.find((t) => t.id === taskId);
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
        if (event.task.id !== taskId) return;

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
    this.tasks = this.tasks.filter((t) => t.status === "queued" || t.status === "running");
  }

  /**
   * Process the next task in the queue.
   * Protected against concurrent invocations.
   */
  private async processNext(): Promise<void> {
    // Guard against concurrent processing (fixes race condition)
    if (this.processing || this.currentTask) return;
    this.processing = true;

    try {
      const next = this.tasks.find((t) => t.status === "queued");
      if (!next) {
        this.processing = false;
        return;
      }

      this.currentTask = next;
      next.status = "running";
      this.emitUpdate(next);

      try {
        await this.executeTask(next);

        // Only mark completed if not already cancelled/failed
        if (next.status === "running") {
          next.status = "completed";
          next.completedAt = new Date();
          next.progress = 100;
        }
      } catch (error) {
        if (next.status === "running") {
          next.status = "failed";
          next.error = error instanceof Error ? error.message : String(error);
          next.completedAt = new Date();
        }
      } finally {
        this.emitUpdate(next);
        this.currentTask = null;
        this.currentAbortController = null;
      }
    } finally {
      this.processing = false;
      // Process next in queue (deferred to let call stack unwind)
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

    return {
      query,
      notePath: task.notePath,
      noteTitle: task.noteTitle,
      chatHistory: task.chatHistory,
      // Map legacy taskType to targetAgent if appropriate
      targetAgent: this.mapTaskTypeToAgent(task.taskType),
    };
  }

  /**
   * Map legacy taskType to new agent type
   */
  private mapTaskTypeToAgent(
    taskType?: string,
  ): "chat" | "note-editor" | "classifier" | "connection" | undefined {
    switch (taskType) {
      case "enrich":
        return "note-editor";
      case "classify":
        return "classifier";
      case "link":
        return "connection";
      default:
        return undefined; // Let ChiefOfStaff route automatically
    }
  }

  /**
   * Extract actions from AgentOutput
   */
  private extractActions(output: StructuredOutput | ConversationalOutput): ProposedAction[] {
    if (output.kind === "structured") {
      const data = output.data as { actions?: ProposedAction[] };
      return data.actions || [];
    }
    return [];
  }

  /**
   * Execute a task using the ChiefOfStaff (multi-agent system)
   */
  private async executeTask(task: AgentTask): Promise<void> {
    // Guard: should never happen since enqueue checks, but TypeScript needs this
    if (!this.agent) {
      throw new Error("Agent not available");
    }

    // Create abort controller for this task
    this.currentAbortController = new AbortController();

    // Convert to ChiefOfStaff task format
    const chiefTask = this.toChiefOfStaffTask(task);

    let fullResponse = "";
    const citations: string[] = [];
    let actions: ProposedAction[] = [];

    try {
      for await (const event of this.agent.execute(chiefTask, this.currentAbortController.signal)) {
        if (task.status !== "running") break;

        // Map AgentEvent to AgentStreamEvent equivalent
        switch (event.type) {
          case "started":
            task.progress = 5;
            this.emitUpdate(task);
            break;

          case "progress":
            task.progress = event.progress;
            this.emitUpdate(task);
            break;

          case "chunk":
            fullResponse += event.content;
            break;

          case "citations":
            citations.push(...event.paths);
            break;

          case "delegation-started":
            // Emit as progress update
            task.progress = Math.min(task.progress || 0, 50) + 10;
            this.emitUpdate(task);
            break;

          case "delegation-complete":
            // Extract any actions from delegated result
            if (event.result.output.kind === "structured") {
              const delegatedActions = this.extractActions(event.result.output);
              actions.push(...delegatedActions);
            }
            break;

          case "complete": {
            // Convert AgentOutput to TaskResult
            const output = event.output;
            let resultType: TaskResult["type"] = "chat";
            let resultData: unknown = fullResponse;

            if (output.kind === "conversational") {
              resultType = "chat";
              resultData = output.content || fullResponse;
              // Include delegated results' actions
              if (output.delegatedResults) {
                for (const dr of output.delegatedResults) {
                  const drActions = this.extractActions(dr.output);
                  actions.push(...drActions);
                }
              }
            } else if (output.kind === "structured") {
              // Determine result type from agent
              switch (output.agentType) {
                case "note-editor":
                  resultType = "action_plan";
                  break;
                case "classifier":
                  resultType = "classification";
                  break;
                case "connection":
                  resultType = "links";
                  break;
                default:
                  resultType = "chat";
              }
              resultData = output.data;
              actions = this.extractActions(output);
            }

            // Build TaskResult
            const result: TaskResult = {
              type: resultType,
              data: resultData,
              citations,
              actions: actions.length > 0 ? actions : undefined,
            };

            // Add assistant response to chat history
            const assistantContent =
              typeof resultData === "string"
                ? resultData
                : fullResponse || JSON.stringify(resultData);

            task.chatHistory.push({
              role: "assistant",
              content: assistantContent,
            });
            task.result = result;

            // Phase 2: Persist assistant message to ConversationStore
            if (this.conversationStore && task.notePath) {
              const assistantMessage: ExtendedChatMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: assistantContent,
                timestamp: new Date(),
              };
              this.conversationStore.appendMessage(task.notePath, assistantMessage);
            }
            break;
          }

          case "error":
            throw event.error;
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Task was cancelled - don't save partial response
        return;
      }
      throw error;
    }

    // If no complete event but we have content, create result
    if (!task.result && fullResponse) {
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
