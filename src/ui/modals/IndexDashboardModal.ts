/**
 * Index Dashboard Modal
 *
 * Obsidian-native modal for viewing and managing search indices.
 * With SQLite backend, shows stats only (no JSON index discovery).
 */

import { type App, Modal, setIcon } from "obsidian";
import type { Kernel } from "../../core/kernel";
import type { IndexManager } from "../../services/indexManager";

interface IndexStatus {
  noteCount: number;
  lastSyncedAt: Date | null;
  isIndexing: boolean;
  indexingProgress?: number;
}

export class IndexDashboardModal extends Modal {
  private kernel: Kernel;
  private indexStatus: IndexStatus;
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

    const indexManager = this.kernel.getService<IndexManager>("indexManager");
    if (indexManager) {
      this.currentSystemDim = indexManager.getDimension();
    }

    this.renderContent();
  }

  private renderContent(): void {
    const { contentEl } = this;

    // Clear existing content except title
    const title = contentEl.querySelector("h2");
    contentEl.empty();
    if (title) contentEl.appendChild(title);

    this.renderStatsGrid(contentEl);
    this.renderInfo(contentEl);
  }

  private renderStatsGrid(container: HTMLElement): void {
    const statsGrid = container.createDiv({ cls: "notient-stats-grid" });
    const statusText = this.indexStatus.isIndexing ? "Indexing" : "Ready";
    const dimensionText = this.currentSystemDim > 0 ? `${this.currentSystemDim}d` : "-";

    this.createStatCard(statsGrid, String(this.indexStatus.noteCount), "Notes Indexed");
    this.createStatCard(statsGrid, statusText, "Status");
    this.createStatCard(statsGrid, dimensionText, "Dimension");
  }

  private renderInfo(container: HTMLElement): void {
    const infoDiv = container.createDiv({ cls: "notient-empty-state" });
    infoDiv.createSpan({ text: "Using SQLite unified index." });
  }

  private createStatCard(container: HTMLElement, value: string, label: string): void {
    const card = container.createDiv({ cls: "notient-stat-card" });
    card.createSpan({ text: value, cls: "notient-stat-value" });
    card.createSpan({ text: label, cls: "notient-stat-label" });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
