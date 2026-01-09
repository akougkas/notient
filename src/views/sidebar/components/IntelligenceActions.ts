/**
 * Intelligence 2.0 Actions Component
 *
 * Renders Intelligence 2.0 action buttons and handles pipeline execution
 * with streaming display of progress, analysis, and proposed actions.
 */

import { Notice, setIcon } from "obsidian";
import type { ActionApplier } from "../../../core/agentic/actionApplier";
import type { ProposedAction } from "../../../core/agentic/types";
import type {
  ActionContext,
  ActionOrchestrator,
} from "../../../core/intelligence/actionOrchestrator";
import type {
  ActionBatch,
  PipelineEvent,
  PipelineResult,
} from "../../../core/intelligence/actionPipeline";
import type { IntelligenceActionType } from "../../../core/intelligence/prompts";

/**
 * Configuration for IntelligenceActions component
 */
export interface IntelligenceActionsConfig {
  /** The orchestrator service */
  orchestrator: ActionOrchestrator;
  /** The action applier service */
  actionApplier: ActionApplier;
  /** Function to get current note context (async to support file reading) */
  getContext: () => Promise<ActionContext | null>;
  /** Function to get existing vault paths for duplicate detection */
  getExistingPaths: () => Set<string>;
}

/**
 * Component state during pipeline execution
 */
interface PipelineState {
  isRunning: boolean;
  actionType: IntelligenceActionType | null;
  phase: string;
  progress: number;
  streamedContent: string;
  analysis: string;
  proposedActions: ProposedAction[];
  batches: ActionBatch[];
  result: PipelineResult | null;
  error: Error | null;
}

/**
 * Intelligence 2.0 Actions Component
 */
export class IntelligenceActions {
  private containerEl: HTMLElement | null = null;
  private pipelineContainerEl: HTMLElement | null = null;
  private actionsContainerEl: HTMLElement | null = null;
  private state: PipelineState = this.initialState();

  constructor(private config: IntelligenceActionsConfig) {}

  private initialState(): PipelineState {
    return {
      isRunning: false,
      actionType: null,
      phase: "",
      progress: 0,
      streamedContent: "",
      analysis: "",
      proposedActions: [],
      batches: [],
      result: null,
      error: null,
    };
  }

  /**
   * Render the component
   */
  render(container: HTMLElement): HTMLElement {
    const section = container.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Intelligence Actions" });

    this.containerEl = section;

    // Action buttons grid
    this.actionsContainerEl = section.createDiv({ cls: "nv2-intelligence-actions" });
    this.renderActionButtons();

    // Pipeline execution area (hidden initially)
    this.pipelineContainerEl = section.createDiv({
      cls: "nv2-pipeline-container nv2-hidden",
    });

    return section;
  }

  /**
   * Render the action buttons
   */
  private renderActionButtons(): void {
    if (!this.actionsContainerEl) return;
    this.actionsContainerEl.empty();

    const actions: Array<{ type: IntelligenceActionType; primary?: boolean }> = [
      { type: "enhance", primary: true },
      { type: "connection" },
      { type: "atomic" },
      { type: "synthesis" },
      { type: "task" },
      { type: "clipping" },
      { type: "brand" },
    ];

    for (const action of actions) {
      const info = this.config.orchestrator.getActionInfo(action.type);
      const btn = this.actionsContainerEl.createDiv({
        cls: `nv2-intelligence-btn${action.primary ? " nv2-intelligence-btn--primary" : ""}`,
        title: info.description,
      });

      const iconEl = btn.createDiv({ cls: "nv2-intelligence-btn-icon" });
      setIcon(iconEl, info.icon);

      btn.createDiv({ cls: "nv2-intelligence-btn-label", text: info.label });

      btn.addEventListener("click", () => this.executeAction(action.type));
    }
  }

  /**
   * Execute an Intelligence 2.0 action
   */
  private async executeAction(actionType: IntelligenceActionType): Promise<void> {
    if (this.state.isRunning) {
      new Notice("An action is already running");
      return;
    }

    const context = await this.config.getContext();
    if (!context) {
      new Notice("Open a note to use Intelligence actions");
      return;
    }

    // Reset state
    this.state = {
      ...this.initialState(),
      isRunning: true,
      actionType,
    };

    // Show pipeline container
    if (this.pipelineContainerEl) {
      this.pipelineContainerEl.removeClass("nv2-hidden");
      this.renderPipelineState();
    }

    try {
      // Get existing paths for duplicate detection
      const existingPaths = this.config.getExistingPaths();

      // Execute the pipeline with existingPaths for duplicate detection
      const generator = this.config.orchestrator.execute(actionType, context, {
        existingPaths,
      });

      for await (const event of generator) {
        this.handlePipelineEvent(event);
        this.renderPipelineState();
      }
    } catch (error) {
      this.state.error = error instanceof Error ? error : new Error(String(error));
      this.state.phase = "error";
      this.renderPipelineState();
    } finally {
      this.state.isRunning = false;
      this.renderPipelineState();
    }
  }

  /**
   * Handle pipeline events
   */
  private handlePipelineEvent(event: PipelineEvent): void {
    switch (event.type) {
      case "phase":
        this.state.phase = event.phase;
        this.state.progress = event.progress;
        break;

      case "chunk":
        this.state.streamedContent += event.content;
        break;

      case "analysis":
        this.state.analysis = event.analysis;
        break;

      case "actions":
        this.state.proposedActions = event.actions;
        break;

      case "batches":
        this.state.batches = event.batches;
        break;

      case "complete":
        this.state.result = event.result;
        this.state.phase = "complete";
        this.state.progress = 100;
        break;

      case "error":
        this.state.error = event.error;
        this.state.phase = "error";
        break;
    }
  }

  /**
   * Render the current pipeline state
   */
  private renderPipelineState(): void {
    if (!this.pipelineContainerEl) return;
    this.pipelineContainerEl.empty();

    const info = this.state.actionType
      ? this.config.orchestrator.getActionInfo(this.state.actionType)
      : { icon: "zap", label: "Action" };

    // Header with action type and close button
    const header = this.pipelineContainerEl.createDiv({ cls: "nv2-pipeline-header" });

    const titleEl = header.createDiv({ cls: "nv2-pipeline-title" });
    const iconEl = titleEl.createSpan({ cls: "nv2-pipeline-icon" });
    setIcon(iconEl, info.icon);
    titleEl.createSpan({ text: info.label });

    if (!this.state.isRunning) {
      const closeBtn = header.createEl("button", { cls: "nv2-pipeline-close" });
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", () => this.closePipeline());
    }

    // Progress bar (if running)
    if (this.state.isRunning) {
      const progressContainer = this.pipelineContainerEl.createDiv({
        cls: "nv2-pipeline-progress-container",
      });

      const progressBar = progressContainer.createDiv({ cls: "nv2-pipeline-progress" });
      progressBar.createDiv({
        cls: "nv2-pipeline-progress-fill",
        attr: { style: `width: ${this.state.progress}%` },
      });

      const phaseLabel = this.getPhaseLabel(this.state.phase);
      progressContainer.createDiv({
        cls: "nv2-pipeline-phase",
        text: phaseLabel,
      });
    }

    // Streaming content (analysis in progress)
    if (this.state.streamedContent && !this.state.analysis) {
      const streamEl = this.pipelineContainerEl.createDiv({ cls: "nv2-pipeline-stream" });
      streamEl.setText(this.truncateContent(this.state.streamedContent, 500));
    }

    // Analysis result
    if (this.state.analysis) {
      const analysisEl = this.pipelineContainerEl.createDiv({ cls: "nv2-pipeline-analysis" });
      analysisEl.createDiv({ cls: "nv2-pipeline-analysis-label", text: "Analysis" });
      analysisEl.createDiv({
        cls: "nv2-pipeline-analysis-text",
        text: this.truncateContent(this.state.analysis, 300),
      });
    }

    // Error state
    if (this.state.error) {
      const errorEl = this.pipelineContainerEl.createDiv({ cls: "nv2-pipeline-error" });
      errorEl.createDiv({ cls: "nv2-pipeline-error-title", text: "Error" });
      errorEl.createDiv({
        cls: "nv2-pipeline-error-text",
        text: this.state.error.message,
      });
    }

    // Proposed actions
    if (this.state.proposedActions.length > 0 && !this.state.isRunning) {
      this.renderProposedActions();
    }
  }

  /**
   * Render proposed actions with Apply/Dismiss buttons
   */
  private renderProposedActions(): void {
    if (!this.pipelineContainerEl) return;

    const actionsSection = this.pipelineContainerEl.createDiv({
      cls: "nv2-pipeline-actions",
    });

    actionsSection.createDiv({
      cls: "nv2-pipeline-actions-header",
      text: `${this.state.proposedActions.length} Action${this.state.proposedActions.length > 1 ? "s" : ""} Proposed`,
    });

    const actionsList = actionsSection.createDiv({ cls: "nv2-pipeline-actions-list" });

    for (const action of this.state.proposedActions) {
      const item = actionsList.createDiv({ cls: "nv2-pipeline-action-item" });

      // Risk badge
      item.createDiv({
        cls: `nv2-risk-badge nv2-risk-badge--${action.risk}`,
        text: action.risk,
      });

      // Action info
      const info = item.createDiv({ cls: "nv2-pipeline-action-info" });
      info.createDiv({ cls: "nv2-pipeline-action-title", text: action.title });
      info.createDiv({ cls: "nv2-pipeline-action-reason", text: action.reason });

      // Action buttons
      const buttons = item.createDiv({ cls: "nv2-pipeline-action-buttons" });

      const applyBtn = buttons.createEl("button", {
        cls: "nv2-btn nv2-btn--primary nv2-btn--small",
        text: "Apply",
      });
      applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = "Applying...";

        const result = await this.config.actionApplier.applyConfirmed(action);
        if (result.success) {
          new Notice(`Applied: ${action.title}`);
          item.remove();
          // Update state
          this.state.proposedActions = this.state.proposedActions.filter((a) => a.id !== action.id);
          if (this.state.proposedActions.length === 0) {
            actionsSection.remove();
          }
        } else {
          new Notice(`Failed: ${result.error}`);
          applyBtn.disabled = false;
          applyBtn.textContent = "Apply";
        }
      });

      const dismissBtn = buttons.createEl("button", {
        cls: "nv2-btn nv2-btn--small",
        text: "Dismiss",
      });
      dismissBtn.addEventListener("click", () => {
        item.remove();
        this.state.proposedActions = this.state.proposedActions.filter((a) => a.id !== action.id);
        if (this.state.proposedActions.length === 0) {
          actionsSection.remove();
        }
      });
    }

    // Apply All / Dismiss All buttons
    if (this.state.proposedActions.length > 1) {
      const bulkActions = actionsSection.createDiv({ cls: "nv2-pipeline-bulk-actions" });

      const applyAllBtn = bulkActions.createEl("button", {
        cls: "nv2-btn nv2-btn--primary",
        text: "Apply All",
      });
      applyAllBtn.addEventListener("click", async () => {
        applyAllBtn.disabled = true;
        applyAllBtn.textContent = "Applying...";

        let applied = 0;
        for (const action of [...this.state.proposedActions]) {
          const result = await this.config.actionApplier.applyConfirmed(action);
          if (result.success) {
            applied++;
          }
        }
        new Notice(`Applied ${applied}/${this.state.proposedActions.length} actions`);
        this.closePipeline();
      });

      const dismissAllBtn = bulkActions.createEl("button", {
        cls: "nv2-btn",
        text: "Dismiss All",
      });
      dismissAllBtn.addEventListener("click", () => {
        this.closePipeline();
      });
    }
  }

  /**
   * Close the pipeline display
   */
  private closePipeline(): void {
    this.state = this.initialState();
    if (this.pipelineContainerEl) {
      this.pipelineContainerEl.addClass("nv2-hidden");
      this.pipelineContainerEl.empty();
    }
  }

  /**
   * Get human-readable phase label
   */
  private getPhaseLabel(phase: string): string {
    switch (phase) {
      case "preparation":
        return "Preparing context...";
      case "analysis":
        return "Analyzing...";
      case "planning":
        return "Planning actions...";
      case "batching":
        return "Organizing batches...";
      case "complete":
        return "Complete";
      case "error":
        return "Error";
      default:
        return phase || "Initializing...";
    }
  }

  /**
   * Truncate content for display
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength).trimEnd() + "...";
  }
}
