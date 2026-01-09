/**
 * Workflow Runner
 *
 * Orchestrates bulk operations across multiple notes.
 * Features:
 * - Sequential task execution (one task at a time)
 * - Configurable delay between tasks
 * - Progress tracking with events
 * - Cancel support (abort current + clear remaining)
 * - Continue-on-error (log failures, keep going)
 * - Medium/high-risk actions collected in review queue
 * - One workflow at a time (additional workflows queue)
 */

import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { AgentTaskQueue } from "../agent/taskQueue";
import type { TaskType } from "../agent/types";
import type { EventBus } from "../events/eventBus";
import type { Kernel } from "../kernel";
import type { ParsedCommand } from "./commandParser";
import type { ProposedAction, RiskLevel, WorkflowRun, WorkflowScope, WorkflowSpec } from "./types";

/**
 * Configuration for workflow runner
 */
export interface WorkflowConfig {
  /** Maximum notes per workflow (default: 100) */
  maxNotesPerWorkflow: number;
  /** Delay between tasks in milliseconds (default: 500) */
  delayBetweenTasksMs: number;
}

/**
 * Result of starting a workflow
 */
export interface StartWorkflowResult {
  success: boolean;
  workflowId?: string;
  error?: string;
  /** Number of notes that will be processed */
  noteCount?: number;
}

/**
 * Manages bulk workflow execution
 */
export class WorkflowRunner {
  private workflowQueue: WorkflowRun[] = [];
  private currentWorkflow: WorkflowRun | null = null;
  private currentTaskId: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private taskQueue: AgentTaskQueue,
    private obsidian: ObsidianFacade,
    private config: WorkflowConfig,
  ) {}

  /**
   * Start a workflow from a parsed command
   */
  async startFromCommand(parsed: ParsedCommand): Promise<StartWorkflowResult> {
    // Resolve target notes
    const targets = this.resolveTargets(parsed.scope, parsed.target);

    if (targets.length === 0) {
      return {
        success: false,
        error:
          parsed.scope === "folder"
            ? `No markdown files found in folder: ${parsed.target}`
            : "No markdown files found in vault",
      };
    }

    // Enforce max notes limit
    const limitedTargets = targets.slice(0, this.config.maxNotesPerWorkflow);
    const wasLimited = targets.length > this.config.maxNotesPerWorkflow;

    // Create workflow spec
    const spec: WorkflowSpec = {
      id: crypto.randomUUID(),
      command: parsed.command,
      scope: parsed.scope,
      targets: limitedTargets,
      createdAt: Date.now(),
      delayBetweenTasksMs: this.config.delayBetweenTasksMs,
    };

    // Create workflow run
    const run: WorkflowRun = {
      id: spec.id,
      spec,
      status: "queued",
      progress: {
        total: limitedTargets.length,
        completed: 0,
        failed: 0,
      },
      reviewQueue: [],
      appliedActionIds: [],
      errors: [],
    };

    // Queue the workflow
    this.workflowQueue.push(run);

    // If no current workflow, start this one
    if (!this.currentWorkflow) {
      void this.processNextWorkflow();
    }

    // Notify about limit
    if (wasLimited) {
      console.log(
        `[WorkflowRunner] Limited to ${this.config.maxNotesPerWorkflow} notes (${targets.length} found)`,
      );
    }

    return {
      success: true,
      workflowId: run.id,
      noteCount: limitedTargets.length,
    };
  }

  /**
   * Cancel the current or queued workflow
   */
  cancel(workflowId: string): boolean {
    // Check if it's the current workflow
    if (this.currentWorkflow?.id === workflowId) {
      return this.cancelCurrent();
    }

    // Check if it's in the queue
    const index = this.workflowQueue.findIndex((w) => w.id === workflowId);
    if (index >= 0) {
      const workflow = this.workflowQueue[index];
      workflow.status = "cancelled";
      workflow.completedAt = Date.now();
      this.workflowQueue.splice(index, 1);
      this.eventBus.emit("workflow:cancelled", { workflow });
      return true;
    }

    return false;
  }

  /**
   * Cancel the current running workflow
   */
  private cancelCurrent(): boolean {
    if (!this.currentWorkflow) return false;

    // Abort current task
    if (this.currentTaskId) {
      this.taskQueue.cancel(this.currentTaskId);
    }

    // Abort any pending operations
    if (this.abortController) {
      this.abortController.abort();
    }

    // Update workflow status
    this.currentWorkflow.status = "cancelled";
    this.currentWorkflow.completedAt = Date.now();

    this.eventBus.emit("workflow:cancelled", {
      workflow: this.currentWorkflow,
    });

    // Clear and process next
    this.currentWorkflow = null;
    this.currentTaskId = null;
    this.abortController = null;

    void this.processNextWorkflow();

    return true;
  }

  /**
   * Get the current running workflow
   */
  getCurrentWorkflow(): WorkflowRun | null {
    return this.currentWorkflow;
  }

  /**
   * Get all queued workflows
   */
  getQueuedWorkflows(): WorkflowRun[] {
    return [...this.workflowQueue];
  }

  /**
   * Get a workflow by ID (current or queued)
   */
  getWorkflow(id: string): WorkflowRun | null {
    if (this.currentWorkflow?.id === id) {
      return this.currentWorkflow;
    }
    return this.workflowQueue.find((w) => w.id === id) || null;
  }

  /**
   * Resolve target note paths based on scope
   */
  private resolveTargets(scope: WorkflowScope, target: string): string[] {
    const allFiles = this.obsidian.getMarkdownFiles();
    const excludedFolders = this.kernel.settings.indexing.excludedFolders;

    // Filter based on scope
    let files = allFiles.filter((file) => {
      // Exclude system folders
      for (const excluded of excludedFolders) {
        if (file.path.startsWith(`${excluded}/`) || file.path === excluded) {
          return false;
        }
      }
      return true;
    });

    if (scope === "folder" && target) {
      files = files.filter((file) => file.path.startsWith(`${target}/`) || file.path === target);
    }

    // Return paths sorted by name
    return files.map((f) => f.path).sort();
  }

  /**
   * Process the next workflow in the queue
   */
  private async processNextWorkflow(): Promise<void> {
    if (this.currentWorkflow) return;

    const next = this.workflowQueue.shift();
    if (!next) return;

    this.currentWorkflow = next;
    this.currentWorkflow.status = "running";
    this.currentWorkflow.startedAt = Date.now();
    this.abortController = new AbortController();

    this.eventBus.emit("workflow:started", { workflow: this.currentWorkflow });

    // CRITICAL: Store workflow in local variable to prevent race condition
    // when cancelCurrent() nulls this.currentWorkflow while we're still processing
    const workflow = this.currentWorkflow;

    try {
      await this.executeWorkflow(workflow);

      // Use local reference, not this.currentWorkflow (may be nulled by cancel)
      if (workflow.status === "running") {
        workflow.status = "completed";
        workflow.completedAt = Date.now();
        this.eventBus.emit("workflow:completed", { workflow });
      }
    } catch (error) {
      // Use local reference, not this.currentWorkflow (may be nulled by cancel)
      if (workflow.status === "running") {
        workflow.status = "failed";
        workflow.completedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.eventBus.emit("workflow:failed", { workflow, error: errorMessage });
      }
    } finally {
      this.currentWorkflow = null;
      this.currentTaskId = null;
      this.abortController = null;

      // Process next queued workflow
      void this.processNextWorkflow();
    }
  }

  /**
   * Execute a workflow by processing each target note
   */
  private async executeWorkflow(workflow: WorkflowRun): Promise<void> {
    const { spec } = workflow;

    for (let i = 0; i < spec.targets.length; i++) {
      // Check if cancelled
      if (workflow.status !== "running") break;
      if (this.abortController?.signal.aborted) break;

      const notePath = spec.targets[i];

      try {
        await this.processNote(workflow, notePath, spec.command);
        workflow.progress.completed++;
      } catch (error) {
        workflow.progress.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        workflow.errors.push({ taskId: this.currentTaskId || "", error: errorMessage });
        console.error(`[WorkflowRunner] Task failed for ${notePath}:`, error);
        // Continue-on-error: don't break, keep going
      }

      // Emit progress update
      this.eventBus.emit("workflow:progress", { workflow });

      // Delay before next task (unless this is the last one)
      if (i < spec.targets.length - 1 && workflow.status === "running") {
        await this.delay(spec.delayBetweenTasksMs);
      }
    }
  }

  /**
   * Process a single note with the specified command
   */
  private async processNote(
    workflow: WorkflowRun,
    notePath: string,
    command: string,
  ): Promise<void> {
    const file = this.obsidian.getFileByPath(notePath);
    if (!file) {
      throw new Error(`File not found: ${notePath}`);
    }

    const noteTitle = file.basename;

    // Map command to task type
    const taskType = this.commandToTaskType(command);

    // Build prompt based on command
    const prompt = this.buildPromptForCommand(command, noteTitle);

    // Enqueue task
    const taskId = this.taskQueue.enqueue({
      agent: "chat",
      taskType,
      notePath,
      noteTitle,
      chatHistory: [{ role: "user", content: prompt }],
    });

    this.currentTaskId = taskId;

    // Wait for completion using event-driven approach (no polling)
    const completedTask = await this.taskQueue.waitForCompletion(taskId, {
      timeoutMs: 120000, // 2 minute timeout per task
      signal: this.abortController?.signal,
    });

    // Collect medium/high-risk actions into review queue
    if (completedTask.result?.actions) {
      const reviewActions = completedTask.result.actions.filter((a) =>
        this.isReviewRequired(a.risk),
      );
      workflow.reviewQueue.push(...reviewActions);
    }
  }

  /**
   * Check if an action requires review (medium/high risk)
   */
  private isReviewRequired(risk: RiskLevel): boolean {
    return risk === "medium" || risk === "high";
  }

  /**
   * Map command name to task type
   */
  private commandToTaskType(command: string): TaskType {
    switch (command) {
      case "enrich":
        return "enrich";
      case "classify":
        return "classify";
      case "link":
        return "link";
      default:
        return "analyze";
    }
  }

  /**
   * Build a prompt for the given command and note
   */
  private buildPromptForCommand(command: string, noteTitle: string): string {
    switch (command) {
      case "enrich":
        return `Analyze "${noteTitle}" and suggest improvements: tags, metadata, related topics, and content expansions.`;
      case "classify":
        return `Analyze "${noteTitle}" and suggest the best PARA category (Projects, Areas, Resources, Archive) and folder placement.`;
      case "link":
        return `Analyze "${noteTitle}" and find notes that should be linked to it based on semantic similarity and topic relevance.`;
      default:
        return `Analyze "${noteTitle}" and provide insights.`;
    }
  }

  /**
   * Delay helper with proper abort cleanup
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const abortHandler = () => {
        clearTimeout(timeout);
        resolve();
      };

      const cleanup = () => {
        if (this.abortController) {
          this.abortController.signal.removeEventListener("abort", abortHandler);
        }
      };

      // Allow abort to cancel the delay (use once: true to avoid leaks)
      if (this.abortController) {
        this.abortController.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  /**
   * Remove an action from the review queue (user dismissed it)
   * Returns true if found and removed, false otherwise
   */
  dismissReviewItem(actionId: string): boolean {
    // Check current workflow
    if (this.currentWorkflow) {
      const idx = this.currentWorkflow.reviewQueue.findIndex((a) => a.id === actionId);
      if (idx !== -1) {
        this.currentWorkflow.reviewQueue.splice(idx, 1);
        this.eventBus.emit("workflow:reviewDismissed", {
          workflowId: this.currentWorkflow.id,
          actionId,
        });
        return true;
      }
    }

    // Check queued workflows
    for (const workflow of this.workflowQueue) {
      const idx = workflow.reviewQueue.findIndex((a) => a.id === actionId);
      if (idx !== -1) {
        workflow.reviewQueue.splice(idx, 1);
        this.eventBus.emit("workflow:reviewDismissed", {
          workflowId: workflow.id,
          actionId,
        });
        return true;
      }
    }

    return false;
  }

  /**
   * Mark an action as applied (user approved it)
   * Removes from review queue and adds to appliedActionIds
   * Returns the workflow ID if found, null otherwise
   */
  markActionApplied(actionId: string): string | null {
    // Check current workflow
    if (this.currentWorkflow) {
      const idx = this.currentWorkflow.reviewQueue.findIndex((a) => a.id === actionId);
      if (idx !== -1) {
        this.currentWorkflow.reviewQueue.splice(idx, 1);
        this.currentWorkflow.appliedActionIds.push(actionId);
        // Emit progress event to update UI
        this.eventBus.emit("workflow:progress", { workflow: this.currentWorkflow });
        return this.currentWorkflow.id;
      }
    }

    // Check queued workflows
    for (const workflow of this.workflowQueue) {
      const idx = workflow.reviewQueue.findIndex((a) => a.id === actionId);
      if (idx !== -1) {
        workflow.reviewQueue.splice(idx, 1);
        workflow.appliedActionIds.push(actionId);
        this.eventBus.emit("workflow:progress", { workflow });
        return workflow.id;
      }
    }

    return null;
  }

  /**
   * Find which workflow (if any) contains an action in its review queue
   */
  findWorkflowForAction(actionId: string): WorkflowRun | null {
    if (this.currentWorkflow) {
      const found = this.currentWorkflow.reviewQueue.some((a) => a.id === actionId);
      if (found) return this.currentWorkflow;
    }

    for (const workflow of this.workflowQueue) {
      const found = workflow.reviewQueue.some((a) => a.id === actionId);
      if (found) return workflow;
    }

    return null;
  }

  /**
   * Dispose of the workflow runner
   */
  dispose(): void {
    // Cancel current workflow
    if (this.currentWorkflow) {
      this.cancelCurrent();
    }

    // Cancel all queued workflows
    for (const workflow of this.workflowQueue) {
      workflow.status = "cancelled";
      workflow.completedAt = Date.now();
      this.eventBus.emit("workflow:cancelled", { workflow });
    }
    this.workflowQueue = [];
  }
}
