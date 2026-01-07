/**
 * SidebarFooter - Footer with index status and service health
 *
 * Extracted from sidebar.ts for modularity.
 */

import { setIcon } from "obsidian";
import type { IndexProgress } from "../../../types/indexer";
import type { NotientSettings } from "../../../types/settings";

export interface ServiceHealth {
  ollama: { status: string };
  lmstudio: { status: string };
}

export interface IndexManagerStats {
  getIndexedCount(): number;
  getActiveModelKey(): string;
  getDimension(): number;
  isReadOnly(): boolean;
}

export class SidebarFooter {
  private footerProgressEl: HTMLElement | null = null;
  private footerStatsEl: HTMLElement | null = null;
  private lastSyncTime: Date | null = null;

  constructor(
    private settings: NotientSettings,
    private serviceHealth: ServiceHealth,
    private openSettings: () => void,
  ) {}

  render(container: HTMLElement, indexManager: IndexManagerStats | null): HTMLElement {
    const footer = container.createDiv({ cls: "nv2-footer" });

    // Progress Bar (hidden by default)
    this.footerProgressEl = footer.createDiv({ cls: "nv2-index-progress nv2-hidden" });

    // Index Status Row
    const indexRow = footer.createDiv({ cls: "nv2-footer-index-row" });
    this.footerStatsEl = indexRow;
    this.updateStats(indexManager);

    // Service Status Row
    this.renderServiceStatus(footer);

    // Settings button
    this.renderSettingsButton(footer);

    return footer;
  }

  updateStats(indexManager: IndexManagerStats | null): void {
    if (!this.footerStatsEl) return;
    this.footerStatsEl.empty();

    if (!indexManager) {
      this.footerStatsEl.createSpan({ text: "Index: Not Ready", cls: "nv2-footer-index-label" });
      return;
    }

    const count = indexManager.getIndexedCount();
    const model = indexManager.getActiveModelKey() || "No Index";
    const dimension = indexManager.getDimension();
    const isReadOnly = indexManager.isReadOnly();

    // Determine source
    const activePath = this.settings.indexing.activeIndexPath;
    const isSystem = !!(activePath && activePath.includes("system/index"));

    // Index icon + model name
    const indexInfo = this.footerStatsEl.createDiv({ cls: "nv2-footer-index-info" });
    const iconEl = indexInfo.createDiv({ cls: "nv2-footer-index-icon" });
    setIcon(iconEl, "database");

    // Model name (truncated if long)
    const modelDisplay = model.length > 20 ? model.slice(0, 18) + "…" : model;
    indexInfo.createSpan({ text: modelDisplay, cls: "nv2-footer-index-model" });

    // Dimension badge
    if (dimension > 0) {
      indexInfo.createSpan({ text: `${dimension}d`, cls: "nv2-footer-index-dim" });
    }

    // Note count
    indexInfo.createSpan({ text: `${count}`, cls: "nv2-footer-index-count" });
    indexInfo.createSpan({ text: "notes", cls: "nv2-footer-index-label" });

    // Source badge
    const sourceBadge = this.footerStatsEl.createDiv({
      cls: `nv2-footer-badge ${isSystem ? "nv2-footer-badge--system" : "nv2-footer-badge--plugin"}`,
    });
    sourceBadge.setText(isSystem ? "🔒" : "⚙️");
    sourceBadge.setAttr("title", isSystem ? "External Index (Read-Only)" : "Plugin Managed Index");

    // Health indicator
    const healthClass = count > 0 ? "nv2-footer-health--healthy" : "nv2-footer-health--warning";
    const healthDot = this.footerStatsEl.createDiv({ cls: `nv2-footer-health ${healthClass}` });
    healthDot.setAttr("title", count > 0 ? "Index healthy" : "Index empty - needs sync");

    // Sync time
    if (this.lastSyncTime) {
      const time = this.lastSyncTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.footerStatsEl.createSpan({ text: `↻${time}`, cls: "nv2-footer-sync" });
    }

    // Tooltip
    this.buildTooltip(model, dimension, count, isSystem, activePath);
  }

  private buildTooltip(model: string, dimension: number, count: number, isSystem: boolean, activePath: string | null): void {
    if (!this.footerStatsEl) return;

    const tooltipLines = [
      `Model: ${model}`,
      `Dimensions: ${dimension}`,
      `Indexed: ${count} notes`,
      `Source: ${isSystem ? "External (Read Only)" : "Plugin Managed"}`,
    ];
    if (this.lastSyncTime) {
      tooltipLines.push(`Last Sync: ${this.lastSyncTime.toLocaleString()}`);
    }
    if (activePath) {
      const pathMatch = activePath.match(/idx_(\d{4})(\d{2})(\d{2})T/);
      if (pathMatch) {
        const [, y, m, d] = pathMatch;
        tooltipLines.push(`Created: ${m}/${d}/${y}`);
      }
    }
    this.footerStatsEl.setAttr("title", tooltipLines.join("\n"));
  }

  private renderServiceStatus(footer: HTMLElement): void {
    const serviceRow = footer.createDiv({ cls: "nv2-footer-services" });

    // Ollama status
    const ollamaEl = serviceRow.createDiv({ cls: "nv2-footer-service-compact" });
    ollamaEl.createDiv({
      cls: `nv2-footer-dot ${this.serviceHealth.ollama.status === "healthy" ? "nv2-footer-dot--healthy" : "nv2-footer-dot--error"}`,
    });
    ollamaEl.createSpan({ text: "Embed", cls: "nv2-footer-service-label" });

    // LM Studio status
    const lmEl = serviceRow.createDiv({ cls: "nv2-footer-service-compact" });
    lmEl.createDiv({
      cls: `nv2-footer-dot ${this.serviceHealth.lmstudio.status === "healthy" ? "nv2-footer-dot--healthy" : "nv2-footer-dot--error"}`,
    });
    lmEl.createSpan({ text: "Chat", cls: "nv2-footer-service-label" });
  }

  private renderSettingsButton(footer: HTMLElement): void {
    const settingsBtn = footer.createEl("button", { cls: "nv2-footer-settings" });
    settingsBtn.setAttr("aria-label", "Open Notient settings");
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", this.openSettings);
  }

  updateProgress(progress: IndexProgress): void {
    if (!this.footerProgressEl) return;

    if (progress.phase === "idle" || progress.phase === "complete") {
      this.footerProgressEl.addClass("nv2-hidden");
      if (progress.phase === "complete") {
        this.lastSyncTime = new Date();
      }
      return;
    }

    this.footerProgressEl.removeClass("nv2-hidden");
    this.footerProgressEl.empty();

    // Progress bar
    const bar = this.footerProgressEl.createDiv({ cls: "nv2-progress-bar" });
    const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

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

  setLastSyncTime(time: Date): void {
    this.lastSyncTime = time;
  }
}
