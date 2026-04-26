/**
 * Power-user surface for Notient's universal undo. Lists the most
 * recent history rows with kind, target, timestamp, and a one-click
 * Undo button. Each successful undo refreshes the list.
 */

import { type App, Modal, Notice } from "obsidian";
import type { HistoryService } from "../../core/history/historyService";
import type { HistoryRow } from "../../core/history/types";

export interface HistoryModalOptions {
  service: HistoryService;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

export class HistoryModal extends Modal {
  private readonly service: HistoryService;
  private readonly limit: number;

  constructor(app: App, options: HistoryModalOptions) {
    super(app);
    this.service = options.service;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-history-modal");
    contentEl.createEl("h2", { text: "Notient: Recent actions" });
    contentEl.createEl("p", {
      text: "Each row is a Notient mutation. Press Undo to revert it.",
      cls: "notient-history-modal__hint",
    });
    this.draw();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private draw(): void {
    const list = this.ensureListContainer();
    list.empty();
    const rows = this.service.getRecent(this.limit);
    if (rows.length === 0) {
      list.createDiv({
        cls: "notient-history-modal__empty",
        text: "No actions to undo.",
      });
      return;
    }
    for (const row of rows) {
      list.appendChild(this.renderRow(row));
    }
  }

  private renderRow(row: HistoryRow): HTMLElement {
    const card = document.createElement("div");
    card.addClass("notient-history-modal__card");

    const head = card.createDiv({ cls: "notient-history-modal__head" });
    head.createSpan({
      cls: "notient-history-modal__kind",
      text: row.kind,
    });
    head.createSpan({
      cls: "notient-history-modal__time",
      text: formatTimestamp(row.createdAt),
    });

    card.createDiv({
      cls: "notient-history-modal__target",
      text: row.target,
    });

    const actions = card.createDiv({ cls: "notient-history-modal__actions" });
    const undoButton = actions.createEl("button", {
      text: "Undo",
      cls: "notient-history-modal__undo",
    });
    undoButton.addEventListener("click", () => {
      void this.handleUndo(row.id, undoButton);
    });
    return card;
  }

  private async handleUndo(historyId: number, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const result = await this.service.undo(historyId);
    if (result.ok) {
      new Notice("Undone");
    } else {
      new Notice(`Undo failed: ${result.error ?? "unknown error"}`);
      button.disabled = false;
    }
    this.draw();
  }

  private ensureListContainer(): HTMLElement {
    const existing = this.contentEl.querySelector<HTMLElement>(".notient-history-modal__list");
    if (existing) return existing;
    return this.contentEl.createDiv({ cls: "notient-history-modal__list" });
  }
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const iso = date.toISOString();
  return iso.replace("T", " ").slice(0, 19);
}
