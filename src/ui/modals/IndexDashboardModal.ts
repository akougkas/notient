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

    // Stats grid
    const statsGrid = contentEl.createDiv({ cls: "notient-stats-grid" });

    this.createStatCard(statsGrid, String(this.indexStatus.noteCount), "Notes Indexed");
    this.createStatCard(statsGrid, this.indexStatus.isIndexing ? "Indexing" : "Ready", "Status");
    this.createStatCard(
      statsGrid,
      this.currentSystemDim > 0 ? `${this.currentSystemDim}d` : "-",
      "Dimension",
    );

    // Section header
    const headerDiv = contentEl.createDiv({ cls: "notient-section-header" });
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

    // Index list
    const listDiv = contentEl.createDiv({ cls: "notient-index-list" });

    if (this.isLoading) {
      const loadingDiv = listDiv.createDiv({ cls: "notient-loading-state" });
      loadingDiv.createSpan({ cls: "notient-spinner" });
      loadingDiv.createSpan({ text: " Loading indices..." });
      return;
    }

    if (this.indices.length === 0) {
      listDiv.createDiv({
        text: "No indices found on disk.",
        cls: "notient-empty-state",
      });
      return;
    }

    for (const idx of this.indices) {
      const isCompatible = idx.dimension === this.currentSystemDim;
      const isActive = this.kernel.settings.indexing.activeIndexPath === idx.path;

      const itemDiv = listDiv.createDiv({
        cls: `notient-index-item ${!isCompatible ? "notient-index-item--incompatible" : ""} ${isActive ? "notient-index-item--active" : ""}`,
      });

      const infoDiv = itemDiv.createDiv({ cls: "notient-index-info" });
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

      if (!isActive) {
        const loadBtn = itemDiv.createEl("button", {
          text: isCompatible ? "Load" : "Incompatible",
          cls: "mod-muted",
          attr: {
            disabled: !isCompatible ? "true" : null,
            title: !isCompatible
              ? `Dimension mismatch: Index is ${idx.dimension}d, System is ${this.currentSystemDim}d`
              : "Load this index",
          },
        });

        if (isCompatible) {
          loadBtn.addEventListener("click", () => this.handleSwitchIndex(idx.path));
        }
      }
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
