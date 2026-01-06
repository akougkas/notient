/**
 * Notient Dashboard View
 * 
 * Full-screen vault vitals dashboard.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type { Kernel } from "../core/kernel";
import type { VaultVitalsData, HealthScore } from "../types/vitals";
import { VIEW_TYPE_DASHBOARD } from "../core/constants";

/** Common interface for vitals implementations */
interface VitalsProvider {
  compute(): Promise<VaultVitalsData>;
  getCached(): VaultVitalsData | null;
  calculateHealthScore(vitals: VaultVitalsData): HealthScore;
}

export class NotientDashboardView extends ItemView {
  private vitalsContainer: HTMLElement | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel,
    private vaultVitals: VitalsProvider | null
  ) {
    super(leaf);
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
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("notient-dashboard");

    // Header
    const header = container.createDiv({ cls: "notient-dashboard-header" });
    header.createEl("h1", { text: "Vault Vitals" });
    
    const refreshBtn = header.createEl("button", {
      text: "Refresh",
      cls: "notient-refresh-btn",
    });
    refreshBtn.addEventListener("click", () => this.refresh());

    // Main content
    this.vitalsContainer = container.createDiv({ cls: "notient-vitals-container" });
    
    // Initial render
    await this.refresh();

    // Subscribe to vitals updates
    const unsub = this.kernel.eventBus.on("vitals:updated", ({ vitals }) => {
      this.renderVitals(vitals);
    });
    this.register(() => unsub());
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.vitalsContainer) return;

    this.vitalsContainer.empty();

    if (!this.vaultVitals) {
      this.vitalsContainer.createDiv({
        cls: "notient-message",
        text: "Vitals unavailable - complete setup first",
      });
      return;
    }

    this.vitalsContainer.createDiv({
      cls: "notient-loading",
      text: "Computing vault vitals...",
    });

    try {
      const vitals = await this.vaultVitals.compute();
      this.renderVitals(vitals);
    } catch (error) {
      console.error("[Dashboard] Error computing vitals:", error);
      this.vitalsContainer.empty();
      this.vitalsContainer.createDiv({
        cls: "notient-error",
        text: "Failed to compute vault vitals",
      });
    }
  }

  private renderVitals(vitals: VaultVitalsData): void {
    if (!this.vitalsContainer || !this.vaultVitals) return;
    this.vitalsContainer.empty();

    // Health Score Card
    const healthScore = this.vaultVitals.calculateHealthScore(vitals);
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
      cls: "notient-score-label" 
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
      { label: "In Inbox", value: vitals.counts.inboxSize, highlight: vitals.counts.inboxSize > 10 },
      { label: "Orphan Notes", value: vitals.counts.orphanCount, highlight: vitals.counts.orphanCount > 20 },
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
      { label: "Pending", value: vitals.processing.pendingCount, highlight: vitals.processing.pendingCount > 0 },
      { label: "Errors", value: vitals.processing.errorCount, highlight: vitals.processing.errorCount > 0 },
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
      lastIndex.setText(`Last full index: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
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
      
      const label = row.createSpan({ text: item.label, cls: "notient-para-label" });
      
      const barContainer = row.createDiv({ cls: "notient-para-bar-container" });
      const bar = barContainer.createDiv({ cls: "notient-para-bar" });
      const pct = total > 0 ? (item.value / total) * 100 : 0;
      bar.style.width = `${pct}%`;
      if (item.highlight && item.value > 0) {
        bar.addClass("notient-para-unknown");
      }
      
      row.createSpan({ 
        text: `${item.value} (${Math.round(pct)}%)`,
        cls: "notient-para-value" 
      });
    }
  }

  private renderTopNotes(container: HTMLElement, vitals: VaultVitalsData): void {
    const section = container.createDiv({ cls: "notient-top-notes" });
    section.createEl("h3", { text: "🌟 Most Connected Notes" });

    if (vitals.connectivity.topConnectedNotes.length === 0) {
      section.createDiv({ text: "No connected notes found", cls: "notient-message" });
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
}
