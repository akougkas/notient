/**
 * Notient Dashboard View
 *
 * Full-screen vault vitals dashboard with tabs:
 * - Vitals: Vault health metrics
 * - Agent Actions: Workflow status, review queue, action history
 * - Index Management: Indexing controls
 */

import { ItemView, Notice, type WorkspaceLeaf, setIcon } from "obsidian";
import type { ActionHistory } from "../core/agentic/actionHistory";
import type { ActionApplier } from "../core/agentic/actionApplier";
import type { AppliedActionRecord, ProposedAction, WorkflowRun } from "../core/agentic/types";
import type { WorkflowRunner } from "../core/agentic/workflowRunner";
import { VIEW_TYPE_DASHBOARD } from "../core/constants";
import type { Kernel } from "../core/kernel";
import type { HealthScore, VaultVitalsData } from "../types/vitals";

type DashboardTab = "vitals" | "actions" | "index";

/** Common interface for vitals implementations */
export interface VitalsProvider {
  compute(): Promise<VaultVitalsData>;
  getCached(): VaultVitalsData | null;
  calculateHealthScore(vitals: VaultVitalsData): HealthScore;
}

/** Debounce delay in milliseconds for rapid re-renders */
const RENDER_DEBOUNCE_MS = 150;

export class NotientDashboardView extends ItemView {
  private currentTab: DashboardTab = "vitals";
  private containerEl_: HTMLElement | null = null;
  private contentEl_: HTMLElement | null = null;
  private vitalsContainer: HTMLElement | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private renderDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel,
  ) {
    super(leaf);
  }

  /**
   * Debounced render to prevent UI jank during rapid updates
   */
  private debouncedRender(): void {
    if (this.renderDebounceTimeout) {
      clearTimeout(this.renderDebounceTimeout);
    }
    this.renderDebounceTimeout = setTimeout(() => {
      this.renderDebounceTimeout = null;
      this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  /**
   * Get vault vitals service dynamically from kernel (lazy resolution)
   */
  private getVaultVitals(): VitalsProvider | null {
    return this.kernel.getService<VitalsProvider>("vitals");
  }

  private getWorkflowRunner(): WorkflowRunner | null {
    return this.kernel.getService<WorkflowRunner>("workflowRunner");
  }

  private getActionHistory(): ActionHistory | null {
    return this.kernel.getService<ActionHistory>("actionHistory");
  }

  private getActionApplier(): ActionApplier | null {
    return this.kernel.getService<ActionApplier>("actionApplier");
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return "Vault Vitals";
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notient-dashboard");
    this.containerEl_ = container;

    this.render();
    this.registerEvents();
  }

  private render(): void {
    if (!this.containerEl_) return;
    this.containerEl_.empty();

    // Header with tabs
    this.renderHeader();

    // Content area
    this.contentEl_ = this.containerEl_.createDiv({ cls: "notient-dashboard-content" });

    // Render current tab
    switch (this.currentTab) {
      case "vitals":
        this.renderVitalsTab();
        break;
      case "actions":
        this.renderActionsTab();
        break;
      case "index":
        this.renderIndexTab();
        break;
    }
  }

  private renderHeader(): void {
    if (!this.containerEl_) return;

    const header = this.containerEl_.createDiv({ cls: "notient-dashboard-header" });

    // Title
    header.createEl("h1", { text: "Notient Command Center" });

    // Tab bar
    const tabBar = header.createDiv({ cls: "notient-tab-bar" });

    const tabs: Array<{ id: DashboardTab; label: string; icon: string }> = [
      { id: "vitals", label: "Vitals", icon: "activity" },
      { id: "actions", label: "Agent Actions", icon: "bot" },
      { id: "index", label: "Index Management", icon: "database" },
    ];

    for (const tab of tabs) {
      const tabEl = tabBar.createDiv({
        cls: `notient-tab ${this.currentTab === tab.id ? "notient-tab--active" : ""}`,
      });

      const iconEl = tabEl.createSpan({ cls: "notient-tab-icon" });
      setIcon(iconEl, tab.icon);
      tabEl.createSpan({ text: tab.label });

      tabEl.addEventListener("click", () => {
        this.currentTab = tab.id;
        this.render();
      });
    }
  }

  private async renderVitalsTab(): Promise<void> {
    if (!this.contentEl_) return;

    // Refresh button
    const toolbar = this.contentEl_.createDiv({ cls: "notient-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      text: "Refresh",
      cls: "notient-refresh-btn",
    });
    refreshBtn.addEventListener("click", () => this.refresh());

    // Vitals container
    this.vitalsContainer = this.contentEl_.createDiv({ cls: "notient-vitals-container" });

    // Initial render
    await this.refresh();
  }

  private registerEvents(): void {
    // Subscribe to vitals updates
    const unsub = this.kernel.eventBus.on("vitals:updated", ({ vitals }) => {
      if (this.currentTab === "vitals") {
        this.renderVitals(vitals);
      }
    });
    this.register(() => unsub());

    // Listen for services initialized - refresh when ready
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.render();
    });
    this.register(() => unsubServices());

    // Workflow events (debounced to prevent UI jank during bulk runs)
    const unsubWorkflow = this.kernel.eventBus.on("workflow:progress", () => {
      if (this.currentTab === "actions") {
        this.debouncedRender();
      }
    });
    this.register(() => unsubWorkflow());

    const unsubWorkflowComplete = this.kernel.eventBus.on("workflow:completed", () => {
      if (this.currentTab === "actions") {
        this.debouncedRender();
      }
    });
    this.register(() => unsubWorkflowComplete());

    // Action events (debounced)
    const unsubAction = this.kernel.eventBus.on("action:applied", () => {
      if (this.currentTab === "actions") {
        this.debouncedRender();
      }
    });
    this.register(() => unsubAction());

    const unsubUndo = this.kernel.eventBus.on("action:undone", () => {
      if (this.currentTab === "actions") {
        this.debouncedRender();
      }
    });
    this.register(() => unsubUndo());
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.renderDebounceTimeout) {
      clearTimeout(this.renderDebounceTimeout);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.vitalsContainer) return;

    this.vitalsContainer.empty();

    const vaultVitals = this.getVaultVitals();

    if (!vaultVitals) {
      const isInitializing = this.kernel.isServicesInitializing;
      this.vitalsContainer.createDiv({
        cls: "notient-message",
        text: isInitializing
          ? "Connecting to your AI..."
          : "Dashboard unavailable - complete setup first",
      });
      return;
    }

    this.vitalsContainer.createDiv({
      cls: "notient-loading",
      text: "Analyzing your vault...",
    });

    try {
      const vitals = await vaultVitals.compute();
      this.renderVitals(vitals);
    } catch (error) {
      console.error("[Dashboard] Error computing vitals:", error);
      this.vitalsContainer.empty();
      this.vitalsContainer.createDiv({
        cls: "notient-error",
        text: "Couldn't analyze your vault",
      });
    }
  }

  private renderVitals(vitals: VaultVitalsData): void {
    const vaultVitals = this.getVaultVitals();
    if (!this.vitalsContainer || !vaultVitals) return;
    this.vitalsContainer.empty();

    // Health Score Card
    const healthScore = vaultVitals.calculateHealthScore(vitals);
    this.renderHealthScore(this.vitalsContainer, healthScore);

    // Stats Grid
    const statsGrid = this.vitalsContainer.createDiv({ cls: "notient-stats-grid" });

    // Counts Card
    this.renderCountsCard(statsGrid, vitals);

    // Connectivity Card
    this.renderConnectivityCard(statsGrid, vitals);

    // Processing Card
    this.renderProcessingCard(statsGrid, vitals);

    // PARA Distribution Card
    this.renderParaCard(statsGrid, vitals);

    // Top Connected Notes
    this.renderTopNotes(this.vitalsContainer, vitals);

    // Last updated
    const footer = this.vitalsContainer.createDiv({ cls: "notient-vitals-footer" });
    const date = new Date(vitals.computedAt);
    footer.setText(`Last updated: ${date.toLocaleTimeString()}`);
  }

  private renderHealthScore(container: HTMLElement, score: HealthScore): void {
    const card = container.createDiv({ cls: "notient-health-card" });

    // Main score
    const mainScore = card.createDiv({ cls: "notient-main-score" });
    const scoreCircle = mainScore.createDiv({ cls: "notient-score-circle" });
    scoreCircle.createSpan({ text: String(score.overall), cls: "notient-score-value" });
    scoreCircle.createSpan({ text: "/100", cls: "notient-score-max" });

    // Score label
    mainScore.createDiv({
      text: this.getScoreLabel(score.overall),
      cls: "notient-score-label",
    });

    // Sub scores
    const subScores = card.createDiv({ cls: "notient-sub-scores" });
    this.renderSubScore(subScores, "Connectivity", score.connectivity);
    this.renderSubScore(subScores, "Freshness", score.freshness);
    this.renderSubScore(subScores, "Organization", score.organization);
    this.renderSubScore(subScores, "Processing", score.processing);
  }

  private renderSubScore(container: HTMLElement, label: string, value: number): void {
    const item = container.createDiv({ cls: "notient-sub-score" });
    item.createSpan({ text: label, cls: "notient-sub-label" });

    const bar = item.createDiv({ cls: "notient-sub-bar" });
    const fill = bar.createDiv({ cls: "notient-sub-fill" });
    fill.style.width = `${value}%`;
    fill.addClass(this.getScoreClass(value));

    item.createSpan({ text: `${value}%`, cls: "notient-sub-value" });
  }

  private getScoreLabel(score: number): string {
    if (score >= 80) return "Excellent";
    if (score >= 60) return "Good";
    if (score >= 40) return "Fair";
    if (score >= 20) return "Needs Work";
    return "Critical";
  }

  private getScoreClass(score: number): string {
    if (score >= 80) return "score-excellent";
    if (score >= 60) return "score-good";
    if (score >= 40) return "score-fair";
    if (score >= 20) return "score-poor";
    return "score-critical";
  }

  private renderCountsCard(container: HTMLElement, vitals: VaultVitalsData): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createEl("h3", { text: "📊 Overview" });

    const stats = [
      { label: "Total Notes", value: vitals.counts.totalNotes },
      {
        label: "In Inbox",
        value: vitals.counts.inboxSize,
        highlight: vitals.counts.inboxSize > 10,
      },
      {
        label: "Orphan Notes",
        value: vitals.counts.orphanCount,
        highlight: vitals.counts.orphanCount > 20,
      },
      { label: "Hub Notes", value: vitals.counts.hubCount },
      { label: "Unique Tags", value: vitals.counts.totalTags },
      { label: "Total Links", value: vitals.counts.totalLinks },
    ];

    const list = card.createDiv({ cls: "notient-stat-list" });
    for (const stat of stats) {
      const row = list.createDiv({ cls: "notient-stat-row" });
      row.createSpan({ text: stat.label });
      const value = row.createSpan({ text: String(stat.value) });
      if (stat.highlight) {
        value.addClass("notient-highlight");
      }
    }
  }

  private renderConnectivityCard(container: HTMLElement, vitals: VaultVitalsData): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createEl("h3", { text: "🔗 Connectivity" });

    const stats = [
      { label: "Avg Links/Note", value: vitals.connectivity.averageLinksPerNote.toFixed(1) },
      { label: "No Incoming Links", value: vitals.connectivity.noIncomingLinks },
      { label: "No Outgoing Links", value: vitals.connectivity.noOutgoingLinks },
    ];

    const list = card.createDiv({ cls: "notient-stat-list" });
    for (const stat of stats) {
      const row = list.createDiv({ cls: "notient-stat-row" });
      row.createSpan({ text: stat.label });
      row.createSpan({ text: String(stat.value) });
    }
  }

  private renderProcessingCard(container: HTMLElement, vitals: VaultVitalsData): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createEl("h3", { text: "⚙️ Indexing" });

    const stats = [
      { label: "Indexed", value: vitals.processing.indexedCount },
      {
        label: "Pending",
        value: vitals.processing.pendingCount,
        highlight: vitals.processing.pendingCount > 0,
      },
      {
        label: "Errors",
        value: vitals.processing.errorCount,
        highlight: vitals.processing.errorCount > 0,
      },
      { label: "Freshness", value: `${vitals.processing.freshness}%` },
    ];

    const list = card.createDiv({ cls: "notient-stat-list" });
    for (const stat of stats) {
      const row = list.createDiv({ cls: "notient-stat-row" });
      row.createSpan({ text: stat.label });
      const value = row.createSpan({ text: String(stat.value) });
      if (stat.highlight) {
        value.addClass("notient-highlight-warn");
      }
    }

    // Last full index
    if (vitals.processing.lastFullIndexAt) {
      const date = new Date(vitals.processing.lastFullIndexAt);
      const lastIndex = card.createDiv({ cls: "notient-last-index" });
      lastIndex.setText(
        `Last full index: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
      );
    }
  }

  private renderParaCard(container: HTMLElement, vitals: VaultVitalsData): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createEl("h3", { text: "📁 PARA Distribution" });

    const total = Object.values(vitals.paraDistribution).reduce((a, b) => a + b, 0);
    const items = [
      { label: "📥 Inbox", value: vitals.paraDistribution.inbox },
      { label: "🎯 Projects", value: vitals.paraDistribution.projects },
      { label: "🏠 Areas", value: vitals.paraDistribution.areas },
      { label: "📚 Resources", value: vitals.paraDistribution.resources },
      { label: "📦 Archive", value: vitals.paraDistribution.archive },
      { label: "❓ Unknown", value: vitals.paraDistribution.unknown, highlight: true },
    ];

    const list = card.createDiv({ cls: "notient-para-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "notient-para-row" });

      row.createSpan({ text: item.label, cls: "notient-para-label" });

      const barContainer = row.createDiv({ cls: "notient-para-bar-container" });
      const bar = barContainer.createDiv({ cls: "notient-para-bar" });
      const pct = total > 0 ? (item.value / total) * 100 : 0;
      bar.style.width = `${pct}%`;
      if (item.highlight && item.value > 0) {
        bar.addClass("notient-para-unknown");
      }

      row.createSpan({
        text: `${item.value} (${Math.round(pct)}%)`,
        cls: "notient-para-value",
      });
    }
  }

  private renderTopNotes(container: HTMLElement, vitals: VaultVitalsData): void {
    const section = container.createDiv({ cls: "notient-top-notes" });
    section.createEl("h3", { text: "🌟 Most Connected Notes" });

    if (vitals.connectivity.topConnectedNotes.length === 0) {
      section.createDiv({ text: "No linked notes yet", cls: "notient-message" });
      return;
    }

    const list = section.createDiv({ cls: "notient-top-list" });
    for (const note of vitals.connectivity.topConnectedNotes) {
      const item = list.createDiv({ cls: "notient-top-item" });
      item.addEventListener("click", () => this.openFile(note.path));

      item.createSpan({ text: note.title, cls: "notient-top-title" });
      item.createSpan({ text: `${note.linkCount} links`, cls: "notient-top-count" });
    }
  }

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }

  // ============ Agent Actions Tab ============

  private renderActionsTab(): void {
    if (!this.contentEl_) return;

    // Active Workflows section
    this.renderActiveWorkflows();

    // Review Queue section
    this.renderReviewQueue();

    // Action History section
    this.renderActionHistory();
  }

  private renderActiveWorkflows(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "notient-section" });
    section.createEl("h2", { text: "Active Workflows" });

    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) {
      section.createDiv({ cls: "notient-message", text: "Workflow system not available" });
      return;
    }

    const currentWorkflow = workflowRunner.getCurrentWorkflow();
    const queuedWorkflows = workflowRunner.getQueuedWorkflows();

    if (!currentWorkflow && queuedWorkflows.length === 0) {
      section.createDiv({ cls: "notient-message", text: "No active workflows" });
      return;
    }

    const list = section.createDiv({ cls: "notient-workflow-list" });

    // Current workflow
    if (currentWorkflow) {
      this.renderWorkflowItem(list, currentWorkflow, true);
    }

    // Queued workflows
    for (const workflow of queuedWorkflows) {
      this.renderWorkflowItem(list, workflow, false);
    }
  }

  private renderWorkflowItem(
    container: HTMLElement,
    workflow: WorkflowRun,
    isActive: boolean,
  ): void {
    const item = container.createDiv({
      cls: `notient-workflow-item ${isActive ? "notient-workflow-item--active" : ""}`,
    });

    // Header
    const header = item.createDiv({ cls: "notient-workflow-item-header" });

    const titleEl = header.createDiv({ cls: "notient-workflow-item-title" });
    const iconEl = titleEl.createSpan({ cls: "notient-workflow-item-icon" });
    setIcon(iconEl, this.getWorkflowIcon(workflow.spec.command));
    titleEl.createSpan({ text: `/${workflow.spec.command}` });

    const scopeText =
      workflow.spec.scope === "vault"
        ? "vault"
        : `folder: ${workflow.spec.targets[0]?.split("/")[0] || ""}`;
    titleEl.createSpan({ text: ` on ${scopeText}`, cls: "notient-workflow-item-scope" });

    // Status
    header.createDiv({
      cls: `notient-workflow-status notient-workflow-status--${workflow.status}`,
      text: workflow.status,
    });

    // Progress (for running workflows)
    if (workflow.status === "running") {
      const progressContainer = item.createDiv({ cls: "notient-workflow-progress-container" });

      const progressBar = progressContainer.createDiv({ cls: "notient-workflow-progress" });
      const percent =
        workflow.progress.total > 0
          ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
          : 0;
      progressBar.createDiv({
        cls: "notient-workflow-progress-fill",
        attr: { style: `width: ${percent}%` },
      });

      progressContainer.createDiv({
        cls: "notient-workflow-progress-text",
        text: `${workflow.progress.completed}/${workflow.progress.total} complete${workflow.progress.failed > 0 ? ` (${workflow.progress.failed} failed)` : ""}`,
      });
    }

    // Actions
    if (workflow.status === "running" || workflow.status === "queued") {
      const actions = item.createDiv({ cls: "notient-workflow-actions" });
      const cancelBtn = actions.createEl("button", {
        cls: "notient-btn notient-btn--danger",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", () => {
        const runner = this.getWorkflowRunner();
        if (runner) {
          runner.cancel(workflow.id);
          new Notice("Workflow cancelled");
          this.render();
        }
      });
    }

    // Errors (if any)
    if (workflow.errors.length > 0) {
      const errorsEl = item.createDiv({ cls: "notient-workflow-errors" });
      errorsEl.createDiv({
        text: `${workflow.errors.length} errors:`,
        cls: "notient-workflow-errors-title",
      });
      for (const err of workflow.errors.slice(0, 3)) {
        errorsEl.createDiv({ text: `• ${err.error}`, cls: "notient-workflow-error" });
      }
      if (workflow.errors.length > 3) {
        errorsEl.createDiv({
          text: `...and ${workflow.errors.length - 3} more`,
          cls: "notient-workflow-error",
        });
      }
    }
  }

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

  private renderReviewQueue(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "notient-section" });
    section.createEl("h2", { text: "Review Queue" });

    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) {
      section.createDiv({ cls: "notient-message", text: "Workflow system not available" });
      return;
    }

    // Collect review queue from current and queued workflows
    const allReviewItems: ProposedAction[] = [];

    const currentWorkflow = workflowRunner.getCurrentWorkflow();
    if (currentWorkflow) {
      allReviewItems.push(...currentWorkflow.reviewQueue);
    }

    for (const workflow of workflowRunner.getQueuedWorkflows()) {
      allReviewItems.push(...workflow.reviewQueue);
    }

    if (allReviewItems.length === 0) {
      section.createDiv({ cls: "notient-message", text: "No actions pending review" });
      return;
    }

    section.createDiv({
      cls: "notient-review-count",
      text: `${allReviewItems.length} action${allReviewItems.length > 1 ? "s" : ""} pending review`,
    });

    // Info about feature status
    section.createDiv({
      cls: "notient-message notient-message--info",
      text: "Review items in the queue below. Approving items will apply them to your vault.",
    });

    const list = section.createDiv({ cls: "notient-review-list" });

    for (const action of allReviewItems.slice(0, 20)) {
      const item = list.createDiv({ cls: "notient-review-item" });

      // Risk badge
      item.createDiv({
        cls: `notient-risk-badge notient-risk-badge--${action.risk}`,
        text: action.risk,
      });

      // Action info
      const info = item.createDiv({ cls: "notient-review-info" });
      info.createDiv({ cls: "notient-review-title", text: action.title });
      info.createDiv({ cls: "notient-review-target", text: action.target });
      info.createDiv({ cls: "notient-review-reason", text: action.reason });

      // Action buttons
      const actions = item.createDiv({ cls: "notient-review-actions" });

      const applyBtn = actions.createEl("button", {
        cls: "notient-btn notient-btn--primary",
        text: "Apply",
      });
      applyBtn.addEventListener("click", async () => {
        const applier = this.getActionApplier();
        if (applier) {
          applyBtn.disabled = true;
          applyBtn.textContent = "Applying...";
          const result = await applier.applyConfirmed(action);

          if (result.success) {
            new Notice(`Applied: ${action.title}`);
            // Remove from queue
            workflowRunner.dismissReviewItem(action.id);
            this.render();
          } else {
            new Notice(`Failed: ${result.error}`);
            applyBtn.disabled = false;
            applyBtn.textContent = "Apply";
          }
        }
      });

      const dismissBtn = actions.createEl("button", {
        cls: "notient-btn",
        text: "Dismiss",
      });
      dismissBtn.addEventListener("click", () => {
        workflowRunner.dismissReviewItem(action.id);
        this.render();
      });
    }


    if (allReviewItems.length > 20) {
      section.createDiv({
        cls: "notient-message",
        text: `...and ${allReviewItems.length - 20} more`,
      });
    }
  }

  private renderActionHistory(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "notient-section" });
    section.createEl("h2", { text: "Action History" });

    const actionHistory = this.getActionHistory();
    if (!actionHistory) {
      section.createDiv({ cls: "notient-message", text: "Action history not available" });
      return;
    }

    const records = actionHistory.getAllRecords();

    if (records.length === 0) {
      section.createDiv({ cls: "notient-message", text: "No actions applied yet" });
      return;
    }

    // Show last 20 actions
    const recentRecords = records.slice(-20).reverse();

    const list = section.createDiv({ cls: "notient-history-list" });

    for (const record of recentRecords) {
      const item = list.createDiv({ cls: "notient-history-item" });

      // Time
      const date = new Date(record.timestamp);
      item.createDiv({
        cls: "notient-history-time",
        text: this.formatTime(date),
      });

      // Action info
      const info = item.createDiv({ cls: "notient-history-info" });

      const typeIcon = info.createSpan({ cls: "notient-history-icon" });
      setIcon(typeIcon, this.getActionIcon(record.action.type));

      info.createSpan({ cls: "notient-history-title", text: record.action.title });
      info.createSpan({ cls: "notient-history-target", text: ` → ${record.action.target}` });

      // Undo button
      const undoBtn = item.createEl("button", {
        cls: "notient-btn notient-btn--small",
        text: "Undo",
      });
      undoBtn.addEventListener("click", async () => {
        const history = this.getActionHistory();
        if (history) {
          const result = await history.undo(record.id);
          if (result.success) {
            new Notice("Action undone");
            this.render();
          } else {
            new Notice(`Undo failed: ${result.error}`);
          }
        }
      });
    }

    if (records.length > 20) {
      section.createDiv({
        cls: "notient-message",
        text: `Showing last 20 of ${records.length} actions`,
      });
    }
  }

  private getActionIcon(type: string): string {
    switch (type) {
      case "frontmatter_set":
      case "frontmatter_add_tags":
        return "tag";
      case "append_section":
        return "file-plus";
      case "append_related_links":
        return "link";
      case "move_note":
        return "folder-input";
      default:
        return "file-edit";
    }
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  }

  // ============ Index Management Tab ============

  private renderIndexTab(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "notient-section" });
    section.createEl("h2", { text: "Index Management" });

    // Index stats
    const statsCard = section.createDiv({ cls: "notient-stat-card" });
    statsCard.createEl("h3", { text: "Index Status" });

    const indexManager = this.kernel.getService<{ getIndexedCount(): number }>("indexManager");
    const indexCount = indexManager?.getIndexedCount() ?? 0;
    const totalNotes = this.kernel.obsidian.getMarkdownFiles().length;

    const statsList = statsCard.createDiv({ cls: "notient-stat-list" });

    const indexedRow = statsList.createDiv({ cls: "notient-stat-row" });
    indexedRow.createSpan({ text: "Indexed Notes" });
    indexedRow.createSpan({ text: String(indexCount) });

    const totalRow = statsList.createDiv({ cls: "notient-stat-row" });
    totalRow.createSpan({ text: "Total Notes" });
    totalRow.createSpan({ text: String(totalNotes) });

    const coverageRow = statsList.createDiv({ cls: "notient-stat-row" });
    coverageRow.createSpan({ text: "Coverage" });
    const coverage = totalNotes > 0 ? Math.round((indexCount / totalNotes) * 100) : 0;
    coverageRow.createSpan({ text: `${coverage}%` });

    // Check if index is read-only (external/user-provided)
    const indexManagerForReadOnly = this.kernel.getService<{ isReadOnly(): boolean }>("indexManager");
    const isReadOnly = indexManagerForReadOnly?.isReadOnly() ?? false;

    // Actions - only show if not read-only
    const actionsSection = section.createDiv({ cls: "notient-index-actions" });
    actionsSection.createEl("h3", { text: "Index Actions" });

    if (isReadOnly) {
      // Show read-only notice instead of buttons
      const readOnlyNotice = actionsSection.createDiv({ cls: "notient-readonly-notice" });
      readOnlyNotice.createSpan({ text: "🔒 External index is read-only (search only)" });
      readOnlyNotice.style.cssText = "padding: 12px; background: var(--background-modifier-border); border-radius: 6px; color: var(--text-muted); font-size: 13px;";
    } else {
      // Show sync/rebuild buttons for plugin-managed indices
      const syncBtn = actionsSection.createEl("button", {
        cls: "notient-btn notient-btn--primary",
        text: "Sync Index",
      });
      syncBtn.addEventListener("click", async () => {
        new Notice("Starting index sync...");
        const indexer = this.kernel.getService<{
          syncVault(): Promise<{ added: number; updated: number }>;
        }>("indexer");
        if (indexer) {
          const result = await indexer.syncVault();
          new Notice(`Sync complete: ${result.added} added, ${result.updated} updated`);
          this.render();
        }
      });

      const rebuildBtn = actionsSection.createEl("button", {
        cls: "notient-btn",
        text: "Full Rebuild",
      });
      rebuildBtn.addEventListener("click", async () => {
        new Notice("Starting full reindex...");
        const indexer = this.kernel.getService<{
          fullReindex(): Promise<{ added: number; updated: number; durationMs: number }>;
        }>("indexer");
        if (indexer) {
          const result = await indexer.fullReindex();
          new Notice(
            `Reindex complete: ${result.added + result.updated} notes in ${Math.round(result.durationMs / 1000)}s`,
          );
          this.render();
        }
      });
    }

    // Service health
    const healthSection = section.createDiv({ cls: "notient-section" });
    healthSection.createEl("h3", { text: "Service Health" });

    const health = this.kernel.serviceHealth;
    const healthList = healthSection.createDiv({ cls: "notient-stat-list" });

    const ollamaRow = healthList.createDiv({ cls: "notient-stat-row" });
    ollamaRow.createSpan({ text: "Ollama (Embeddings)" });
    const ollamaStatus = ollamaRow.createSpan({ text: health.ollama.status });
    ollamaStatus.addClass(
      health.ollama.status === "healthy" ? "notient-status-healthy" : "notient-status-error",
    );

    const lmRow = healthList.createDiv({ cls: "notient-stat-row" });
    lmRow.createSpan({ text: "LM Studio (Reasoning)" });
    const lmStatus = lmRow.createSpan({ text: health.lmstudio.status });
    lmStatus.addClass(
      health.lmstudio.status === "healthy" ? "notient-status-healthy" : "notient-status-error",
    );
  }
}
