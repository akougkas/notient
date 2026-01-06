/**
 * Notient Sidebar View
 * 
 * Provides semantic search and related notes panel.
 * Theme-aware using Obsidian CSS variables.
 */

import { ItemView, WorkspaceLeaf, TFile, debounce } from "obsidian";
import type { Kernel } from "../core/kernel";
import type { SearchPipeline } from "../core/search/pipeline";
import type { SearchResult, RelatedNote } from "../types/search";
import { VIEW_TYPE_SIDEBAR } from "../core/constants";
import { ParaDetector } from "../core/para/detector";

export class NotientSidebarView extends ItemView {
  private searchInput: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private relatedContainer: HTMLElement | null = null;
  private statusContainer: HTMLElement | null = null;
  private currentNotePath: string | null = null;
  private paraDetector: ParaDetector;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel
  ) {
    super(leaf);
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  /**
   * Get search pipeline dynamically from kernel (lazy resolution)
   */
  private getSearchPipeline(): SearchPipeline | null {
    return this.kernel.getService<SearchPipeline>("search");
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getDisplayText(): string {
    return "Notient";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("notient-sidebar");

    // Header with status
    this.statusContainer = container.createDiv({ cls: "notient-status" });
    this.renderStatus();

    // Search section
    const searchSection = container.createDiv({ cls: "notient-search-section" });
    this.renderSearchInput(searchSection);
    this.resultsContainer = searchSection.createDiv({ cls: "notient-results" });

    // Related notes section
    const relatedSection = container.createDiv({ cls: "notient-related-section" });
    relatedSection.createEl("h4", { text: "Related Notes" });
    this.relatedContainer = relatedSection.createDiv({ cls: "notient-related" });

    // Subscribe to events
    this.registerEvents();

    // Initial update
    this.onActiveFileChange(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    // Cleanup handled by Obsidian
  }

  private renderStatus(): void {
    if (!this.statusContainer) return;
    this.statusContainer.empty();

    const health = this.kernel.serviceHealth;
    const caps = this.kernel.capabilities;

    // Status badges
    const badges = this.statusContainer.createDiv({ cls: "notient-badges" });
    
    this.createBadge(badges, "Ollama", health.ollama.status);
    this.createBadge(badges, "LM Studio", health.lmstudio.status);
    
    if (!caps.search) {
      const warning = this.statusContainer.createDiv({ cls: "notient-warning" });
      warning.setText("Search unavailable - Ollama must be running");
    }
  }

  private createBadge(container: HTMLElement, name: string, status: string): void {
    const badge = container.createSpan({ cls: `notient-badge status-${status}` });
    badge.setText(`${name}: ${status}`);
  }

  private renderSearchInput(container: HTMLElement): void {
    const inputWrapper = container.createDiv({ cls: "notient-search-wrapper" });
    
    this.searchInput = inputWrapper.createEl("input", {
      type: "text",
      placeholder: "Search your vault semantically...",
      cls: "notient-search-input",
    });

    // Debounced search
    const debouncedSearch = debounce(
      async (query: string) => {
        if (query.length >= 2) {
          await this.performSearch(query);
        } else {
          this.clearResults();
        }
      },
      300,
      true
    );

    this.searchInput.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value;
      debouncedSearch(query);
    });

    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.searchInput!.value = "";
        this.clearResults();
      }
    });
  }

  private async performSearch(query: string): Promise<void> {
    if (!this.resultsContainer) return;

    const searchPipeline = this.getSearchPipeline();
    
    if (!searchPipeline || !this.kernel.capabilities.search) {
      this.resultsContainer.empty();
      const isInitializing = this.kernel.isServicesInitializing;
      this.resultsContainer.createDiv({
        cls: "notient-message",
        text: isInitializing 
          ? "Initializing services... please wait"
          : "Search unavailable. Complete setup first or check that Ollama is running.",
      });
      return;
    }

    this.resultsContainer.empty();
    const loadingEl = this.resultsContainer.createDiv({
      cls: "notient-loading",
    });
    loadingEl.createSpan({ cls: "notient-spinner" });
    loadingEl.createSpan({ text: " Searching...", cls: "notient-loading-text" });

    try {
      const results = await searchPipeline.search(query, { topK: 10 });
      this.renderSearchResults(results);
    } catch (error) {
      console.error("[Sidebar] Search error:", error);
      this.resultsContainer.empty();
      this.resultsContainer.createDiv({
        cls: "notient-error",
        text: "Search failed. Please try again.",
      });
    }
  }

  private renderSearchResults(results: SearchResult[]): void {
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    if (results.length === 0) {
      this.resultsContainer.createDiv({
        cls: "notient-message",
        text: "No results found",
      });
      return;
    }

    for (const result of results) {
      const item = this.resultsContainer.createDiv({ cls: "notient-result-item" });
      item.addEventListener("click", () => this.openFile(result.path));

      // Title and score
      const header = item.createDiv({ cls: "notient-result-header" });
      
      const icon = header.createSpan({ cls: "notient-para-icon" });
      icon.setText(ParaDetector.getIcon(result.paraType));
      
      const title = header.createSpan({ cls: "notient-result-title" });
      title.setText(result.title);
      
      const score = header.createSpan({ cls: "notient-result-score" });
      score.setText(`${Math.round(result.bestScore * 100)}%`);

      // Path
      const path = item.createDiv({ cls: "notient-result-path" });
      path.setText(result.path);

      // Best matching chunk preview
      if (result.chunks.length > 0 && result.chunks[0].text) {
        const preview = item.createDiv({ cls: "notient-result-preview" });
        const text = result.chunks[0].text;
        preview.setText(text.length > 150 ? text.slice(0, 150) + "..." : text);
      }
    }
  }

  private clearResults(): void {
    if (this.resultsContainer) {
      this.resultsContainer.empty();
    }
  }

  private async onActiveFileChange(file: TFile | null): Promise<void> {
    this.currentNotePath = file?.path ?? null;
    await this.updateRelatedNotes();
  }

  private async updateRelatedNotes(): Promise<void> {
    if (!this.relatedContainer) return;
    this.relatedContainer.empty();

    if (!this.currentNotePath) {
      this.relatedContainer.createDiv({
        cls: "notient-message",
        text: "Open a note to see related content",
      });
      return;
    }

    const searchPipeline = this.getSearchPipeline();
    
    if (!searchPipeline || !this.kernel.capabilities.search) {
      const isInitializing = this.kernel.isServicesInitializing;
      this.relatedContainer.createDiv({
        cls: "notient-message",
        text: isInitializing
          ? "Initializing services... please wait"
          : "Related notes unavailable - complete setup first",
      });
      return;
    }

    this.relatedContainer.createDiv({
      cls: "notient-loading",
    }).innerHTML = '<span class="notient-spinner"></span><span class="notient-loading-text"> Finding related notes...</span>';

    try {
      const related = await searchPipeline.findRelated(this.currentNotePath);
      this.renderRelatedNotes(related);
    } catch (error) {
      console.error("[Sidebar] Related notes error:", error);
      this.relatedContainer.empty();
      this.relatedContainer.createDiv({
        cls: "notient-message",
        text: "Could not find related notes",
      });
    }
  }

  private renderRelatedNotes(notes: RelatedNote[]): void {
    if (!this.relatedContainer) return;
    this.relatedContainer.empty();

    if (notes.length === 0) {
      this.relatedContainer.createDiv({
        cls: "notient-message",
        text: "No related notes found",
      });
      return;
    }

    for (const note of notes) {
      const item = this.relatedContainer.createDiv({ cls: "notient-related-item" });
      item.addEventListener("click", () => this.openFile(note.path));

      // Header with icon and title
      const header = item.createDiv({ cls: "notient-related-header" });
      
      const icon = header.createSpan({ cls: "notient-para-icon" });
      icon.setText(ParaDetector.getIcon(note.paraType));
      
      const title = header.createSpan({ cls: "notient-related-title" });
      title.setText(note.title);

      // Metadata
      const meta = item.createDiv({ cls: "notient-related-meta" });
      
      if (note.hasDirectLink) {
        const linkBadge = meta.createSpan({ cls: "notient-badge-link" });
        linkBadge.setText("🔗 Linked");
      }
      
      if (note.sharedTags.length > 0) {
        const tagBadge = meta.createSpan({ cls: "notient-badge-tags" });
        tagBadge.setText(`#${note.sharedTags.join(" #")}`);
      }

      const score = meta.createSpan({ cls: "notient-related-score" });
      score.setText(`${Math.round(note.score * 100)}% similar`);
    }
  }

  private registerEvents(): void {
    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        this.onActiveFileChange(file);
      })
    );

    // Listen for health changes
    const unsubHealth = this.kernel.eventBus.on("health:changed", () => {
      this.renderStatus();
      // Re-check related notes when services become available
      this.updateRelatedNotes();
    });
    this.register(() => unsubHealth());

    // Listen for services initialized
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.renderStatus();
      this.updateRelatedNotes();
    });
    this.register(() => unsubServices());

    // Listen for index progress
    const unsubIndex = this.kernel.eventBus.on("index:progress", ({ progress }) => {
      if (progress.phase !== "idle" && progress.phase !== "complete") {
        this.renderIndexingProgress(progress);
      }
    });
    this.register(() => unsubIndex());
  }

  private renderIndexingProgress(progress: { current: string | null; completed: number; total: number }): void {
    if (!this.statusContainer) return;
    
    // Find or create progress element
    let progressEl = this.statusContainer.querySelector(".notient-index-progress") as HTMLElement;
    if (!progressEl) {
      progressEl = this.statusContainer.createDiv({ cls: "notient-index-progress" });
    }

    const pct = progress.total > 0 
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;
    
    progressEl.innerHTML = `
      <div class="notient-progress-bar">
        <div class="notient-progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="notient-progress-text">Indexing: ${progress.completed}/${progress.total}</div>
    `;
  }

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }
}
