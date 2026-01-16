/**
 * IndexManagementPanel - UI for managing vector indices
 *
 * Clean design with:
 * 1. Current Index Status - health metrics, quick actions
 * 2. Index Operations - all 7 ops for the active index
 * 3. Index Inventory - other available indices
 * 4. Danger Zone - destructive operations
 * 5. Import Section
 */

import { type App, Setting, setIcon } from "obsidian";
import type { Kernel } from "../../../core/kernel";
import type { NotientSettings } from "../../../types/settings";

export interface IndexInfo {
  path: string;
  modelKey: string;
  dimension: number;
  docCount: number;
  source: "plugin" | "vault";
  createdAt: Date | null;
  updatedAt: Date | null;
  vaultHash: string | null;
  isLegacy: boolean;
  displayName: string;
}

export interface IndexManagerInterface {
  getIndexedCount(): number;
  getActiveModelKey(): string;
  getDimension(): number;
  isReadOnly(): boolean;
  discoverIndices(): Promise<IndexInfo[]>;
  exportIndex(): Promise<string>;
  importIndex(json: string): Promise<{ modelKey: string; noteCount: number }>;
  trimIndex(): Promise<{ removed: number }>;
  deleteIndexByPath(path: string): Promise<boolean>;
  switchToIndex(path: string): Promise<void>;
  clearAll(): Promise<void>;
  getStats(): Promise<{
    exists: boolean;
    modelKey: string | null;
    noteCount: number;
    chunkCount: number;
    vaultNoteCount: number;
    lastFullIndexAt: number | null;
    state: "none" | "complete" | "incomplete" | "stale";
    completionPercent: number;
  }>;
  clearDiscoveryCache?(): void;
}

export class IndexManagementPanel {
  private operationInProgress: {
    type: "switch" | "trim" | "delete" | "import" | "rebuild" | "sync" | "export" | null;
    path?: string;
  } = { type: null };

  constructor(
    private app: App,
    private kernel: Kernel,
    private settings: NotientSettings,
    private onRefresh: () => void,
  ) {}

  render(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({
      cls: "notient-settings-section notient-index-management",
    });

    const isReady = this.kernel.isServicesInitialized;
    const indexManager = isReady
      ? this.kernel.getService<IndexManagerInterface>("indexManager")
      : null;

    if (!isReady) {
      this.renderNotReady(section);
      return;
    }

    if (!indexManager) {
      section.createDiv({ cls: "notient-settings-info-dim", text: "No index data available" });
      return;
    }

    // Load stats and render
    this.renderWithStats(section, indexManager);
  }

  private renderNotReady(section: HTMLElement): void {
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "database");
    header.createSpan({ text: "Index Management" });

    const infoBox = section.createDiv({ cls: "notient-settings-info-box" });
    infoBox.createEl("div", {
      text: this.kernel.isServicesInitializing
        ? "Services initializing..."
        : "Services not ready - complete setup wizard first",
      cls: "notient-settings-info-dim",
    });
  }

  private async renderWithStats(
    section: HTMLElement,
    indexManager: IndexManagerInterface,
  ): Promise<void> {
    // Header
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "database");
    header.createSpan({ text: "Index Management" });

    // Get stats
    const stats = await indexManager.getStats();
    const isReadOnly = indexManager.isReadOnly();

    // 1. Current Index Status
    this.renderCurrentStatus(section, stats, isReadOnly);

    // 2. Index Operations (for active index)
    if (!isReadOnly) {
      this.renderIndexOperations(section, indexManager, stats);
    }

    // 3. Index Inventory (other indices)
    this.renderIndexInventory(section, indexManager);

    // 4. Import Section
    this.renderImportSection(section, indexManager);

    // 5. Danger Zone
    if (!isReadOnly) {
      this.renderDangerZone(section, indexManager);
    }
  }

  private renderCurrentStatus(
    section: HTMLElement,
    stats: Awaited<ReturnType<IndexManagerInterface["getStats"]>>,
    isReadOnly: boolean,
  ): void {
    const statusBox = section.createDiv({ cls: "notient-settings-status-box" });

    // Model info row
    const statusRow = statusBox.createDiv({ cls: "notient-settings-status-row" });

    const modelEl = statusRow.createEl("span", { cls: "notient-settings-index-model" });
    const keyIcon = modelEl.createSpan({ cls: "notient-settings-icon-inline" });
    setIcon(keyIcon, "key");
    modelEl.createSpan({ text: stats.modelKey || "No model" });

    const dimBadge = statusRow.createEl("span", {
      text: `${stats.chunkCount > 0 ? Math.round(stats.chunkCount / stats.noteCount) : 0} chunks/note avg`,
      cls: "notient-settings-index-dim",
    });

    statusRow.createEl("span", {
      text: isReadOnly ? "Read-Only" : "Active",
      cls: `notient-settings-badge ${isReadOnly ? "external" : "plugin"}`,
    });

    // Health metrics row
    const metricsRow = statusBox.createDiv({ cls: "notient-settings-metrics-row" });

    // Note count
    const noteMetric = metricsRow.createDiv({ cls: "notient-settings-metric" });
    noteMetric.createEl("span", {
      text: String(stats.noteCount),
      cls: "notient-settings-metric-value",
    });
    noteMetric.createEl("span", { text: "Notes Indexed", cls: "notient-settings-metric-label" });

    // Chunk count
    const chunkMetric = metricsRow.createDiv({ cls: "notient-settings-metric" });
    chunkMetric.createEl("span", {
      text: String(stats.chunkCount),
      cls: "notient-settings-metric-value",
    });
    chunkMetric.createEl("span", { text: "Total Chunks", cls: "notient-settings-metric-label" });

    // Completion
    const completionMetric = metricsRow.createDiv({ cls: "notient-settings-metric" });
    completionMetric.createEl("span", {
      text: `${stats.completionPercent}%`,
      cls: `notient-settings-metric-value ${stats.state === "complete" ? "complete" : stats.state === "incomplete" ? "incomplete" : ""}`,
    });
    completionMetric.createEl("span", {
      text: `of ${stats.vaultNoteCount} vault notes`,
      cls: "notient-settings-metric-label",
    });

    // Status indicator
    const stateMap: Record<string, { icon: string; text: string; cls: string }> = {
      none: { icon: "alert-circle", text: "No index", cls: "none" },
      complete: { icon: "check-circle", text: "Complete", cls: "complete" },
      incomplete: { icon: "clock", text: "Incomplete", cls: "incomplete" },
      stale: { icon: "alert-triangle", text: "Stale", cls: "stale" },
    };
    const stateInfo = stateMap[stats.state] || stateMap.none;

    const stateEl = statusBox.createDiv({
      cls: `notient-settings-state-indicator ${stateInfo.cls}`,
    });
    const stateIcon = stateEl.createSpan({ cls: "notient-settings-icon-inline" });
    setIcon(stateIcon, stateInfo.icon);
    stateEl.createSpan({ text: stateInfo.text });

    if (stats.lastFullIndexAt) {
      const lastIndexed = new Date(stats.lastFullIndexAt);
      stateEl.createSpan({
        text: ` (Last full: ${lastIndexed.toLocaleDateString()})`,
        cls: "notient-settings-info-dim",
      });
    }

    if (isReadOnly) {
      const readonlyEl = statusBox.createEl("div", { cls: "notient-settings-index-readonly" });
      const infoIcon = readonlyEl.createSpan({ cls: "notient-settings-icon-inline" });
      setIcon(infoIcon, "lock");
      readonlyEl.createSpan({ text: "External index - search only, no modifications" });
    }
  }

  private renderIndexOperations(
    section: HTMLElement,
    indexManager: IndexManagerInterface,
    stats: Awaited<ReturnType<IndexManagerInterface["getStats"]>>,
  ): void {
    const opsSection = section.createDiv({ cls: "notient-settings-ops-section" });
    opsSection.createEl("h4", { text: "Index Operations" });

    const opsGrid = opsSection.createDiv({ cls: "notient-settings-ops-grid" });
    const anyOpInProgress = this.operationInProgress.type !== null;

    // 1. Sync/Rescan - Index new and modified notes
    this.renderOpButton(opsGrid, {
      icon: "refresh-cw",
      label: "Sync",
      description: "Index new and modified notes",
      disabled: anyOpInProgress,
      onClick: () => {
        (
          this.app as App & { commands: { executeCommandById: (id: string) => void } }
        ).commands.executeCommandById("notient:reindex-vault");
      },
    });

    // 2. Expand - Add only new notes (skip modified)
    this.renderOpButton(opsGrid, {
      icon: "plus-circle",
      label: "Expand",
      description: "Add new notes only",
      disabled: anyOpInProgress,
      onClick: () => {
        (
          this.app as App & { commands: { executeCommandById: (id: string) => void } }
        ).commands.executeCommandById("notient:reindex-vault");
      },
    });

    // 3. Trim - Remove deleted notes
    const isTrimming = this.operationInProgress.type === "trim";
    this.renderOpButton(opsGrid, {
      icon: "scissors",
      label: isTrimming ? "Trimming..." : "Trim",
      description: "Remove deleted note entries",
      disabled: anyOpInProgress,
      loading: isTrimming,
      onClick: async () => {
        try {
          this.operationInProgress = { type: "trim" };
          this.onRefresh();
          const result = await indexManager.trimIndex();
          this.kernel.obsidian.notice(`Removed ${result.removed} stale entries`);
          indexManager.clearDiscoveryCache?.();
        } catch (error) {
          this.kernel.obsidian.notice(`Trim failed: ${error}`);
        } finally {
          this.operationInProgress = { type: null };
          this.onRefresh();
        }
      },
    });

    // 4. Export
    const isExporting = this.operationInProgress.type === "export";
    this.renderOpButton(opsGrid, {
      icon: "download",
      label: isExporting ? "Exporting..." : "Export",
      description: "Download index backup",
      disabled: anyOpInProgress,
      loading: isExporting,
      onClick: async () => {
        try {
          this.operationInProgress = { type: "export" };
          this.onRefresh();
          const json = await indexManager.exportIndex();
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `notient-index-${stats.modelKey}-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          this.kernel.obsidian.notice("Index exported");
        } catch (error) {
          this.kernel.obsidian.notice(`Export failed: ${error}`);
        } finally {
          this.operationInProgress = { type: null };
          this.onRefresh();
        }
      },
    });
  }

  private renderOpButton(
    container: HTMLElement,
    opts: {
      icon: string;
      label: string;
      description: string;
      disabled: boolean;
      loading?: boolean;
      warning?: boolean;
      onClick: () => void | Promise<void>;
    },
  ): void {
    const btn = container.createEl("button", {
      cls: `notient-settings-op-btn ${opts.warning ? "mod-warning" : ""} ${opts.loading ? "loading" : ""}`,
    });
    btn.disabled = opts.disabled;

    const iconEl = btn.createSpan({ cls: "notient-settings-op-icon" });
    setIcon(iconEl, opts.loading ? "loader-2" : opts.icon);
    if (opts.loading) iconEl.addClass("spinning");

    btn.createEl("span", { text: opts.label, cls: "notient-settings-op-label" });
    btn.createEl("span", { text: opts.description, cls: "notient-settings-op-desc" });

    if (!opts.disabled) {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await opts.onClick();
      });
    }
  }

  private renderIndexInventory(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const inventorySection = section.createDiv({ cls: "notient-settings-inventory-section" });
    inventorySection.createEl("h4", { text: "Available Indices" });

    const loadingEl = inventorySection.createDiv({
      text: "Loading...",
      cls: "notient-settings-info-dim",
    });

    this.loadInventory(inventorySection, loadingEl, indexManager);
  }

  private async loadInventory(
    container: HTMLElement,
    loadingEl: HTMLElement,
    indexManager: IndexManagerInterface,
  ): Promise<void> {
    try {
      const indices = await indexManager.discoverIndices();
      const activePath = this.settings.indexing.activeIndexPath;
      const currentDim = indexManager.getDimension();

      loadingEl.remove();

      if (indices.length === 0) {
        container.createDiv({ text: "No indices found.", cls: "notient-settings-info-dim" });
        return;
      }

      const table = container.createEl("table", { cls: "notient-settings-index-table" });

      // Header
      const thead = table.createEl("thead");
      const headerRow = thead.createEl("tr");
      headerRow.createEl("th", { text: "Model" });
      headerRow.createEl("th", { text: "Stats" });
      headerRow.createEl("th", { text: "Source" });
      headerRow.createEl("th", { text: "Actions" });

      // Body
      const tbody = table.createEl("tbody");

      // Sort: active first, then by date
      const sortedIndices = [...indices].sort((a, b) => {
        const aActive = a.path === activePath;
        const bActive = b.path === activePath;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        const aTime = a.createdAt?.getTime() ?? 0;
        const bTime = b.createdAt?.getTime() ?? 0;
        return bTime - aTime;
      });

      for (const idx of sortedIndices) {
        this.renderInventoryRow(tbody, idx, activePath, currentDim, indexManager);
      }
    } catch (error) {
      loadingEl.textContent = `Error: ${error}`;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inventory Row Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Render model cell with active indicator and warnings */
  private renderModelCell(
    cell: HTMLElement,
    idx: IndexInfo,
    isActive: boolean,
    isCompatible: boolean,
    currentDim: number,
  ): void {
    if (isActive) cell.createSpan({ cls: "notient-settings-active-dot", text: "●" });
    cell.createSpan({ text: idx.displayName });
    if (!isCompatible && !isActive) {
      const warnIcon = cell.createSpan({ cls: "notient-settings-warn-icon" });
      setIcon(warnIcon, "alert-triangle");
      warnIcon.title = `Dimension mismatch (needs ${currentDim}d)`;
    }
  }

  /** Render action buttons for a row */
  private renderActionButtons(
    cell: HTMLElement,
    idx: IndexInfo,
    isCompatible: boolean,
    anyOpInProgress: boolean,
    indexManager: IndexManagerInterface,
  ): void {
    const isSwitching =
      this.operationInProgress.type === "switch" && this.operationInProgress.path === idx.path;
    const switchBtn = cell.createEl("button", {
      cls: "notient-settings-action-btn-small",
      text: isSwitching ? "..." : "Use",
    });
    switchBtn.disabled = !isCompatible || anyOpInProgress;
    if (!isCompatible) switchBtn.title = "Dimension mismatch";
    if (!anyOpInProgress && isCompatible) {
      switchBtn.addEventListener("click", async () => {
        this.operationInProgress = { type: "switch", path: idx.path };
        this.onRefresh();
        try {
          await indexManager.switchToIndex(idx.path);
        } finally {
          this.operationInProgress = { type: null };
        }
      });
    }

    if (idx.source !== "vault") {
      const isDeleting =
        this.operationInProgress.type === "delete" && this.operationInProgress.path === idx.path;
      const delBtn = cell.createEl("button", {
        cls: "notient-settings-action-btn-small mod-warning",
        text: isDeleting ? "..." : "Delete",
      });
      delBtn.disabled = anyOpInProgress;
      if (!anyOpInProgress) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Delete index "${idx.displayName}"?`)) return;
          this.operationInProgress = { type: "delete", path: idx.path };
          this.onRefresh();
          try {
            await indexManager.deleteIndexByPath(idx.path);
            this.kernel.obsidian.notice(`Deleted ${idx.displayName}`);
          } finally {
            this.operationInProgress = { type: null };
            this.onRefresh();
          }
        });
      }
    }
  }

  private renderInventoryRow(
    tbody: HTMLElement,
    idx: IndexInfo,
    activePath: string | null,
    currentDim: number,
    indexManager: IndexManagerInterface,
  ): void {
    const isActive = idx.path === activePath;
    const isCompatible = idx.dimension === currentDim;
    const isExternal = idx.source === "vault";
    const anyOpInProgress = this.operationInProgress.type !== null;

    const row = tbody.createEl("tr", { cls: isActive ? "active" : "" });

    // Model column
    this.renderModelCell(row.createEl("td"), idx, isActive, isCompatible, currentDim);

    // Stats column
    const statsCell = row.createEl("td");
    statsCell.createSpan({ text: `${idx.dimension}d`, cls: "notient-settings-dim-badge" });
    statsCell.createSpan({ text: ` ${idx.docCount.toLocaleString()} chunks` });

    // Source column
    row.createEl("td").createSpan({
      text: isExternal ? "Vault" : "Plugin",
      cls: `notient-settings-source-badge ${isExternal ? "external" : "plugin"}`,
    });

    // Actions column
    const actionsCell = row.createEl("td", { cls: "notient-settings-actions-cell" });
    if (!isActive) {
      this.renderActionButtons(actionsCell, idx, isCompatible, anyOpInProgress, indexManager);
    } else {
      actionsCell.createSpan({ text: "Active", cls: "notient-settings-active-label" });
    }
  }

  private renderImportSection(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const importSection = section.createDiv({ cls: "notient-settings-import-section" });
    const isImporting = this.operationInProgress.type === "import";
    const anyOpInProgress = this.operationInProgress.type !== null;

    new Setting(importSection)
      .setName("Import Index")
      .setDesc("Load an index from a backup file")
      .addButton((btn) => {
        btn.setDisabled(anyOpInProgress);
        btn.setButtonText(isImporting ? "Importing..." : "Import");
        btn.setIcon("upload");

        if (!anyOpInProgress) {
          btn.onClick(() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json";
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              try {
                this.operationInProgress = { type: "import" };
                this.onRefresh();
                const text = await file.text();
                const result = await indexManager.importIndex(text);
                this.kernel.obsidian.notice(
                  `Imported ${result.noteCount} notes for ${result.modelKey}`,
                );
              } catch (error) {
                this.kernel.obsidian.notice(`Import failed: ${error}`);
              } finally {
                this.operationInProgress = { type: null };
                this.onRefresh();
              }
            };
            input.click();
          });
        }
      });
  }

  private renderDangerZone(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const dangerSection = section.createDiv({ cls: "notient-settings-danger-zone" });
    dangerSection.createEl("h4", { text: "Danger Zone", cls: "notient-settings-danger-header" });

    const anyOpInProgress = this.operationInProgress.type !== null;

    // Rebuild
    new Setting(dangerSection)
      .setName("Rebuild Index")
      .setDesc("Clear all data and reindex the entire vault from scratch")
      .addButton((btn) => {
        btn.setDisabled(anyOpInProgress);
        btn.setButtonText("Rebuild");
        btn.setWarning();

        if (!anyOpInProgress) {
          btn.onClick(() => {
            if (!confirm("This will delete the current index and start fresh. Continue?")) return;
            (
              this.app as App & { commands: { executeCommandById: (id: string) => void } }
            ).commands.executeCommandById("notient:full-reindex");
          });
        }
      });

    // Delete
    new Setting(dangerSection)
      .setName("Delete Index")
      .setDesc("Permanently delete the current index. You will need to rebuild.")
      .addButton((btn) => {
        btn.setDisabled(anyOpInProgress);
        btn.setButtonText("Delete All");
        btn.setWarning();

        if (!anyOpInProgress) {
          btn.onClick(async () => {
            if (!confirm("Permanently delete the current index? This cannot be undone.")) return;
            try {
              this.operationInProgress = { type: "delete" };
              this.onRefresh();
              await indexManager.clearAll();
              this.kernel.obsidian.notice("Index deleted");
            } catch (error) {
              this.kernel.obsidian.notice(`Delete failed: ${error}`);
            } finally {
              this.operationInProgress = { type: null };
              this.onRefresh();
            }
          });
        }
      });
  }
}
