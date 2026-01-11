/**
 * Index Dashboard Modal
 *
 * Obsidian-native modal for viewing and managing search indices.
 */

import { type App, Modal, Notice, setIcon } from "obsidian";
import type { Kernel } from "../../core/kernel";
import type { DiscoveredIndex, IndexManager } from "../../services/indexManager";

interface IndexStatus {
  noteCount: number;
  lastSyncedAt: Date | null;
  isIndexing: boolean;
  indexingProgress?: number;
}

export class IndexDashboardModal extends Modal {
  private kernel: Kernel;
  private indexStatus: IndexStatus;
  private indices: DiscoveredIndex[] = [];
  private isLoading = false;
  private currentSystemDim = 0;

  constructor(app: App, kernel: Kernel, indexStatus: IndexStatus) {
    super(app);
    this.kernel = kernel;
    this.indexStatus = indexStatus;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("notient-index-dashboard-modal");
    contentEl.createEl("h2", { text: "Index Dashboard" });

    this.renderContent();
    await this.loadIndices();
    this.renderContent();
  }

  private async loadIndices(): Promise<void> {
    this.isLoading = true;

    try {
      const indexManager = this.kernel.getService<IndexManager>("indexManager");
      if (indexManager) {
        this.currentSystemDim = indexManager.getDimension();
        this.indices = await indexManager.discoverIndices();
      }
    } catch (e) {
      console.error("[IndexDashboard] Failed to load indices", e);
      new Notice(`Error loading indices: ${String(e)}`);
    } finally {
      this.isLoading = false;
    }
  }

  private renderContent(): void {
    const { contentEl } = this;

    // Clear existing content except title
    const title = contentEl.querySelector("h2");
    contentEl.empty();
    if (title) contentEl.appendChild(title);

    this.renderStatsGrid(contentEl);
    this.renderSectionHeader(contentEl);
    this.renderIndexList(contentEl);
  }

  private renderStatsGrid(container: HTMLElement): void {
    const statsGrid = container.createDiv({ cls: "notient-stats-grid" });
    const statusText = this.indexStatus.isIndexing ? "Indexing" : "Ready";
    const dimensionText = this.currentSystemDim > 0 ? `${this.currentSystemDim}d` : "-";

    this.createStatCard(statsGrid, String(this.indexStatus.noteCount), "Notes Indexed");
    this.createStatCard(statsGrid, statusText, "Status");
    this.createStatCard(statsGrid, dimensionText, "Dimension");
  }

  private renderSectionHeader(container: HTMLElement): void {
    const headerDiv = container.createDiv({ cls: "notient-section-header" });
    headerDiv.createEl("h4", { text: "Available Indices" });

    const refreshBtn = headerDiv.createEl("button", {
      cls: "notient-btn-icon",
      attr: { "aria-label": "Refresh List" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", async () => {
      await this.loadIndices();
      this.renderContent();
    });
  }

  private renderIndexList(container: HTMLElement): void {
    const listDiv = container.createDiv({ cls: "notient-index-list" });

    if (this.isLoading) {
      this.renderLoadingState(listDiv);
      return;
    }

    if (this.indices.length === 0) {
      this.renderEmptyState(listDiv);
      return;
    }

    for (const idx of this.indices) {
      this.renderIndexItem(listDiv, idx);
    }
  }

  private renderLoadingState(container: HTMLElement): void {
    const loadingDiv = container.createDiv({ cls: "notient-loading-state" });
    loadingDiv.createSpan({ cls: "notient-spinner" });
    loadingDiv.createSpan({ text: " Loading indices..." });
  }

  private renderEmptyState(container: HTMLElement): void {
    container.createDiv({
      text: "No indices found on disk.",
      cls: "notient-empty-state",
    });
  }

  private renderIndexItem(container: HTMLElement, idx: DiscoveredIndex): void {
    const isCompatible = idx.dimension === this.currentSystemDim;
    const isActive = this.kernel.settings.indexing.activeIndexPath === idx.path;

    const itemClasses = this.buildIndexItemClasses(isCompatible, isActive);
    const itemDiv = container.createDiv({ cls: itemClasses });

    this.renderIndexInfo(itemDiv, idx, isActive);
    this.renderIndexActions(itemDiv, idx, isCompatible, isActive);
  }

  private buildIndexItemClasses(isCompatible: boolean, isActive: boolean): string {
    let classes = "notient-index-item";
    if (!isCompatible) classes += " notient-index-item--incompatible";
    if (isActive) classes += " notient-index-item--active";
    return classes;
  }

  private renderIndexInfo(container: HTMLElement, idx: DiscoveredIndex, isActive: boolean): void {
    const infoDiv = container.createDiv({ cls: "notient-index-info" });
    const nameRow = infoDiv.createDiv({ cls: "notient-index-name-row" });
    nameRow.createSpan({ text: idx.displayName, cls: "notient-index-name" });

    if (idx.source === "vault") {
      nameRow.createSpan({ text: "External", cls: "notient-badge notient-badge--subtle" });
    }
    if (isActive) {
      nameRow.createSpan({ text: "Active", cls: "notient-badge notient-badge--active" });
    }

    infoDiv.createDiv({
      text: `${idx.dimension}d \u2022 ${idx.docCount} docs \u2022 ${this.formatDate(idx.createdAt)}`,
      cls: "notient-index-meta",
    });
  }

  private renderIndexActions(
    container: HTMLElement,
    idx: DiscoveredIndex,
    isCompatible: boolean,
    isActive: boolean,
  ): void {
    if (isActive) return;

    const buttonText = isCompatible ? "Load" : "Incompatible";
    const buttonTitle = isCompatible
      ? "Load this index"
      : `Dimension mismatch: Index is ${idx.dimension}d, System is ${this.currentSystemDim}d`;

    const loadBtn = container.createEl("button", {
      text: buttonText,
      cls: "mod-muted",
      attr: {
        disabled: !isCompatible ? "true" : null,
        title: buttonTitle,
      },
    });

    if (isCompatible) {
      loadBtn.addEventListener("click", () => this.handleSwitchIndex(idx.path));
    }
  }

  private createStatCard(container: HTMLElement, value: string, label: string): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createSpan({ text: value, cls: "notient-stat-value" });
    card.createSpan({ text: label, cls: "notient-stat-label" });
  }

  private formatDate(date: Date | null): string {
    if (!date) return "Unknown date";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  private async handleSwitchIndex(indexPath: string): Promise<void> {
    try {
      const indexManager = this.kernel.getService<IndexManager>("indexManager");
      if (indexManager) {
        new Notice("Switching index...");
        await indexManager.switchToIndex(indexPath);
        this.close();
      }
    } catch (e) {
      console.error("[IndexDashboard] Failed to switch index", e);
      new Notice(`Failed to switch index: ${String(e)}`);
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
