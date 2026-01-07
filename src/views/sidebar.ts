/**
 * Notient Sidebar View v2 - Sentient Notes UI
 *
 * Two-view layout:
 * - Note View: Vitals Dashboard + Omnibar + Quick Actions
 * - Agents View: Agent Dashboard + Activity Log
 *
 * Features:
 * - Header tabs toggle between views
 * - View state persists during session
 * - AI queries with streaming support
 * - RAG-powered context retrieval
 */

import { ItemView, Notice, TFile, type WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type { AgentTaskQueue } from "../core/agent";
// New architecture imports (Phase 1.8)
import type { AgentType } from "../core/agent/types";
import { isSlashCommand, parseSlashCommand } from "../core/agentic/commandParser";
import type { WorkflowRun } from "../core/agentic/types";
// Phase 2: Workflow support (Milestone 2.4)
import type { WorkflowRunner } from "../core/agentic/workflowRunner";
import { VIEW_TYPE_SIDEBAR } from "../core/constants";
import type { VaultContextBuilder } from "../core/context/vaultContextBuilder";
import type { Kernel } from "../core/kernel";
import type { ChatMessage, LLMProvider } from "../core/llm";
import { ParaDetector } from "../core/para/detector";
import type { SearchPipeline } from "../core/search/pipeline";
import type { IndexProgress } from "../types/indexer";
import type { SearchResult } from "../types/search";
import { TaskModal } from "./taskModal";

// ============ Types ============

type SidebarView = "note" | "agents";

interface NoteVitals {
  health: {
    score: number;
    status: "healthy" | "attention" | "unhealthy";
  };
  links: {
    backlinks: number;
    outlinks: number;
  };
  freshness: {
    lastModified: Date;
    displayText: string;
  };
  title: string;
  path: string;
  paraType: string;
  tags: string[];
  isIndexed: boolean;
}

interface Attachment {
  id: string;
  type: "rag-citation" | "user-attached";
  filename: string;
  path: string;
}

interface ExtendedChatMessage extends ChatMessage {
  id: string;
  attachments?: Attachment[];
  timestamp: Date;
}

// ============ Main Sidebar View ============

export class NotientSidebarView extends ItemView {
  // State
  private currentView: SidebarView = "note";
  private noteVitals: NoteVitals | null = null;
  private chatHistory: ExtendedChatMessage[] = [];
  private isStreaming = false;
  private streamingContent = "";
  private activeAbortController: AbortController | null = null;
  private _lastSearchResults: SearchResult[] = [];

  // DOM references
  private containerEl_: HTMLElement | null = null;
  private contentEl_: HTMLElement | null = null;
  private omnibarInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;
  private footerProgressEl: HTMLElement | null = null;
  private footerStatsEl: HTMLElement | null = null;
  private lastSyncTime: Date | null = null;

  // Utilities
  private paraDetector: ParaDetector;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel,
  ) {
    super(leaf);
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getDisplayText(): string {
    return "Notient";
  }

  getIcon(): string {
    return "sparkles";
  }

  // ============ Lifecycle ============

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notient-sidebar--v2");
    this.containerEl_ = container;

    this.render();
    this.registerEvents();
    await this.refreshNoteVitals();
  }

  async onClose(): Promise<void> {
    this.cancelStreaming();
    this.chatHistory = [];
    this._lastSearchResults = [];
  }

  // ============ Service Getters ============

  private getSearchPipeline(): SearchPipeline | null {
    return this.kernel.getService<SearchPipeline>("search");
  }

  private getLLMProvider(): LLMProvider | null {
    return this.kernel.getService<LLMProvider>("llmProvider");
  }

  private getContextBuilder(): VaultContextBuilder | null {
    return this.kernel.getService<VaultContextBuilder>("context");
  }

  private getWorkflowRunner(): WorkflowRunner | null {
    return this.kernel.getService<WorkflowRunner>("workflowRunner");
  }

  // ============ Main Render ============

  private render(): void {
    if (!this.containerEl_) return;
    this.containerEl_.empty();

    // Header (clickable to toggle view)
    this.renderHeader();

    // Content area
    this.contentEl_ = this.containerEl_.createDiv({ cls: "nv2-content" });

    if (this.currentView === "note") {
      this.renderNoteVitalsView();
    } else {
      this.renderAgentStreamsView();
    }

    // Footer
    this.renderFooter();
  }

  // ============ Header ============

  private renderHeader(): void {
    if (!this.containerEl_) return;

    const header = this.containerEl_.createDiv({ cls: "nv2-header" });

    // Main title with accent styling
    const title = header.createDiv({ cls: "nv2-header-title" });
    if (this.currentView === "note") {
      title.createSpan({ cls: "nv2-accent", text: "Notient" });
      title.createSpan({ text: " Vitals" });
    } else {
      title.createSpan({ cls: "nv2-accent", text: "Notient" });
      title.createSpan({ text: " Agent Streams" });
    }

    // Subtitle
    header.createDiv({
      cls: "nv2-header-subtitle",
      text: this.currentView === "note" ? "Note Dashboard" : "Agent Dashboard",
    });

    // Click header to toggle view
    header.addEventListener("click", () => {
      this.currentView = this.currentView === "note" ? "agents" : "note";
      this.render();
    });
  }

  // ============ Note Vitals View ============

  private renderNoteVitalsView(): void {
    if (!this.contentEl_) return;

    // Note Context Card (if note is open)
    if (this.noteVitals) {
      this.renderNoteCard();
    }

    // Quick Actions section
    this.renderQuickActionsSection();

    // Search Bar
    this.renderSearchSection();

    // Search results (hidden by default)
    this.searchResultsEl = this.contentEl_.createDiv({
      cls: "nv2-search-results nv2-hidden",
    });

    // Insight Stream section
    this.renderInsightStream();
  }

  private renderNoteCard(): void {
    if (!this.contentEl_ || !this.noteVitals) return;

    const card = this.contentEl_.createDiv({ cls: "nv2-note-card" });

    // Title
    card.createDiv({
      cls: "nv2-note-card-title",
      text: this.noteVitals.title,
    });

    // Tags
    const tags = this.noteVitals.tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
    if (tags.length > 0) {
      const tagsRow = card.createDiv({ cls: "nv2-note-card-tags" });
      for (const tag of tags.slice(0, 5)) {
        tagsRow.createDiv({ cls: "nv2-tag", text: `#${tag}` });
      }
      if (tags.length > 5) {
        tagsRow.createDiv({ cls: "nv2-tag", text: `+${tags.length - 5}` });
      }
    }

    // Links section
    const links = card.createDiv({ cls: "nv2-note-card-links" });

    // Backlinks row
    const backlinksRow = links.createDiv({ cls: "nv2-link-row" });
    const blIcon = backlinksRow.createDiv({ cls: "nv2-link-row-icon" });
    setIcon(blIcon, "link");
    const blContent = backlinksRow.createDiv({ cls: "nv2-link-row-content" });
    blContent.createDiv({
      cls: "nv2-link-row-label",
      text: `${this.noteVitals.links.backlinks} backlink${this.noteVitals.links.backlinks !== 1 ? "s" : ""}`,
    });
    if (this.noteVitals.links.backlinks > 0) {
      blContent.createDiv({
        cls: "nv2-link-row-preview",
        text: this.getBacklinkPreview(),
      });
    }

    // Outlinks row
    const outlinksRow = links.createDiv({ cls: "nv2-link-row" });
    const olIcon = outlinksRow.createDiv({ cls: "nv2-link-row-icon" });
    setIcon(olIcon, "arrow-right");
    const olContent = outlinksRow.createDiv({ cls: "nv2-link-row-content" });
    olContent.createDiv({
      cls: "nv2-link-row-label",
      text: `${this.noteVitals.links.outlinks} outlinks`,
    });
  }

  private getBacklinkPreview(): string {
    // Get first backlink title as preview
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return "";

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[activeFile.path]) {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (sourceFile && sourceFile instanceof TFile) {
          return `${sourceFile.basename}...`;
        }
      }
    }
    return "";
  }

  private renderQuickActionsSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Quick Actions" });

    const actions = section.createDiv({ cls: "nv2-quick-actions" });

    // Enrich action (primary)
    const enrichBtn = actions.createDiv({ cls: "nv2-quick-action nv2-quick-action--primary" });
    const enrichIcon = enrichBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(enrichIcon, "sparkles");
    enrichBtn.createDiv({ cls: "nv2-quick-action-label", text: "Enrich" });
    enrichBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(
        `Enrich and expand "${noteTitle}" with additional context and insights`,
      );
    });

    // Link action
    const linkBtn = actions.createDiv({ cls: "nv2-quick-action" });
    const linkIcon = linkBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(linkIcon, "link");
    linkBtn.createDiv({ cls: "nv2-quick-action-label", text: "Link" });
    linkBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(`Find notes that should be linked to "${noteTitle}"`);
    });

    // Move action
    const moveBtn = actions.createDiv({ cls: "nv2-quick-action" });
    const moveIcon = moveBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(moveIcon, "arrow-right-circle");
    moveBtn.createDiv({ cls: "nv2-quick-action-label", text: "Move" });
    moveBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(
        `Suggest the best folder/category for "${noteTitle}" based on its content`,
      );
    });
  }

  private renderSearchSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-search-section" });
    const wrapper = section.createDiv({ cls: "nv2-search-wrapper" });

    const icon = wrapper.createDiv({ cls: "nv2-search-icon" });
    setIcon(icon, "search");

    this.omnibarInputEl = wrapper.createEl("input", {
      type: "text",
      placeholder: "Search or /command...",
      cls: "nv2-search-input notient-search-input",
    });

    const debouncedSearch = debounce(
      async (query: string) => {
        // Don't search for slash commands
        if (isSlashCommand(query)) {
          this.clearSearchResults();
          return;
        }
        if (query.length >= 2) {
          await this.performSearch(query);
        } else {
          this.clearSearchResults();
        }
      },
      300,
      true,
    );

    this.omnibarInputEl.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value;
      debouncedSearch(query);
    });

    this.omnibarInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.omnibarInputEl) this.omnibarInputEl.value = "";
        this.clearSearchResults();
      } else if (e.key === "Enter") {
        const query = this.omnibarInputEl?.value.trim() || "";
        if (isSlashCommand(query)) {
          e.preventDefault();
          void this.handleSlashCommand(query);
        }
      }
    });
  }

  /**
   * Handle slash command execution
   */
  private async handleSlashCommand(input: string): Promise<void> {
    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) {
      new Notice("Workflow system not available. Services may still be initializing.");
      return;
    }

    // Parse the command
    const result = parseSlashCommand(input, this.kernel.obsidian);

    if (!result.success) {
      new Notice(`Command error: ${result.error.message}`);
      return;
    }

    const parsed = result.parsed;

    // Start the workflow
    const startResult = await workflowRunner.startFromCommand(parsed);

    if (!startResult.success) {
      new Notice(`Workflow error: ${startResult.error}`);
      return;
    }

    // Clear input and show success
    if (this.omnibarInputEl) {
      this.omnibarInputEl.value = "";
    }
    this.clearSearchResults();

    const scopeText = parsed.scope === "vault" ? "entire vault" : `folder "${parsed.target}"`;
    new Notice(
      `Started ${parsed.command} workflow on ${scopeText} (${startResult.noteCount} notes)`,
    );

    // Switch to agents view to show progress
    this.currentView = "agents";
    this.render();
  }

  private renderInsightStream(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Insight Stream" });

    const stream = section.createDiv({ cls: "nv2-insight-stream" });

    // Generate insights based on note vitals (if available)
    const insights = this.generateInsights();

    if (insights.length === 0) {
      const empty = stream.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "Open a note to see insights.",
      });
      return;
    }

    for (const insight of insights) {
      const item = stream.createDiv({ cls: "nv2-insight" });
      item.createDiv({
        cls: `nv2-insight-dot ${insight.priority === "low" ? "nv2-insight-dot--secondary" : ""}`,
      });

      const content = item.createDiv({ cls: "nv2-insight-content" });

      // Parse text for links
      const textEl = content.createDiv({ cls: "nv2-insight-text" });
      if (insight.linkText) {
        const parts = insight.text.split(insight.linkText);
        textEl.createSpan({ text: parts[0] });
        const link = textEl.createEl("a", { text: insight.linkText });
        link.addEventListener("click", () => {
          if (insight.linkPath) this.openFile(insight.linkPath);
        });
        if (parts[1]) textEl.createSpan({ text: parts[1] });
      } else {
        textEl.setText(insight.text);
      }

      // Action button
      if (insight.action) {
        const actionBtn = content.createDiv({
          cls: `nv2-insight-action ${insight.actionPrimary ? "nv2-insight-action--primary" : ""}`,
        });
        if (insight.actionIcon) {
          const actionIcon = actionBtn.createSpan({ cls: "nv2-insight-action-icon" });
          setIcon(actionIcon, insight.actionIcon);
        }
        actionBtn.createSpan({ text: insight.action });
        actionBtn.addEventListener("click", () => {
          if (insight.actionCallback) insight.actionCallback();
        });
      }
    }
  }

  private generateInsights(): Array<{
    text: string;
    linkText?: string;
    linkPath?: string;
    action?: string;
    actionIcon?: string;
    actionPrimary?: boolean;
    actionCallback?: () => void;
    priority: "high" | "low";
  }> {
    if (!this.noteVitals) return [];

    const insights: Array<{
      text: string;
      linkText?: string;
      linkPath?: string;
      action?: string;
      actionIcon?: string;
      actionPrimary?: boolean;
      actionCallback?: () => void;
      priority: "high" | "low";
    }> = [];

    // Insight about connections
    if (this.noteVitals.links.backlinks === 0 && this.noteVitals.links.outlinks === 0) {
      insights.push({
        text: "This note has no connections. Consider linking it to related notes.",
        action: "Find Connections",
        actionIcon: "eye",
        actionCallback: () => {
          this.prefillChatAndSwitch(
            `Find notes that could be linked to "${this.noteVitals?.title}"`,
          );
        },
        priority: "high",
      });
    } else if (this.noteVitals.links.backlinks > 0) {
      insights.push({
        text: `This note appears strongly related to other notes via ${this.noteVitals.links.backlinks} backlink${this.noteVitals.links.backlinks > 1 ? "s" : ""}.`,
        action: "Review Links",
        actionIcon: "eye",
        actionCallback: () => this.onMetricClick("links"),
        priority: "high",
      });
    }

    // Classification insight
    if (this.noteVitals.paraType === "inbox" || this.noteVitals.paraType === "unknown") {
      insights.push({
        text: `Suggested classification update: Move from #${this.noteVitals.paraType} to #active-projects based on recent edits.`,
        action: "Apply Change",
        actionIcon: "check",
        actionPrimary: true,
        actionCallback: () => {
          this.prefillChatAndSwitch(
            `Suggest the best PARA category for "${this.noteVitals?.title}" and help me organize it`,
          );
        },
        priority: "low",
      });
    }

    // Index status insight
    if (!this.noteVitals.isIndexed) {
      insights.push({
        text: "This note is not yet indexed for semantic search.",
        action: "Index Now",
        actionIcon: "database",
        actionCallback: () => {
          new Notice("Indexing will happen on next sync");
        },
        priority: "low",
      });
    }

    return insights;
  }

  // ============ Agent Streams View ============

  private renderAgentStreamsView(): void {
    if (!this.contentEl_) return;

    // Status bar
    this.renderAgentStatusBar();

    // Active Workflow (if any)
    this.renderActiveWorkflow();

    // Agent Dashboard (service status cards)
    this.renderAgentDashboardSection();

    // Agent Activity Log
    this.renderAgentActivityLog();
  }

  /**
   * Render the active workflow card (if any)
   */
  private renderActiveWorkflow(): void {
    if (!this.contentEl_) return;

    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) return;

    const currentWorkflow = workflowRunner.getCurrentWorkflow();
    const queuedWorkflows = workflowRunner.getQueuedWorkflows();

    if (!currentWorkflow && queuedWorkflows.length === 0) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Active Workflows" });

    const container = section.createDiv({ cls: "nv2-workflow-container" });

    // Render current workflow
    if (currentWorkflow) {
      this.renderWorkflowCard(container, currentWorkflow, true);
    }

    // Render queued workflows
    for (const workflow of queuedWorkflows) {
      this.renderWorkflowCard(container, workflow, false);
    }
  }

  /**
   * Render a single workflow card
   */
  private renderWorkflowCard(
    container: HTMLElement,
    workflow: WorkflowRun,
    isActive: boolean,
  ): void {
    const card = container.createDiv({
      cls: `nv2-workflow-card ${isActive ? "nv2-workflow-card--active" : ""}`,
    });

    // Header with command name and scope
    const header = card.createDiv({ cls: "nv2-workflow-header" });
    const titleEl = header.createDiv({ cls: "nv2-workflow-title" });

    const iconEl = titleEl.createSpan({ cls: "nv2-workflow-icon" });
    setIcon(iconEl, this.getWorkflowIcon(workflow.spec.command));

    titleEl.createSpan({
      text: `/${workflow.spec.command}`,
      cls: "nv2-workflow-command",
    });

    const scopeText =
      workflow.spec.scope === "vault"
        ? "vault"
        : workflow.spec.targets.length === 1
          ? workflow.spec.targets[0].split("/").pop() || "note"
          : `${workflow.spec.targets.length} notes`;
    titleEl.createSpan({
      text: ` on ${scopeText}`,
      cls: "nv2-workflow-scope",
    });

    // Status badge
    const statusBadge = header.createDiv({
      cls: `nv2-workflow-status nv2-workflow-status--${workflow.status}`,
      text: workflow.status,
    });

    // Progress section (only for running workflows)
    if (workflow.status === "running") {
      const progressContainer = card.createDiv({ cls: "nv2-workflow-progress-container" });

      const progressBar = progressContainer.createDiv({ cls: "nv2-workflow-progress" });
      const percent =
        workflow.progress.total > 0
          ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
          : 0;
      progressBar.createDiv({
        cls: "nv2-workflow-progress-fill",
        attr: { style: `width: ${percent}%` },
      });

      const progressText = progressContainer.createDiv({ cls: "nv2-workflow-progress-text" });
      progressText.setText(
        `${workflow.progress.completed}/${workflow.progress.total} complete${workflow.progress.failed > 0 ? ` (${workflow.progress.failed} failed)` : ""}`,
      );
    }

    // Actions
    const actions = card.createDiv({ cls: "nv2-workflow-actions" });

    if (workflow.status === "running" || workflow.status === "queued") {
      const cancelBtn = actions.createEl("button", {
        cls: "nv2-workflow-btn nv2-workflow-btn--cancel",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const workflowRunner = this.getWorkflowRunner();
        if (workflowRunner) {
          workflowRunner.cancel(workflow.id);
          new Notice("Workflow cancelled");
          this.render();
        }
      });
    }

    // Review queue indicator
    if (workflow.reviewQueue.length > 0) {
      const reviewBadge = actions.createDiv({
        cls: "nv2-workflow-review-badge",
        text: `${workflow.reviewQueue.length} pending review`,
      });
      reviewBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        new Notice("Review queue: Open Dashboard to review pending actions");
      });
    }
  }

  /**
   * Get icon for workflow command
   */
  private getWorkflowIcon(command: string): string {
    switch (command) {
      case "enrich":
        return "sparkles";
      case "classify":
        return "folder-tree";
      case "link":
        return "link";
      default:
        return "play";
    }
  }

  private renderAgentStatusBar(): void {
    if (!this.contentEl_) return;

    const statusBar = this.contentEl_.createDiv({ cls: "nv2-status-bar" });

    const left = statusBar.createDiv({ cls: "nv2-status-bar-left" });
    left.createDiv({
      cls: `nv2-status-dot ${this.isStreaming ? "nv2-status-dot--running" : "nv2-status-dot--idle"}`,
    });
    left.createSpan({
      cls: "nv2-status-bar-text",
      text: this.isStreaming ? "Agent working..." : "All agents idle",
    });

    const settingsBtn = statusBar.createEl("button", {
      cls: "nv2-status-bar-btn",
      attr: { "aria-label": "Agent settings" },
    });
    setIcon(settingsBtn, "sliders");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      (
        this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
      ).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        "notient",
      );
    });
  }

  private renderAgentDashboardSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Agent Dashboard" });

    const dashboard = section.createDiv({ cls: "nv2-agent-dashboard" });
    const grid = dashboard.createDiv({ cls: "nv2-agent-dashboard-grid" });

    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    const tasks = taskQueue?.getAll() || [];

    // Helper to get status
    const getStatus = (type: AgentType) => {
      const isRunning = tasks.some((t) => t.agent === type && t.status === "running");
      if (isRunning) return "working";

      switch (type) {
        case "search":
          return this.kernel.capabilities.search ? "ready" : "offline";
        case "context":
          return this.kernel.capabilities.search ? "idle" : "offline"; // Context depends on search
        case "chat":
          return this.kernel.capabilities.reasoning ? "idle" : "offline";
      }
    };

    const renderCard = (type: AgentType, name: string, icon: string) => {
      const status = getStatus(type);
      const card = grid.createDiv({ cls: "nv2-agent-dashboard-card" });
      const iconEl = card.createDiv({ cls: "nv2-agent-dashboard-card-icon" });
      setIcon(iconEl, icon);

      card.createDiv({ cls: "nv2-agent-dashboard-card-name", text: name });

      const statusEl = card.createDiv({
        cls: "nv2-agent-dashboard-card-status",
        text: status,
      });

      if (status === "working") {
        statusEl.addClass("nv2-status-pulsing");
      } else if (status === "ready" || status === "idle") {
        statusEl.addClass("nv2-agent-dashboard-card-status--active");
      }
    };

    renderCard("search", "Semantic Search", "search");
    renderCard("context", "Context Builder", "braces");
    renderCard("chat", "Chat Assistant", "message-square");
  }

  private renderAgentActivityLog(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-activity-log" });
    section.createDiv({ cls: "nv2-activity-log-title", text: "Agent Activity Log" });

    const list = section.createDiv({ cls: "nv2-activity-log-list" });

    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    const tasks = taskQueue?.getAll() || [];

    // Sort by startedAt desc
    const sortedTasks = [...tasks].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (sortedTasks.length === 0) {
      const empty = list.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "No recent agent activity. Use Quick Actions or Search to start a task.",
      });
      return;
    }

    for (const task of sortedTasks) {
      const item = list.createDiv({
        cls: `nv2-activity-item nv2-task-card nv2-task-${task.status}`,
      });
      // Click to open modal
      item.addEventListener("click", () => {
        new TaskModal(this.app, this.kernel, task).open();
      });

      const header = item.createDiv({ cls: "nv2-activity-header" });
      const agent = header.createDiv({ cls: "nv2-activity-agent" });
      const agentIcon = agent.createDiv({ cls: "nv2-activity-agent-icon" });

      let icon = "bot";
      switch (task.agent) {
        case "search":
          icon = "search";
          break;
        case "context":
          icon = "file-search";
          break;
        case "chat":
          icon = "message-square";
          break;
      }
      setIcon(agentIcon, icon);

      agent.createDiv({ cls: "nv2-activity-agent-name", text: this.getAgentName(task.agent) });
      header.createDiv({ cls: "nv2-activity-time", text: this.formatActivityTime(task.startedAt) });

      const body = item.createDiv({ cls: "nv2-activity-body" });
      body.createDiv({ cls: "nv2-task-note", text: task.noteTitle });

      if (task.status === "running") {
        const progress = item.createDiv({ cls: "nv2-task-progress" });
        progress.createDiv({
          cls: "nv2-task-progress-bar",
          attr: { style: `width: ${task.progress || 0}%` },
        });
      }

      item.createDiv({
        cls: `nv2-task-status-foot nv2-status-${task.status}`,
        text: task.status,
      });
    }
  }

  private getAgentName(type: AgentType): string {
    switch (type) {
      case "search":
        return "Agent Search";
      case "context":
        return "Context Agent";
      case "chat":
        return "Chat Assistant";
      default:
        return "Agent";
    }
  }

  private formatActivityTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) {
      const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `Today, ${time}`;
    }
    return `Yesterday, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  // Note: Chat functionality is still available but UI is simplified for Agent Streams view
  // Chat messages are shown in the activity log format instead of full chat bubbles

  // ============ Footer ============

  private renderFooter(): void {
    if (!this.containerEl_) return;

    const footer = this.containerEl_.createDiv({ cls: "nv2-footer" });

    // Progress Bar (hidden by default)
    this.footerProgressEl = footer.createDiv({ cls: "nv2-index-progress nv2-hidden" });

    // Status Row
    const status = footer.createDiv({ cls: "nv2-footer-status" });

    const health = this.kernel.serviceHealth;

    // Ollama status
    const ollamaEl = status.createDiv({ cls: "nv2-footer-service" });
    ollamaEl.createSpan({ text: "Ollama: " });
    ollamaEl.createSpan({
      cls: `nv2-footer-service-status ${this.getFooterStatusClass(health.ollama.status)}`,
      text: this.getStatusText(health.ollama.status),
    });

    // LM Studio status
    const lmEl = status.createDiv({ cls: "nv2-footer-service" });
    lmEl.createSpan({ text: "LM Studio: " });
    lmEl.createSpan({
      cls: `nv2-footer-service-status ${this.getFooterStatusClass(health.lmstudio.status)}`,
      text: this.getStatusText(health.lmstudio.status),
    });

    // Stats (Note count)
    this.footerStatsEl = status.createDiv({ cls: "nv2-footer-stats" });
    this.updateFooterStats();

    // Settings button
    const settingsBtn = footer.createEl("button", { cls: "nv2-footer-settings" });
    settingsBtn.setAttr("aria-label", "Open Notient settings");
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      (
        this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
      ).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        "notient",
      );
    });
  }

  private updateFooterStats(): void {
    if (!this.footerStatsEl) return;

    const indexManager = this.kernel.getService<{ getIndexedCount(): number }>("indexManager");
    if (indexManager) {
      const count = indexManager.getIndexedCount();
      let text = `${count} notes`;

      if (this.lastSyncTime) {
        const time = this.lastSyncTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        text += ` • Synced ${time}`;
      }

      this.footerStatsEl.setText(text);
      this.footerStatsEl.setAttr("title", "Indexed notes count");
    }
  }

  private updateIndexProgress(progress: IndexProgress): void {
    if (!this.footerProgressEl) return;

    if (progress.phase === "idle" || progress.phase === "complete") {
      this.footerProgressEl.addClass("nv2-hidden");

      // Update stats when complete
      if (progress.phase === "complete") {
        this.updateFooterStats();
      }
      return;
    }

    this.footerProgressEl.removeClass("nv2-hidden");
    this.footerProgressEl.empty();

    // Progress bar
    const bar = this.footerProgressEl.createDiv({ cls: "nv2-progress-bar" });
    const percent =
      progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

    bar.createDiv({
      cls: "nv2-progress-fill",
      attr: { style: `width: ${percent}%` },
    });

    // Text status
    let text = "";
    switch (progress.phase) {
      case "scanning":
        text = "Scanning vault...";
        break;
      case "chunking":
      case "embedding":
      case "storing":
        text = `Indexing: ${progress.completed}/${progress.total} (${percent}%)`;
        break;
      default:
        text = "Processing...";
    }

    this.footerProgressEl.createDiv({ cls: "nv2-progress-text", text });
  }

  private getFooterStatusClass(status: string): string {
    switch (status) {
      case "healthy":
        return ""; // Default green
      case "unhealthy":
        return "nv2-footer-service-status--error";
      case "checking":
        return "nv2-footer-service-status--warning";
      default:
        return "nv2-footer-service-status--error";
    }
  }

  private getStatusText(status: string): string {
    switch (status) {
      case "healthy":
        return "Healthy";
      case "unhealthy":
        return "Offline";
      case "checking":
        return "Checking...";
      default:
        return "Unknown";
    }
  }

  // ============ Note Vitals ============

  private async refreshNoteVitals(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile || activeFile.extension !== "md") {
      this.noteVitals = null;
      if (this.currentView === "note") {
        this.render();
      }
      return;
    }

    const metadata = this.app.metadataCache.getFileCache(activeFile);

    // Calculate health score (heuristic based on various factors)
    const healthScore = this.calculateHealthScore(activeFile, metadata);

    // Get backlinks
    const backlinks: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[activeFile.path]) {
        backlinks.push(sourcePath);
      }
    }

    // Get outlinks
    const outlinks: string[] = [];
    const fileLinks = resolvedLinks[activeFile.path] || {};
    for (const targetPath of Object.keys(fileLinks)) {
      outlinks.push(targetPath);
    }

    // Extract tags
    const tags = metadata?.tags?.map((t) => t.tag) || [];
    const frontmatterTags = (metadata?.frontmatter?.tags as string[]) || [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    // Freshness
    const mtime = activeFile.stat.mtime;
    const freshness = this.formatFreshness(mtime);

    // Check if indexed
    const indexManager = this.kernel.getService<{
      isNoteIndexed(path: string): boolean;
    }>("indexManager");
    const isIndexed = indexManager?.isNoteIndexed(activeFile.path) ?? false;

    this.noteVitals = {
      health: {
        score: healthScore,
        status: healthScore >= 70 ? "healthy" : healthScore >= 40 ? "attention" : "unhealthy",
      },
      links: {
        backlinks: backlinks.length,
        outlinks: outlinks.length,
      },
      freshness: {
        lastModified: new Date(mtime),
        displayText: freshness,
      },
      title: activeFile.basename,
      path: activeFile.path,
      paraType: this.paraDetector.detectType(activeFile.path),
      tags: allTags,
      isIndexed,
    };

    if (this.currentView === "note") {
      this.render();
    }
  }

  private calculateHealthScore(
    file: TFile,
    metadata: ReturnType<typeof this.app.metadataCache.getFileCache>,
  ): number {
    let score = 50; // Base score

    // Freshness factor (up to +20)
    const daysSinceModified = Math.floor((Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24));
    if (daysSinceModified <= 7) score += 20;
    else if (daysSinceModified <= 30) score += 10;
    else if (daysSinceModified > 90) score -= 10;

    // Tags factor (up to +10)
    const tagCount =
      (metadata?.tags?.length || 0) + ((metadata?.frontmatter?.tags as string[])?.length || 0);
    if (tagCount >= 3) score += 10;
    else if (tagCount >= 1) score += 5;

    // Links factor (up to +20)
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const outlinks = Object.keys(resolvedLinks[file.path] || {}).length;
    let backlinks = 0;
    for (const [, links] of Object.entries(resolvedLinks)) {
      if (links[file.path]) backlinks++;
    }

    if (backlinks >= 5) score += 10;
    else if (backlinks >= 1) score += 5;

    if (outlinks >= 5) score += 10;
    else if (outlinks >= 1) score += 5;

    // Indexed factor
    const indexManager = this.kernel.getService<{
      isNoteIndexed(path: string): boolean;
    }>("indexManager");
    if (indexManager?.isNoteIndexed(file.path)) {
      score += 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private formatFreshness(mtime: number): string {
    const now = Date.now();
    const diff = now - mtime;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        return "Just now";
      }
      return `${hours}h ago`;
    }
    if (days === 1) {
      return "Yesterday";
    }
    if (days < 7) {
      return `${days} days ago`;
    }
    if (days < 30) {
      const weeks = Math.floor(days / 7);
      return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    }
    const date = new Date(mtime);
    return date.toLocaleDateString();
  }

  // ============ Search ============

  private async performSearch(query: string): Promise<void> {
    const searchPipeline = this.getSearchPipeline();
    if (!searchPipeline || !this.kernel.capabilities.search) {
      this.showSearchError("Search unavailable");
      return;
    }

    this.showSearchLoading();

    try {
      const results = await searchPipeline.search(query, {
        topK: 8,
        enableReranking: this.getLLMProvider()?.isReady ?? false,
      });
      this._lastSearchResults = results;
      this.renderSearchResults(results);
    } catch (error) {
      console.error("[Sidebar] Search error:", error);
      this.showSearchError("Search failed");
    }
  }

  private renderSearchResults(results: SearchResult[]): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    if (results.length === 0) {
      const empty = this.searchResultsEl.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({ cls: "nv2-empty-state-icon", text: "🔍" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "No matches found",
      });
      return;
    }

    for (const result of results) {
      const item = this.searchResultsEl.createDiv({ cls: "nv2-search-result" });

      const header = item.createDiv({ cls: "nv2-search-result-header" });
      header.createSpan({
        cls: "nv2-search-result-title",
        text: result.title,
      });
      header.createSpan({
        cls: "nv2-search-result-score",
        text: `${Math.round(result.bestScore * 100)}%`,
      });

      item.createDiv({
        cls: "nv2-search-result-path",
        text: result.path,
      });

      if (result.chunks.length > 0 && result.chunks[0].text) {
        const preview = result.chunks[0].text;
        item.createDiv({
          cls: "nv2-search-result-preview",
          text: preview.length > 150 ? `${preview.slice(0, 150)}...` : preview,
        });
      }

      item.addEventListener("click", () => this.openFile(result.path));
    }
  }

  private showSearchLoading(): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const loading = this.searchResultsEl.createDiv({ cls: "nv2-loading" });
    loading.createDiv({ cls: "nv2-loading-spinner" });
    loading.createSpan({ text: "Thinking..." });
  }

  private showSearchError(message: string): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const empty = this.searchResultsEl.createDiv({ cls: "nv2-empty-state" });
    empty.createDiv({ cls: "nv2-empty-state-text", text: message });
  }

  private clearSearchResults(): void {
    if (this.searchResultsEl) {
      this.searchResultsEl.empty();
      this.searchResultsEl.addClass("nv2-hidden");
    }
    this._lastSearchResults = [];
  }

  // ============ Chat / AI Actions ============

  /**
   * @deprecated Use prefillChatAndSwitch() instead which routes through the agent task queue.
   * This method is kept for backward compatibility but is not used in the current flow.
   */
  private async _sendQuery(query: string): Promise<void> {
    const llmProvider = this.getLLMProvider();
    if (!llmProvider?.isReady) {
      new Notice("AI unavailable - LM Studio not connected");
      return;
    }

    // Add user message to history
    const userMessage: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };
    this.chatHistory.push(userMessage);

    // Start streaming
    this.isStreaming = true;
    this.streamingContent = "";
    this.activeAbortController = new AbortController();

    this.render();

    try {
      // Search for context
      const searchPipeline = this.getSearchPipeline();
      let searchResults: SearchResult[] = [];

      if (searchPipeline) {
        try {
          searchResults = await searchPipeline.search(query, {
            topK: 5,
            enableReranking: true,
          });
        } catch (error) {
          console.warn("[Sidebar] Context search failed:", error);
        }
      }

      // Build context
      const contextBuilder = this.getContextBuilder();
      const context = contextBuilder?.buildForQuery(query, searchResults);

      // Build simple messages (prompt building is now in NotientAgent)
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `You are Notient, an AI assistant for an Obsidian vault.\n\nContext: ${context?.contextSummary || "No context available."}`,
        },
        ...this.chatHistory.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      // Stream response using new LLM provider
      for await (const chunk of llmProvider.stream(
        messages,
        undefined,
        this.activeAbortController.signal,
      )) {
        if (this.activeAbortController.signal.aborted) break;
        this.streamingContent += chunk;
        this.render();
      }

      // Finalize
      if (!this.activeAbortController.signal.aborted) {
        const assistantMessage: ExtendedChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: this.streamingContent,
          attachments: searchResults.slice(0, 3).map((r) => ({
            id: crypto.randomUUID(),
            type: "rag-citation" as const,
            filename: r.title,
            path: r.path,
          })),
          timestamp: new Date(),
        };
        this.chatHistory.push(assistantMessage);

        // Show result in notice
        const preview = this.streamingContent.slice(0, 100);
        new Notice(`AI Response: ${preview}${this.streamingContent.length > 100 ? "..." : ""}`);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("[Sidebar] AI query error:", error);
        new Notice("AI query failed. Try again?");
      }
    } finally {
      this.isStreaming = false;
      this.streamingContent = "";
      this.activeAbortController = null;
      this.render();
    }
  }

  private cancelStreaming(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
  }

  /**
   * Switch to agents view and start a query
   */
  private prefillChatAndSwitch(prompt: string): void {
    this.currentView = "agents";

    // Enqueue task
    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    if (taskQueue) {
      taskQueue.enqueue({
        agent: "chat",
        notePath: this.noteVitals?.path || "unknown",
        noteTitle: this.noteVitals?.title || "Unknown Note",
        chatHistory: [{ role: "user", content: prompt }],
      });
    }

    this.render();
  }

  // ============ Events ============

  private registerEvents(): void {
    // Active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.refreshNoteVitals();
      }),
    );

    // File modifications
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.noteVitals?.path === file.path) {
          await this.refreshNoteVitals();
        }
      }),
    );

    // Health changes
    const unsubHealth = this.kernel.eventBus.on("health:changed", () => {
      this.render();
    });
    this.register(() => unsubHealth());

    // Services initialized
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.render();
      this.updateFooterStats();
    });
    this.register(() => unsubServices());

    // Agent Task Updates
    const unsubTask = this.kernel.eventBus.on("agent:task-update", () => {
      if (this.currentView === "agents") {
        this.render(); // Re-render to show progress/status
      }
    });
    this.register(() => unsubTask());

    // Index Progress
    const unsubProgress = this.kernel.eventBus.on(
      "index:progress",
      (payload: { progress: IndexProgress }) => {
        this.updateIndexProgress(payload.progress);
      },
    );
    this.register(() => unsubProgress());

    // Index Complete
    const unsubIndexComplete = this.kernel.eventBus.on("index:complete", () => {
      this.lastSyncTime = new Date();
      this.updateFooterStats();
    });
    this.register(() => unsubIndexComplete());

    // Workflow events (Milestone 2.4)
    const unsubWorkflowStarted = this.kernel.eventBus.on("workflow:started", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowStarted());

    const unsubWorkflowProgress = this.kernel.eventBus.on("workflow:progress", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowProgress());

    const unsubWorkflowCompleted = this.kernel.eventBus.on("workflow:completed", (event) => {
      const { workflow } = event;
      new Notice(
        `Workflow complete: ${workflow.progress.completed}/${workflow.progress.total} notes processed${workflow.progress.failed > 0 ? ` (${workflow.progress.failed} failed)` : ""}`,
      );
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowCompleted());

    const unsubWorkflowCancelled = this.kernel.eventBus.on("workflow:cancelled", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowCancelled());

    const unsubWorkflowFailed = this.kernel.eventBus.on("workflow:failed", (event) => {
      new Notice(`Workflow failed: ${event.error}`);
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowFailed());
  }

  // ============ Metric Actions ============

  private onMetricClick(metric: "health" | "links" | "freshness"): void {
    if (!this.noteVitals) {
      new Notice("Open a note to see its vitals");
      return;
    }

    switch (metric) {
      case "health":
        this.prefillChatAndSwitch(
          `Analyze the health of my note "${this.noteVitals.title}" and suggest improvements`,
        );
        break;
      case "links":
        this.prefillChatAndSwitch(
          `Show me all the connections for "${this.noteVitals.title}" and suggest new links`,
        );
        break;
      case "freshness":
        this.prefillChatAndSwitch(
          `What has changed in "${this.noteVitals.title}" and what should I review?`,
        );
        break;
    }
  }

  // ============ Utilities ============

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }
}
