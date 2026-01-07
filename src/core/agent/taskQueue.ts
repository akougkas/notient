/**
 * Agent Task Queue
 *
 * Manages a queue of agent tasks for sequential execution.
 * Tasks are processed one at a time, with support for cancellation
 * and progress tracking.
 *
 * Phase 2: Integrates with ConversationStore for conversation persistence.
 */

import type { EventBus } from "../events/eventBus";
import type { AgentTask } from "./types";
import type { NotientAgent } from "./agentLoop";
import type { ConversationStore } from "../chat/conversationStore";
import type { ExtendedChatMessage } from "../chat/types";

/**
 * Callback for task update notifications
 */
type TaskUpdateCallback = (task: AgentTask) => void;

/**
 * Manages agent tasks in a queue with sequential execution
 */
export class AgentTaskQueue {
  private tasks: AgentTask[] = [];
  private currentTask: AgentTask | null = null;
  private currentAbortController: AbortController | null = null;
  private onTaskUpdateCallback?: TaskUpdateCallback;
  private conversationStore?: ConversationStore;

  constructor(
    private agent: NotientAgent,
    private eventBus: EventBus
  ) {}

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
  enqueue(
    task: Omit<AgentTask, "id" | "status" | "startedAt">
  ): string {
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
      // Prepend persisted history to any new messages
      mergedChatHistory = [...simplifiedHistory, ...newMessages];

      // Persist the new user messages (typically just one)
      for (const msg of newMessages) {
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
        void this.processNext();
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
   * Register a callback for task updates
   */
  onTaskUpdate(callback: TaskUpdateCallback): void {
    this.onTaskUpdateCallback = callback;
  }

  /**
   * Clear all completed/cancelled tasks
   */
  clearCompleted(): void {
    this.tasks = this.tasks.filter(
      (t) => t.status === "queued" || t.status === "running"
    );
  }

  /**
   * Process the next task in the queue
   */
  private async processNext(): Promise<void> {
    if (this.currentTask) return;

    const next = this.tasks.find((t) => t.status === "queued");
    if (!next) return;

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

      // Process next in queue
      void this.processNext();
    }
  }

  /**
   * Execute a task using the NotientAgent
   */
  private async executeTask(task: AgentTask): Promise<void> {
    // Create abort controller for this task
    this.currentAbortController = new AbortController();

    let fullResponse = "";

    try {
      for await (const event of this.agent.executeStreaming(
        task,
        this.currentAbortController.signal
      )) {
        if (task.status !== "running") break;

        switch (event.type) {
          case "progress":
            task.progress = event.progress;
            this.emitUpdate(task);
            break;

          case "chunk":
            fullResponse += event.content;
            break;

          case "citations":
            // Citations are handled in the complete event
            break;

          case "complete":
            // Add assistant response to chat history
            const assistantContent = event.result.data as string;
            task.chatHistory.push({
              role: "assistant",
              content: assistantContent,
            });
            task.result = event.result;

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
        citations: [],
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
