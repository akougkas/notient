/**
 * IndexManagementPanel - UI for managing vector indices
 *
 * Extracted from settings.ts to reduce file complexity.
 * Handles index discovery, switching, export/import, and maintenance operations.
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
}

export class IndexManagementPanel {
  private expandedPath: string | null = null;
  // Cache discovered indices to avoid repeated filesystem scans
  private cachedIndices: IndexInfo[] | null = null;
  private cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 30000; // 30 seconds

  // Track in-progress operations to maintain button state across re-renders
  private operationInProgress: {
    type: "switch" | "trim" | "delete" | "import" | null;
    path?: string; // For operations on specific indices
  } = { type: null };

  constructor(
    private app: App,
    private kernel: Kernel,
    private settings: NotientSettings,
    private onRefresh: () => void,
  ) {}

  /**
   * Clear the indices cache (call when index operations are performed)
   */
  clearCache(): void {
    this.cachedIndices = null;
    this.cacheTimestamp = 0;
  }

  render(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({
      cls: "notient-settings-section notient-index-management",
    });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "database");
    header.createSpan({ text: "Index Management" });

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

    this.renderCurrentStatus(section, indexManager);
    this.renderIndexGrid(section, indexManager);
    this.renderImportSection(section, indexManager);
  }

  private renderNotReady(section: HTMLElement): void {
    const infoBox = section.createDiv({ cls: "notient-settings-info-box" });
    infoBox.createEl("div", {
      text: this.kernel.isServicesInitializing
        ? "⏳ Services initializing..."
        : "⚠️ Services not ready - complete setup wizard first",
      cls: "notient-settings-info-dim",
    });
  }

  private renderCurrentStatus(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const activeKey = indexManager.getActiveModelKey();
    const noteCount = indexManager.getIndexedCount();
    const currentDim = indexManager.getDimension();
    const isUserProvided = indexManager.isReadOnly();

    const statusBox = section.createDiv({ cls: "notient-settings-status-box" });
    const statusRow = statusBox.createDiv({ cls: "notient-settings-status-row" });

    const modelEl = statusRow.createEl("span", { cls: "notient-settings-index-model" });
    const keyIcon = modelEl.createSpan({ cls: "notient-settings-icon-inline" });
    setIcon(keyIcon, "key");
    modelEl.createSpan({ text: activeKey });

    statusRow.createEl("span", { text: `${currentDim}d`, cls: "notient-settings-index-dim" });
    statusRow.createEl("span", {
      text: isUserProvided ? "External (Read-Only)" : "Plugin Managed",
      cls: `notient-settings-badge ${isUserProvided ? "external" : "plugin"}`,
    });

    const statsEl = statusBox.createEl("div", {
      cls: "notient-settings-info-dim notient-settings-stats",
    });
    const statsIcon = statsEl.createSpan({ cls: "notient-settings-icon-inline" });
    setIcon(statsIcon, "bar-chart-2");
    statsEl.createSpan({ text: `${noteCount} notes indexed` });

    if (isUserProvided) {
      const readonlyEl = statusBox.createEl("div", { cls: "notient-settings-index-readonly" });
      const infoIcon = readonlyEl.createSpan({ cls: "notient-settings-icon-inline" });
      setIcon(infoIcon, "info");
      readonlyEl.createSpan({
        text: "External indices are read-only. Sync, Trim, and Rebuild operations are disabled.",
      });
    }
  }

  private renderIndexGrid(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const currentDim = indexManager.getDimension();
    const gridContainer = section.createDiv({ cls: "notient-settings-index-grid" });
    gridContainer.createEl("h4", { text: "Available Indices" });

    const loadingEl = gridContainer.createDiv({
      text: "Loading indices...",
      cls: "notient-settings-info-dim",
    });

    this.loadAndRenderIndices(gridContainer, loadingEl, indexManager, currentDim);
  }

  private async loadAndRenderIndices(
    gridContainer: HTMLElement,
    loadingEl: HTMLElement,
    indexManager: IndexManagerInterface,
    currentDim: number,
  ): Promise<void> {
    try {
      // Use cached indices if available and not expired
      const now = Date.now();
      let indices: IndexInfo[];
      if (this.cachedIndices && now - this.cacheTimestamp < IndexManagementPanel.CACHE_TTL_MS) {
        indices = this.cachedIndices;
      } else {
        indices = await indexManager.discoverIndices();
        this.cachedIndices = indices;
        this.cacheTimestamp = now;
      }
      const activePath = this.settings.indexing.activeIndexPath;

      loadingEl.remove();

      if (indices.length === 0) {
        gridContainer.createDiv({ text: "No indices found.", cls: "notient-settings-info-dim" });
        return;
      }

      // Move active index to top
      const sortedIndices = [...indices].sort((a, b) => {
        const aActive = a.path === activePath;
        const bActive = b.path === activePath;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return 0;
      });

      for (const idx of sortedIndices) {
        this.renderIndexRow(gridContainer, idx, activePath, currentDim, indexManager);
      }
    } catch (error) {
      loadingEl.textContent = `Error loading indices: ${error}`;
    }
  }

  private renderIndexRow(
    gridContainer: HTMLElement,
    idx: IndexInfo,
    activePath: string | null,
    currentDim: number,
    indexManager: IndexManagerInterface,
  ): void {
    const isActive = idx.path === activePath;
    const isCompatible = idx.dimension === currentDim;
    const isExternal = idx.source === "vault";

    const createdStr = idx.createdAt
      ? idx.createdAt.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Unknown";
    const updatedStr = idx.updatedAt
      ? idx.updatedAt.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Never";

    const rowContainer = gridContainer.createDiv({ cls: "notient-settings-index-row-container" });
    const row = rowContainer.createDiv({
      cls: `notient-settings-index-row ${isActive ? "active" : ""} ${this.expandedPath === idx.path ? "expanded" : ""}`,
    });

    // Left side: model info
    const left = row.createDiv({ cls: "notient-settings-index-left" });

    if (isActive) {
      left.createEl("span", { text: "●", cls: "notient-settings-index-active-dot" });
    }

    left.createEl("span", { text: idx.displayName, cls: "notient-settings-index-model" });
    left.createEl("span", { text: `${idx.dimension}d`, cls: "notient-settings-index-dim" });
    left.createEl("span", { text: `${idx.docCount} chunks`, cls: "notient-settings-index-count" });

    if (!isCompatible && !isActive) {
      const warnIcon = left.createEl("span", {
        cls: "notient-settings-index-warn-icon",
        attr: { title: `Dimension mismatch (needs ${currentDim}d)` },
      });
      setIcon(warnIcon, "alert-triangle");
    }

    if (idx.isLegacy) {
      const legacyIcon = left.createEl("span", {
        cls: "notient-settings-index-legacy",
        attr: { title: "Legacy format - will be migrated on next save" },
      });
      setIcon(legacyIcon, "refresh-cw");
    }

    // Right side: badges
    const right = row.createDiv({ cls: "notient-settings-index-right" });

    right.createEl("span", {
      text: isExternal ? "External" : "Plugin",
      cls: `notient-settings-badge ${isExternal ? "external" : "plugin"}`,
    });

    if (isActive) {
      right.createEl("span", { text: "✓ Active", cls: "notient-settings-index-active-badge" });
    }

    const expandIcon = right.createEl("span", { cls: "notient-settings-index-expand" });
    setIcon(expandIcon, this.expandedPath === idx.path ? "chevron-up" : "chevron-down");

    // Details panel
    const details = rowContainer.createDiv({
      cls: `notient-settings-index-details ${this.expandedPath === idx.path ? "" : "hidden"}`,
    });

    // Click to expand/collapse
    row.addEventListener("click", () => {
      this.expandedPath = this.expandedPath === idx.path ? null : idx.path;
      this.onRefresh();
    });

    // Render details if expanded
    if (this.expandedPath === idx.path) {
      this.renderIndexDetails(
        details,
        idx,
        isActive,
        isCompatible,
        isExternal,
        currentDim,
        createdStr,
        updatedStr,
        indexManager,
      );
    }
  }

  private renderIndexDetails(
    details: HTMLElement,
    idx: IndexInfo,
    isActive: boolean,
    isCompatible: boolean,
    isExternal: boolean,
    currentDim: number,
    createdStr: string,
    updatedStr: string,
    indexManager: IndexManagerInterface,
  ): void {
    const metaGrid = details.createDiv({ cls: "notient-settings-index-meta-grid" });
    metaGrid.createEl("div", { text: `Created: ${createdStr}` });
    metaGrid.createEl("div", { text: `Updated: ${updatedStr}` });
    if (idx.vaultHash) {
      metaGrid.createEl("div", { text: `Vault: ${idx.vaultHash}` });
    }
    metaGrid.createEl("div", { text: `Model: ${idx.modelKey}` });
    details.createEl("div", { text: `Path: ${idx.path}`, cls: "notient-settings-index-path" });

    const btnRow = details.createDiv({ cls: "notient-settings-btn-row" });

    // Switch button (for non-active)
    if (!isActive) {
      const isSwitchingThis =
        this.operationInProgress.type === "switch" && this.operationInProgress.path === idx.path;
      const switchBtn = btnRow.createEl("button", {
        cls: "mod-cta",
        text: isSwitchingThis ? "Switching..." : "Switch To",
      });
      if (!isCompatible) {
        switchBtn.disabled = true;
        switchBtn.title = `Dimension mismatch: Index is ${idx.dimension}d, current model is ${currentDim}d`;
        switchBtn.classList.add("mod-muted");
      } else if (isSwitchingThis || this.operationInProgress.type !== null) {
        switchBtn.disabled = true;
      } else {
        switchBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            this.operationInProgress = { type: "switch", path: idx.path };
            switchBtn.disabled = true;
            switchBtn.textContent = "Switching...";
            await indexManager.switchToIndex(idx.path);
            this.kernel.obsidian.notice(`Switched to index: ${idx.modelKey}`);
            this.clearCache();
          } catch (error) {
            console.error("[IndexManagementPanel] Failed to switch index:", error);
            this.kernel.obsidian.notice(
              `Failed to switch index: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            this.operationInProgress = { type: null };
            this.onRefresh();
          }
        });
      }
    }

    // Write operations - only for plugin indices
    if (!isExternal) {
      if (isActive) {
        this.renderActiveIndexActions(btnRow, indexManager);
      } else {
        this.renderInactiveIndexActions(btnRow, idx, indexManager);
      }
    } else {
      const readonlyEl = details.createEl("div", { cls: "notient-settings-index-readonly" });
      const lockIcon = readonlyEl.createSpan({ cls: "notient-settings-icon-inline" });
      setIcon(lockIcon, "lock");
      readonlyEl.createSpan({ text: "External indices are read-only (search only)" });
    }

    // Export (available for all)
    this.renderExportButton(btnRow, idx, isActive, indexManager);
  }

  private renderActiveIndexActions(btnRow: HTMLElement, indexManager: IndexManagerInterface): void {
    const isTrimming = this.operationInProgress.type === "trim";
    const anyOpInProgress = this.operationInProgress.type !== null;

    // Sync button
    const syncBtn = btnRow.createEl("button", { cls: "notient-settings-action-btn" });
    const syncIcon = syncBtn.createSpan({ cls: "notient-settings-btn-icon" });
    setIcon(syncIcon, "play");
    syncBtn.createSpan({ text: "Sync" });
    if (anyOpInProgress) {
      syncBtn.disabled = true;
    } else {
      syncBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        (
          this.app as App & { commands: { executeCommandById: (id: string) => void } }
        ).commands.executeCommandById("notient:reindex-vault");
      });
    }

    // Trim button
    const trimBtn = btnRow.createEl("button", { cls: "notient-settings-action-btn" });
    if (isTrimming) {
      const spinnerIcon = trimBtn.createSpan({ cls: "notient-settings-spinner" });
      setIcon(spinnerIcon, "loader-2");
      trimBtn.createSpan({ text: "Trimming..." });
    } else {
      const trimIcon = trimBtn.createSpan({ cls: "notient-settings-btn-icon" });
      setIcon(trimIcon, "scissors");
      trimBtn.createSpan({ text: "Trim" });
    }
    if (anyOpInProgress) {
      trimBtn.disabled = true;
    } else {
      trimBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          this.operationInProgress = { type: "trim" };
          trimBtn.disabled = true;
          trimBtn.empty();
          const spinnerIcon = trimBtn.createSpan({ cls: "notient-settings-spinner" });
          setIcon(spinnerIcon, "loader-2");
          trimBtn.createSpan({ text: "Trimming..." });
          const result = await indexManager.trimIndex();
          this.kernel.obsidian.notice(`Removed ${result.removed} stale entries`);
          this.clearCache();
        } catch (error) {
          console.error("[IndexManagementPanel] Failed to trim index:", error);
          this.kernel.obsidian.notice(
            `Failed to trim index: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.operationInProgress = { type: null };
          this.onRefresh();
        }
      });
    }

    // Rebuild button
    const rebuildBtn = btnRow.createEl("button", {
      cls: "notient-settings-action-btn mod-warning",
    });
    const rebuildIcon = rebuildBtn.createSpan({ cls: "notient-settings-btn-icon" });
    setIcon(rebuildIcon, "refresh-cw");
    rebuildBtn.createSpan({ text: "Rebuild" });
    if (anyOpInProgress) {
      rebuildBtn.disabled = true;
    } else {
      rebuildBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        (
          this.app as App & { commands: { executeCommandById: (id: string) => void } }
        ).commands.executeCommandById("notient:full-reindex");
      });
    }
  }

  private renderInactiveIndexActions(
    btnRow: HTMLElement,
    idx: IndexInfo,
    indexManager: IndexManagerInterface,
  ): void {
    const isDeletingThis =
      this.operationInProgress.type === "delete" && this.operationInProgress.path === idx.path;
    const anyOpInProgress = this.operationInProgress.type !== null;

    const delBtn = btnRow.createEl("button", { cls: "notient-settings-action-btn mod-warning" });
    if (isDeletingThis) {
      const spinnerIcon = delBtn.createSpan({ cls: "notient-settings-spinner" });
      setIcon(spinnerIcon, "loader-2");
      delBtn.createSpan({ text: "Deleting..." });
    } else {
      const delIcon = delBtn.createSpan({ cls: "notient-settings-btn-icon" });
      setIcon(delIcon, "trash-2");
      delBtn.createSpan({ text: "Delete" });
    }

    if (anyOpInProgress) {
      delBtn.disabled = true;
    } else {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Permanently delete index for ${idx.modelKey}?`)) {
          try {
            this.operationInProgress = { type: "delete", path: idx.path };
            delBtn.disabled = true;
            delBtn.empty();
            const spinnerIcon = delBtn.createSpan({ cls: "notient-settings-spinner" });
            setIcon(spinnerIcon, "loader-2");
            delBtn.createSpan({ text: "Deleting..." });
            await indexManager.deleteIndexByPath(idx.path);
            this.kernel.obsidian.notice(`Deleted index: ${idx.modelKey}`);
            this.clearCache();
          } catch (error) {
            console.error("[IndexManagementPanel] Failed to delete index:", error);
            this.kernel.obsidian.notice(
              `Failed to delete index: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            this.operationInProgress = { type: null };
            this.onRefresh();
          }
        }
      });
    }
  }

  private renderExportButton(
    btnRow: HTMLElement,
    idx: IndexInfo,
    isActive: boolean,
    indexManager: IndexManagerInterface,
  ): void {
    const anyOpInProgress = this.operationInProgress.type !== null;
    const exportBtn = btnRow.createEl("button", { cls: "notient-settings-action-btn" });
    const exportIcon = exportBtn.createSpan({ cls: "notient-settings-btn-icon" });
    setIcon(exportIcon, "download");
    exportBtn.createSpan({ text: "Export" });

    if (anyOpInProgress) {
      exportBtn.disabled = true;
    } else {
      exportBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!isActive) {
          this.kernel.obsidian.notice("Switch to this index first to export it");
          return;
        }
        try {
          const json = await indexManager.exportIndex();
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `notient-index-${idx.modelKey}-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          this.kernel.obsidian.notice("Index exported");
        } catch (error) {
          this.kernel.obsidian.notice(`Export failed: ${error}`);
        }
      });
    }
  }

  private renderImportSection(section: HTMLElement, indexManager: IndexManagerInterface): void {
    const importSection = section.createDiv({ cls: "notient-settings-import-section" });
    const isImporting = this.operationInProgress.type === "import";
    const anyOpInProgress = this.operationInProgress.type !== null;

    const setting = new Setting(importSection)
      .setName("Import Index")
      .setDesc("Load an index from a backup file");

    setting.addButton((btn) => {
      btn.setDisabled(anyOpInProgress);
      // Set icon manually since Setting API doesn't support it
      const buttonEl = btn.buttonEl;
      buttonEl.empty();
      buttonEl.addClass("notient-settings-action-btn");

      if (isImporting) {
        const spinnerIcon = buttonEl.createSpan({ cls: "notient-settings-spinner" });
        setIcon(spinnerIcon, "loader-2");
        buttonEl.createSpan({ text: "Importing..." });
      } else {
        const importIcon = buttonEl.createSpan({ cls: "notient-settings-btn-icon" });
        setIcon(importIcon, "upload");
        buttonEl.createSpan({ text: "Import" });
      }

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
              this.clearCache();
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
}
