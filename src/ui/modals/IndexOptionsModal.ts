/**
 * Index Options Modal
 *
 * Shown after wizard completion when an existing index is detected.
 * Gives user clear choices about how to proceed.
 */

import { type App, Modal, setIcon } from "obsidian";
import type { IndexStats } from "../../services/indexManager";

export type IndexOption = "use_existing" | "resume" | "rebuild" | "cancel";

export interface IndexOptionsResult {
  option: IndexOption;
}

/**
 * Modal for choosing how to handle existing index
 */
export class IndexOptionsModal extends Modal {
  private result: IndexOptionsResult = { option: "cancel" };
  private resolvePromise: ((result: IndexOptionsResult) => void) | null = null;

  constructor(
    app: App,
    private stats: IndexStats,
    private modelChanged: boolean,
  ) {
    super(app);
  }

  /**
   * Run the modal and return the user's choice
   */
  run(): Promise<IndexOptionsResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-index-options-modal");

    // Header
    contentEl.createEl("h2", { text: "Index Options" });

    // Show current state
    this.renderStateInfo(contentEl);

    // Show options based on state
    this.renderOptions(contentEl);
  }

  private renderStateInfo(containerEl: HTMLElement): void {
    const { stats, modelChanged } = this;
    const infoBox = containerEl.createDiv({ cls: "notient-index-info" });

    if (modelChanged) {
      const modelRow = infoBox.createEl("p", { cls: "notient-index-info-model" });
      const modelIcon = modelRow.createSpan({ cls: "notient-index-info-icon" });
      setIcon(modelIcon, "pin");
      modelRow.createSpan({ text: ` Model: ${stats.modelKey}` });
    }

    // State-specific message
    switch (stats.state) {
      case "none":
        infoBox.createEl("p", { text: "No index found. Ready to create one." });
        break;

      case "complete": {
        const completeRow = infoBox.createEl("p");
        const completeIcon = completeRow.createSpan({ cls: "notient-index-info-icon" });
        setIcon(completeIcon, "check-circle");
        completeRow.createSpan({ text: ` Found complete index: ${stats.noteCount} notes, ${stats.chunkCount} passages` });
        if (stats.lastFullIndexAt) {
          const date = new Date(stats.lastFullIndexAt).toLocaleDateString();
          infoBox.createEl("p", {
            text: `Last indexed: ${date}`,
            cls: "notient-index-info-dim",
          });
        }
        break;
      }

      case "incomplete": {
        const incompleteRow = infoBox.createEl("p");
        const incompleteIcon = incompleteRow.createSpan({ cls: "notient-index-info-icon" });
        setIcon(incompleteIcon, "clock");
        incompleteRow.createSpan({ text: ` Found incomplete index: ${stats.noteCount}/${stats.vaultNoteCount} notes (${stats.completionPercent}%)` });
        infoBox.createEl("p", {
          text: `${stats.vaultNoteCount - stats.noteCount} notes remaining`,
          cls: "notient-index-info-dim",
        });
        break;
      }

      case "crashed": {
        const crashedRow = infoBox.createEl("p", { cls: "notient-index-info-warning" });
        const crashedIcon = crashedRow.createSpan({ cls: "notient-index-info-icon" });
        setIcon(crashedIcon, "alert-triangle");
        crashedRow.createSpan({ text: " Previous indexing was interrupted" });
        infoBox.createEl("p", {
          text: `${stats.noteCount}/${stats.vaultNoteCount} notes were indexed before interruption`,
          cls: "notient-index-info-dim",
        });
        break;
      }

      case "stale": {
        const staleRow = infoBox.createEl("p", { cls: "notient-index-info-warning" });
        const staleIcon = staleRow.createSpan({ cls: "notient-index-info-icon" });
        setIcon(staleIcon, "refresh-cw");
        staleRow.createSpan({ text: " Found index data but state is unclear" });
        infoBox.createEl("p", {
          text: `${stats.chunkCount} passages found. Rebuilding recommended.`,
          cls: "notient-index-info-dim",
        });
        break;
      }
    }
  }

  private renderOptions(containerEl: HTMLElement): void {
    const { stats } = this;
    const optionsDiv = containerEl.createDiv({ cls: "notient-index-options" });

    // Option buttons based on state
    switch (stats.state) {
      case "none":
        this.addOption(
          optionsDiv,
          "rebuild",
          "Start Indexing",
          "Index all notes in your vault",
          true,
          "rocket",
        );
        break;

      case "complete":
        this.addOption(
          optionsDiv,
          "use_existing",
          "Use Existing Index",
          "Keep current index, sync new changes only",
          true,
          "check-circle",
        );
        this.addOption(
          optionsDiv,
          "rebuild",
          "Rebuild From Scratch",
          "Delete and re-index everything",
          false,
          "refresh-cw",
        );
        break;

      case "incomplete":
      case "crashed":
        this.addOption(
          optionsDiv,
          "resume",
          "Resume Indexing",
          `Continue from where it stopped (${stats.completionPercent}% done)`,
          true,
          "play",
        );
        this.addOption(optionsDiv, "rebuild", "Start Fresh", "Clear and re-index everything", false, "refresh-cw");
        this.addOption(
          optionsDiv,
          "use_existing",
          "Use As-Is",
          "Keep partial index, don't index more now",
          false,
          "pause",
        );
        break;

      case "stale":
        this.addOption(
          optionsDiv,
          "rebuild",
          "Rebuild Index",
          "Clear stale data and re-index",
          true,
          "refresh-cw",
        );
        this.addOption(
          optionsDiv,
          "use_existing",
          "Try Using Anyway",
          "Attempt to use existing data",
          false,
          "help-circle",
        );
        break;
    }

    // Cancel option
    const cancelBtn = optionsDiv.createEl("button", {
      text: "Cancel",
      cls: "notient-index-option-cancel",
    });
    cancelBtn.addEventListener("click", () => {
      this.result = { option: "cancel" };
      this.close();
    });
  }

  private addOption(
    container: HTMLElement,
    option: IndexOption,
    label: string,
    description: string,
    isPrimary = false,
    icon?: string,
  ): void {
    const btn = container.createEl("button", {
      cls: `notient-index-option ${isPrimary ? "notient-index-option-primary" : ""}`,
    });

    const labelEl = btn.createEl("span", { cls: "notient-index-option-label" });
    if (icon) {
      const iconEl = labelEl.createSpan({ cls: "notient-index-option-icon" });
      setIcon(iconEl, icon);
    }
    labelEl.createSpan({ text: label });
    btn.createEl("span", { text: description, cls: "notient-index-option-desc" });

    btn.addEventListener("click", () => {
      this.result = { option };
      this.close();
    });
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }
}
