/**
 * Import Modal
 *
 * Modal for importing markdown files into the vault.
 * Provides UI for selecting source folder and previewing import.
 */

import { type App, Modal, Notice, setIcon, TFolder } from "obsidian";
import type { ImporterService, PluginImportSummary } from "../../core/importer/importerService";

export interface ImportModalResult {
  completed: boolean;
  summary?: PluginImportSummary;
}

/**
 * Modal for importing markdown files
 */
export class ImportModal extends Modal {
  private result: ImportModalResult = { completed: false };
  private resolvePromise: ((result: ImportModalResult) => void) | null = null;
  private selectedFolder: string = "";
  private outputFolder: string = "imports";
  private recursive: boolean = true;
  private isProcessing: boolean = false;

  constructor(
    app: App,
    private importerService: ImporterService
  ) {
    super(app);
  }

  /**
   * Run the modal and return the result
   */
  run(): Promise<ImportModalResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-import-modal");

    this.renderContent();
  }

  private renderContent(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    const header = contentEl.createEl("h2", { text: "Import Markdown Files" });
    const headerIcon = header.createSpan({ cls: "notient-import-header-icon" });
    setIcon(headerIcon, "file-input");

    // Description
    contentEl.createEl("p", {
      text: "Import markdown files from a folder in your vault and normalize links to Obsidian format.",
      cls: "notient-import-description",
    });

    // Form
    const form = contentEl.createDiv({ cls: "notient-import-form" });

    // Source folder picker
    this.renderFolderPicker(form);

    // Output folder input
    this.renderOutputInput(form);

    // Recursive option
    this.renderRecursiveOption(form);

    // Preview section
    this.renderPreview(form);

    // Actions
    this.renderActions(contentEl);
  }

  private renderFolderPicker(container: HTMLElement): void {
    const group = container.createDiv({ cls: "notient-import-field" });
    group.createEl("label", { text: "Source Folder" });

    const pickerRow = group.createDiv({ cls: "notient-import-picker-row" });
    
    const input = pickerRow.createEl("input", {
      type: "text",
      placeholder: "Select a folder...",
      cls: "notient-import-input",
    });
    input.value = this.selectedFolder;
    input.addEventListener("change", () => {
      this.selectedFolder = input.value;
      this.updatePreview();
    });

    const browseBtn = pickerRow.createEl("button", {
      text: "Browse",
      cls: "notient-import-browse-btn",
    });
    browseBtn.addEventListener("click", () => {
      this.showFolderDropdown(input, browseBtn);
    });
  }

  private showFolderDropdown(input: HTMLInputElement, anchor: HTMLElement): void {
    // Create dropdown
    const dropdown = document.createElement("div");
    dropdown.className = "notient-import-folder-dropdown";

    // Get all folders
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .filter((f) => f.path !== "")
      .sort((a, b) => a.path.localeCompare(b.path));

    if (folders.length === 0) {
      dropdown.createEl("div", {
        text: "No folders found",
        cls: "notient-import-folder-empty",
      });
    } else {
      for (const folder of folders) {
        const item = dropdown.createEl("div", {
          text: folder.path,
          cls: "notient-import-folder-item",
        });
        item.addEventListener("click", () => {
          this.selectedFolder = folder.path;
          input.value = folder.path;
          dropdown.remove();
          this.updatePreview();
        });
      }
    }

    // Position dropdown
    const rect = anchor.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = "300px";
    dropdown.style.maxHeight = "200px";
    dropdown.style.overflow = "auto";
    dropdown.style.zIndex = "1000";

    document.body.appendChild(dropdown);

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && e.target !== anchor) {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  }

  private renderOutputInput(container: HTMLElement): void {
    const group = container.createDiv({ cls: "notient-import-field" });
    group.createEl("label", { text: "Output Folder" });

    const input = group.createEl("input", {
      type: "text",
      placeholder: "imports",
      cls: "notient-import-input",
    });
    input.value = this.outputFolder;
    input.addEventListener("change", () => {
      this.outputFolder = input.value || "imports";
    });

    group.createEl("small", {
      text: "Files will be saved to this folder in your vault root",
      cls: "notient-import-hint",
    });
  }

  private renderRecursiveOption(container: HTMLElement): void {
    const group = container.createDiv({ cls: "notient-import-field notient-import-checkbox" });
    
    const checkbox = group.createEl("input", {
      type: "checkbox",
    });
    checkbox.id = "notient-import-recursive";
    checkbox.checked = this.recursive;
    checkbox.addEventListener("change", () => {
      this.recursive = checkbox.checked;
      this.updatePreview();
    });

    const label = group.createEl("label", { text: "Include subfolders" });
    label.htmlFor = "notient-import-recursive";
  }

  private previewEl: HTMLElement | null = null;

  private renderPreview(container: HTMLElement): void {
    const group = container.createDiv({ cls: "notient-import-preview" });
    group.createEl("label", { text: "Preview" });
    this.previewEl = group.createDiv({ cls: "notient-import-preview-content" });
    this.updatePreview();
  }

  private updatePreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();

    if (!this.selectedFolder) {
      this.previewEl.createEl("p", {
        text: "Select a source folder to see files",
        cls: "notient-import-preview-empty",
      });
      return;
    }

    // Find markdown files
    const allFiles = this.app.vault.getMarkdownFiles();
    const files = allFiles.filter((f) => {
      if (!f.path.startsWith(this.selectedFolder + "/")) return false;
      if (!this.recursive) {
        const relativePath = f.path.slice(this.selectedFolder.length + 1);
        if (relativePath.includes("/")) return false;
      }
      return true;
    });

    if (files.length === 0) {
      this.previewEl.createEl("p", {
        text: "No markdown files found in selected folder",
        cls: "notient-import-preview-empty",
      });
      return;
    }

    this.previewEl.createEl("p", {
      text: `Found ${files.length} markdown file(s)`,
      cls: "notient-import-preview-count",
    });

    const list = this.previewEl.createEl("ul", { cls: "notient-import-file-list" });
    const maxShow = 10;
    
    for (let i = 0; i < Math.min(files.length, maxShow); i++) {
      const relativePath = files[i].path.slice(this.selectedFolder.length + 1);
      list.createEl("li", { text: relativePath });
    }

    if (files.length > maxShow) {
      list.createEl("li", {
        text: `... and ${files.length - maxShow} more`,
        cls: "notient-import-more",
      });
    }
  }

  private renderActions(container: HTMLElement): void {
    const actions = container.createDiv({ cls: "notient-import-actions" });

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "notient-import-cancel-btn",
    });
    cancelBtn.addEventListener("click", () => {
      this.result = { completed: false };
      this.close();
    });

    const importBtn = actions.createEl("button", {
      text: "Import Files",
      cls: "notient-import-primary-btn",
    });
    importBtn.addEventListener("click", () => this.runImport());
  }

  private async runImport(): Promise<void> {
    if (this.isProcessing) return;
    if (!this.selectedFolder) {
      new Notice("Please select a source folder");
      return;
    }

    this.isProcessing = true;
    const { contentEl } = this;
    contentEl.empty();

    // Show progress
    contentEl.createEl("h2", { text: "Importing..." });
    const progressEl = contentEl.createDiv({ cls: "notient-import-progress" });
    progressEl.createEl("p", { text: "Processing files..." });

    try {
      const summary = await this.importerService.importFromVaultFolder(
        this.selectedFolder,
        {
          sourcePath: this.selectedFolder,
          outputFolder: this.outputFolder,
          recursive: this.recursive,
        }
      );

      this.result = { completed: true, summary };
      this.showResults(summary);
    } catch (err) {
      contentEl.empty();
      contentEl.createEl("h2", { text: "Import Failed" });
      contentEl.createEl("p", {
        text: err instanceof Error ? err.message : "Unknown error",
        cls: "notient-import-error",
      });
      
      const closeBtn = contentEl.createEl("button", { text: "Close" });
      closeBtn.addEventListener("click", () => this.close());
    }

    this.isProcessing = false;
  }

  private showResults(summary: PluginImportSummary): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    const header = contentEl.createEl("h2", { text: "Import Complete" });
    const headerIcon = header.createSpan({ cls: "notient-import-header-icon" });
    setIcon(headerIcon, "check-circle");

    // Stats
    const stats = contentEl.createDiv({ cls: "notient-import-stats" });
    
    stats.createDiv({ cls: "notient-import-stat" }).innerHTML = 
      `<span class="notient-import-stat-value">${summary.created}</span><span class="notient-import-stat-label">Created</span>`;
    
    stats.createDiv({ cls: "notient-import-stat" }).innerHTML = 
      `<span class="notient-import-stat-value">${summary.updated}</span><span class="notient-import-stat-label">Updated</span>`;
    
    stats.createDiv({ cls: "notient-import-stat" }).innerHTML = 
      `<span class="notient-import-stat-value">${summary.totalLinksConverted}</span><span class="notient-import-stat-label">Links Fixed</span>`;

    if (summary.failed > 0) {
      const failedEl = contentEl.createDiv({ cls: "notient-import-failed" });
      failedEl.createEl("p", { text: `${summary.failed} file(s) failed to import` });
      
      const failedList = failedEl.createEl("ul");
      for (const result of summary.results.filter((r) => !r.success)) {
        failedList.createEl("li", { text: `${result.sourcePath}: ${result.error}` });
      }
    }

    // Location info
    contentEl.createEl("p", {
      text: `Files saved to: ${this.outputFolder}/`,
      cls: "notient-import-location",
    });

    // Close button
    const actions = contentEl.createDiv({ cls: "notient-import-actions" });
    const closeBtn = actions.createEl("button", {
      text: "Done",
      cls: "notient-import-primary-btn",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }
}
