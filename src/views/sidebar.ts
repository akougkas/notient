/**
 * Notient Sidebar View - Comprehensive Vault Assistant
 *
 * Features:
 * - Open note context awareness (related notes, staleness, actions)
 * - Semantic search with LLM reranking
 * - Chat interface with RAG
 * - Copyable text throughout
 * - Clickable search results
 *
 * Theme-aware using Obsidian CSS variables.
 */

import { ItemView, WorkspaceLeaf, TFile, debounce, Notice } from "obsidian";
import type { Kernel } from "../core/kernel";
import type { SearchPipeline } from "../core/search/pipeline";
import type { LMStudioService, ChatMessage } from "../services/lmstudio";
import type { VaultContextBuilder } from "../core/context/vaultContextBuilder";
import type { SearchResult } from "../types/search";
import { VIEW_TYPE_SIDEBAR } from "../core/constants";
import { ParaDetector } from "../core/para/detector";

interface OpenNoteContext {
  file: TFile;
  title: string;
  path: string;
  paraType: string;
  staleness: StalenessInfo;
  frontmatter: Record<string, unknown>;
  tags: string[];
  backlinks: string[];
  outlinks: string[];
}

interface StalenessInfo {
  daysSinceModified: number;
  isIndexed: boolean;
  lastIndexed: number | null;
  status: "fresh" | "stale" | "unindexed";
}

export class NotientSidebarView extends ItemView {
  // UI elements
  private mainContainer: HTMLElement | null = null;
  private statusContainer: HTMLElement | null = null;
  private openNoteSection: HTMLElement | null = null;
  private searchPanel: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchResults: HTMLElement | null = null;
  private chatPanel: HTMLElement | null = null;
  private chatMessages: HTMLElement | null = null;
  private chatInput: HTMLTextAreaElement | null = null;

  // State
  private chatHistory: ChatMessage[] = [];
  private lastSearchResults: SearchResult[] = [];
  private currentOpenNote: OpenNoteContext | null = null;
  private paraDetector: ParaDetector;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel
  ) {
    super(leaf);
    this.paraDetector = new ParaDetector(kernel.settings);
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
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notient-sidebar");
    this.mainContainer = container;

    // Status bar
    this.statusContainer = container.createDiv({ cls: "notient-status" });
    this.renderStatus();

    // Open note section (context-aware)
    this.openNoteSection = container.createDiv({ cls: "notient-open-note-section" });

    // Search panel
    this.searchPanel = container.createDiv({ cls: "notient-search-panel" });
    this.renderSearchPanel();

    // Divider
    container.createDiv({ cls: "notient-panel-divider" });

    // Chat panel
    this.chatPanel = container.createDiv({ cls: "notient-chat-panel" });
    this.renderChatPanel();

    // Register events
    this.registerEvents();

    // Initial render of open note context
    await this.updateOpenNoteContext();
  }

  async onClose(): Promise<void> {
    this.chatHistory = [];
    this.lastSearchResults = [];
    this.currentOpenNote = null;
  }

  // ============ Service Getters ============

  private getSearchPipeline(): SearchPipeline | null {
    return this.kernel.getService<SearchPipeline>("search");
  }

  private getLMStudio(): LMStudioService | null {
    return this.kernel.getService<LMStudioService>("lmstudio");
  }

  private getContextBuilder(): VaultContextBuilder | null {
    return this.kernel.getService<VaultContextBuilder>("context");
  }

  // ============ Open Note Context ============

  private async updateOpenNoteContext(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile || activeFile.extension !== "md") {
      this.currentOpenNote = null;
      this.renderOpenNoteSection();
      return;
    }

    // Build comprehensive context for open note
    const metadata = this.app.metadataCache.getFileCache(activeFile);
    const staleness = await this.calculateStaleness(activeFile);

    // Get backlinks
    const backlinks: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[activeFile.path]) {
        backlinks.push(sourcePath);
      }
    }

    // Get outlinks
    const outlinks: string[] = [];
    const fileLinks = resolvedLinks[activeFile.path] || {};
    for (const targetPath of Object.keys(fileLinks)) {
      outlinks.push(targetPath);
    }

    // Extract tags
    const tags = metadata?.tags?.map((t) => t.tag) || [];
    const frontmatterTags = metadata?.frontmatter?.tags || [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    // Build context
    this.currentOpenNote = {
      file: activeFile,
      title: activeFile.basename,
      path: activeFile.path,
      paraType: this.paraDetector.detectType(activeFile.path),
      staleness,
      frontmatter: metadata?.frontmatter || {},
      tags: allTags,
      backlinks: backlinks.slice(0, 10),
      outlinks: outlinks.slice(0, 10),
    };

    this.renderOpenNoteSection();
  }

  private async calculateStaleness(file: TFile): Promise<StalenessInfo> {
    const now = Date.now();
    const mtime = file.stat.mtime;
    const daysSinceModified = Math.floor((now - mtime) / (1000 * 60 * 60 * 24));

    // Check if note is indexed
    const indexManager = this.kernel.getService<{
      isNoteIndexed(path: string): boolean;
      getNoteState(path: string): { embeddedAt?: number } | null;
    }>("indexManager");

    const isIndexed = indexManager?.isNoteIndexed(file.path) ?? false;
    const noteState = indexManager?.getNoteState(file.path);
    const lastIndexed = noteState?.embeddedAt || null;

    let status: StalenessInfo["status"] = "fresh";
    if (!isIndexed) {
      status = "unindexed";
    } else if (lastIndexed && mtime > lastIndexed) {
      status = "stale";
    }

    return {
      daysSinceModified,
      isIndexed,
      lastIndexed,
      status,
    };
  }

  private renderOpenNoteSection(): void {
    if (!this.openNoteSection) return;
    this.openNoteSection.empty();

    if (!this.currentOpenNote) {
      // No note open - show hint
      const hint = this.openNoteSection.createDiv({ cls: "notient-no-note" });
      hint.createEl("span", { text: "📄 Open a note to see context" });
      return;
    }

    const ctx = this.currentOpenNote;

    // Header with title
    const header = this.openNoteSection.createDiv({ cls: "notient-open-note-header" });
    
    const titleRow = header.createDiv({ cls: "notient-open-note-title-row" });
    const icon = titleRow.createSpan({ cls: "notient-para-icon" });
    icon.setText(ParaDetector.getIcon(ctx.paraType as never));
    
    const title = titleRow.createSpan({ cls: "notient-open-note-title" });
    title.setText(ctx.title);
    this.addCopyButton(titleRow, ctx.title, "Copy title");

    // PARA badge and staleness
    const metaRow = header.createDiv({ cls: "notient-open-note-meta" });
    
    const paraBadge = metaRow.createSpan({ cls: `notient-para-badge para-${ctx.paraType}` });
    paraBadge.setText(ctx.paraType);

    const stalenessEl = metaRow.createSpan({ cls: `notient-staleness status-${ctx.staleness.status}` });
    if (ctx.staleness.status === "unindexed") {
      stalenessEl.setText("⚠️ Not indexed");
    } else if (ctx.staleness.status === "stale") {
      stalenessEl.setText("🔄 Modified since indexing");
    } else {
      stalenessEl.setText(`✓ ${ctx.staleness.daysSinceModified}d old`);
    }

    // Tags
    if (ctx.tags.length > 0) {
      const tagsRow = this.openNoteSection.createDiv({ cls: "notient-open-note-tags" });
      for (const tag of ctx.tags.slice(0, 5)) {
        const tagEl = tagsRow.createSpan({ cls: "notient-tag" });
        tagEl.setText(tag.startsWith("#") ? tag : `#${tag}`);
      }
    }

    // Related notes (backlinks)
    if (ctx.backlinks.length > 0) {
      const backlinksSection = this.openNoteSection.createDiv({ cls: "notient-related-section" });
      backlinksSection.createDiv({ cls: "notient-related-header", text: `🔗 ${ctx.backlinks.length} backlinks` });
      
      const list = backlinksSection.createDiv({ cls: "notient-related-list" });
      for (const link of ctx.backlinks.slice(0, 5)) {
        const item = list.createDiv({ cls: "notient-related-item" });
        const name = link.replace(/\.md$/, "").split("/").pop() || link;
        item.setText(name);
        item.addEventListener("click", () => this.openFile(link));
      }
    }

    // Outlinks
    if (ctx.outlinks.length > 0) {
      const outlinksSection = this.openNoteSection.createDiv({ cls: "notient-related-section" });
      outlinksSection.createDiv({ cls: "notient-related-header", text: `➡️ ${ctx.outlinks.length} outlinks` });
      
      const list = outlinksSection.createDiv({ cls: "notient-related-list" });
      for (const link of ctx.outlinks.slice(0, 5)) {
        const item = list.createDiv({ cls: "notient-related-item" });
        const name = link.replace(/\.md$/, "").split("/").pop() || link;
        item.setText(name);
        item.addEventListener("click", () => this.openFile(link));
      }
    }

    // Recommended actions
    this.renderRecommendedActions();
  }

  private renderRecommendedActions(): void {
    if (!this.currentOpenNote || !this.openNoteSection) return;

    const ctx = this.currentOpenNote;
    const actionsSection = this.openNoteSection.createDiv({ cls: "notient-actions-section" });
    actionsSection.createDiv({ cls: "notient-actions-header", text: "💡 Suggested actions" });

    const actions = actionsSection.createDiv({ cls: "notient-actions-list" });

    // Staleness-based actions
    if (ctx.staleness.status === "unindexed") {
      this.createActionButton(actions, "📝 Index this note", async () => {
        new Notice("Re-indexing will include this note on next sync");
      });
    } else if (ctx.staleness.status === "stale") {
      this.createActionButton(actions, "🔄 Re-index this note", async () => {
        new Notice("Note will be re-indexed on next sync");
      });
    }

    // PARA-based actions
    const paraActions = ParaDetector.getSuggestedActions(ctx.paraType as never);
    for (const action of paraActions.slice(0, 2)) {
      this.createActionButton(actions, action, () => {
        // Copy action to chat
        if (this.chatInput) {
          this.chatInput.value = action;
          this.chatInput.focus();
        }
      });
    }

    // Context-based actions
    if (ctx.backlinks.length === 0) {
      this.createActionButton(actions, "🔗 Find notes to link to this", () => {
        if (this.searchInput) {
          this.searchInput.value = ctx.title;
          this.searchInput.dispatchEvent(new Event("input"));
        }
      });
    }

    // Ask about this note
    this.createActionButton(actions, "💬 Ask about this note", () => {
      if (this.chatInput) {
        this.chatInput.value = `What can you tell me about my note "${ctx.title}"?`;
        this.chatInput.focus();
      }
    });
  }

  private createActionButton(container: HTMLElement, text: string, onClick: () => void): void {
    const btn = container.createEl("button", { cls: "notient-action-btn", text });
    btn.addEventListener("click", onClick);
  }

  // ============ Status Bar ============

  private renderStatus(): void {
    if (!this.statusContainer) return;
    this.statusContainer.empty();

    const health = this.kernel.serviceHealth;
    const badges = this.statusContainer.createDiv({ cls: "notient-badges" });

    this.createBadge(badges, "Ollama", health.ollama.status);
    this.createBadge(badges, "LM Studio", health.lmstudio.status);

    if (!this.kernel.capabilities.search) {
      const warning = this.statusContainer.createDiv({ cls: "notient-warning" });
      warning.setText("Search unavailable - Ollama must be running");
    }
  }

  private createBadge(container: HTMLElement, name: string, status: string): void {
    const badge = container.createSpan({ cls: `notient-badge status-${status}` });
    badge.setText(`${name}: ${status}`);
  }

  // ============ Search Panel ============

  private renderSearchPanel(): void {
    if (!this.searchPanel) return;

    // Header
    const header = this.searchPanel.createDiv({ cls: "notient-panel-header" });
    header.createSpan({ text: "🔍 Semantic Search" });

    // Search input
    const inputWrapper = this.searchPanel.createDiv({ cls: "notient-search-wrapper" });
    this.searchInput = inputWrapper.createEl("input", {
      type: "text",
      placeholder: "Search your vault...",
      cls: "notient-search-input",
    });

    // Results container
    this.searchResults = this.searchPanel.createDiv({ cls: "notient-search-results" });

    // Wire up search
    const debouncedSearch = debounce(
      async (query: string) => {
        if (query.length >= 2) {
          await this.performSearch(query);
        } else {
          this.clearSearchResults();
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
        this.clearSearchResults();
      }
    });
  }

  private async performSearch(query: string): Promise<void> {
    if (!this.searchResults) return;

    const searchPipeline = this.getSearchPipeline();
    if (!searchPipeline || !this.kernel.capabilities.search) {
      this.searchResults.empty();
      this.searchResults.createDiv({
        cls: "notient-message",
        text: this.kernel.isServicesInitializing
          ? "Initializing services..."
          : "Search unavailable. Complete setup first.",
      });
      return;
    }

    // Show loading
    this.searchResults.empty();
    const loadingEl = this.searchResults.createDiv({ cls: "notient-loading" });
    loadingEl.createSpan({ cls: "notient-spinner" });
    loadingEl.createSpan({ text: " Searching...", cls: "notient-loading-text" });

    try {
      const results = await searchPipeline.search(query, {
        topK: 10,
        enableReranking: this.getLMStudio()?.isReady() ?? false,
      });
      this.lastSearchResults = results;
      this.renderSearchResults(results);
    } catch (error) {
      console.error("[Sidebar] Search error:", error);
      this.searchResults.empty();
      this.searchResults.createDiv({
        cls: "notient-error",
        text: "Search failed. Please try again.",
      });
    }
  }

  private renderSearchResults(results: SearchResult[]): void {
    if (!this.searchResults) return;
    this.searchResults.empty();

    if (results.length === 0) {
      this.searchResults.createDiv({
        cls: "notient-message",
        text: "No results found",
      });
      return;
    }

    for (const result of results) {
      const item = this.searchResults.createDiv({ cls: "notient-result-item" });

      // Header with icon, title, and score
      const header = item.createDiv({ cls: "notient-result-header" });

      const icon = header.createSpan({ cls: "notient-para-icon" });
      icon.setText(ParaDetector.getIcon(result.paraType as never));

      const titleWrapper = header.createDiv({ cls: "notient-result-title-wrapper" });
      const title = titleWrapper.createSpan({ cls: "notient-result-title" });
      title.setText(result.title);
      title.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openFile(result.path);
      });

      const score = header.createSpan({ cls: "notient-result-score" });
      score.setText(`${Math.round(result.bestScore * 100)}%`);

      // Copy and open buttons
      const actions = header.createDiv({ cls: "notient-result-actions" });
      this.addCopyButton(actions, result.title, "Copy title");
      
      const openBtn = actions.createEl("button", { cls: "notient-action-icon", attr: { title: "Open note" } });
      openBtn.innerHTML = "↗️";
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openFile(result.path);
      });

      // Path (selectable)
      const path = item.createDiv({ cls: "notient-result-path notient-selectable" });
      path.setText(result.path);

      // LLM reasoning (if available)
      if (result.reasoning) {
        const reasoning = item.createDiv({ cls: "notient-result-reasoning notient-selectable" });
        reasoning.setText(`💡 ${result.reasoning}`);
        this.addCopyButton(reasoning, result.reasoning, "Copy reasoning");
      }

      // Preview (selectable and copyable)
      if (result.chunks.length > 0 && result.chunks[0].text) {
        const preview = item.createDiv({ cls: "notient-result-preview notient-selectable" });
        const text = result.chunks[0].text;
        const previewText = text.length > 200 ? text.slice(0, 200) + "..." : text;
        preview.setText(previewText);
        this.addCopyButton(preview, text, "Copy snippet");
      }

      // Make whole item clickable (but not override inner clicks)
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".notient-result-actions, .notient-result-title, .notient-copy-btn")) {
          return;
        }
        this.openFile(result.path);
      });
    }
  }

  private clearSearchResults(): void {
    if (this.searchResults) {
      this.searchResults.empty();
    }
    this.lastSearchResults = [];
  }

  // ============ Chat Panel ============

  private renderChatPanel(): void {
    if (!this.chatPanel) return;

    // Header
    const header = this.chatPanel.createDiv({ cls: "notient-panel-header" });
    header.createSpan({ text: "💬 Chat with your vault" });

    // Clear chat button
    const clearBtn = header.createEl("button", {
      cls: "notient-clear-chat",
      text: "Clear",
    });
    clearBtn.addEventListener("click", () => {
      this.chatHistory = [];
      if (this.chatMessages) {
        this.chatMessages.empty();
        this.addChatMessage(
          "assistant",
          "Chat cleared. Ask me anything about your notes!"
        );
      }
    });

    // Messages container
    this.chatMessages = this.chatPanel.createDiv({ cls: "notient-chat-messages" });

    // Welcome message
    this.addChatMessage(
      "assistant",
      "Hi! I can answer questions about your notes. Try asking something like:\n• What do I know about [topic]?\n• Summarize my notes on [subject]\n• Find connections between [A] and [B]"
    );

    // Input area
    const inputArea = this.chatPanel.createDiv({ cls: "notient-chat-input-area" });

    this.chatInput = inputArea.createEl("textarea", {
      placeholder: "Ask a question about your notes...",
      cls: "notient-chat-input",
    });

    const sendBtn = inputArea.createEl("button", {
      text: "Send",
      cls: "notient-chat-send",
    });

    // Wire up chat
    sendBtn.addEventListener("click", () => this.sendChatMessage());
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
    });
  }

  private async sendChatMessage(): Promise<void> {
    if (!this.chatInput || !this.chatMessages) return;

    const query = this.chatInput.value.trim();
    if (!query) return;

    // Add user message
    this.addChatMessage("user", query);
    this.chatInput.value = "";

    // Check LM Studio availability
    const lmStudio = this.getLMStudio();
    if (!lmStudio?.isReady()) {
      this.addChatMessage(
        "assistant",
        "⚠️ LM Studio not available. Please ensure it's running and connected in settings."
      );
      return;
    }

    // Search for relevant context
    const searchPipeline = this.getSearchPipeline();
    let searchResults: SearchResult[] = [];

    if (searchPipeline) {
      try {
        searchResults = await searchPipeline.search(query, {
          topK: 5,
          enableReranking: true,
        });
      } catch (error) {
        console.warn("[Sidebar] Context search failed:", error);
      }
    }

    // Build vault context
    const contextBuilder = this.getContextBuilder();
    const context = contextBuilder?.buildForQuery(query, searchResults);

    // Include open note context if available
    const openNoteInfo = this.currentOpenNote
      ? `\n\nCURRENTLY OPEN NOTE:\n- Title: ${this.currentOpenNote.title}\n- Path: ${this.currentOpenNote.path}\n- Type: ${this.currentOpenNote.paraType}\n- Tags: ${this.currentOpenNote.tags.join(", ")}\n- Backlinks: ${this.currentOpenNote.backlinks.length} notes link to this`
      : "";

    // Build system prompt with RAG context
    const relevantNotes = searchResults.map((r) => ({
      title: r.title,
      path: r.path,
      text: r.chunks[0]?.text || "",
    }));

    const systemPrompt = lmStudio.buildChatSystemPrompt(
      (context?.contextSummary || "No vault context available.") + openNoteInfo,
      relevantNotes
    );

    // Build messages
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.chatHistory,
      { role: "user", content: query },
    ];

    // Add placeholder for response
    const responseEl = this.addChatMessage("assistant", "");
    responseEl.addClass("notient-chat-streaming");

    let fullResponse = "";

    try {
      // Stream response
      for await (const chunk of lmStudio.chatStream(messages)) {
        fullResponse += chunk;
        // Update content (preserve copy button)
        const textEl = responseEl.querySelector(".notient-message-text");
        if (textEl) {
          textEl.setText(fullResponse);
        }
        // Auto-scroll
        this.chatMessages?.scrollTo(0, this.chatMessages.scrollHeight);
      }

      responseEl.removeClass("notient-chat-streaming");

      // Add citations if we have search results
      if (searchResults.length > 0) {
        const citations = responseEl.createDiv({ cls: "notient-chat-citations" });
        citations.createSpan({ text: "📚 Sources: " });

        for (const result of searchResults.slice(0, 3)) {
          const cite = citations.createSpan({ cls: "notient-citation" });
          cite.setText(result.title);
          cite.addEventListener("click", () => this.openFile(result.path));
        }
      }

      // Save to history
      this.chatHistory.push({ role: "user", content: query });
      this.chatHistory.push({ role: "assistant", content: fullResponse });

      // Limit history to last 10 exchanges
      if (this.chatHistory.length > 20) {
        this.chatHistory = this.chatHistory.slice(-20);
      }
    } catch (error) {
      console.error("[Sidebar] Chat error:", error);
      const textEl = responseEl.querySelector(".notient-message-text");
      if (textEl) {
        textEl.setText("⚠️ Error generating response. Please try again.");
      }
      responseEl.removeClass("notient-chat-streaming");
    }
  }

  private addChatMessage(role: "user" | "assistant", content: string): HTMLElement {
    if (!this.chatMessages) {
      throw new Error("Chat messages container not initialized");
    }

    const messageEl = this.chatMessages.createDiv({
      cls: `notient-chat-message ${role}`,
    });

    // Header with role and copy button
    const header = messageEl.createDiv({ cls: "notient-message-header" });
    header.createSpan({ 
      text: role === "user" ? "You" : "Notient",
      cls: "notient-message-role"
    });

    if (content) {
      this.addCopyButton(header, content, "Copy message");
    }

    // Content (selectable)
    const textEl = messageEl.createDiv({ cls: "notient-message-text notient-selectable" });
    if (content) {
      textEl.setText(content);
    }

    // Auto-scroll to bottom
    this.chatMessages.scrollTo(0, this.chatMessages.scrollHeight);

    return messageEl;
  }

  // ============ Copy Button Helper ============

  private addCopyButton(container: HTMLElement, textToCopy: string, tooltip: string): void {
    const btn = container.createEl("button", {
      cls: "notient-copy-btn",
      attr: { title: tooltip },
    });
    btn.innerHTML = "📋";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(textToCopy);
        btn.innerHTML = "✓";
        setTimeout(() => {
          btn.innerHTML = "📋";
        }, 1500);
      } catch (err) {
        new Notice("Failed to copy to clipboard");
      }
    });
  }

  // ============ Events ============

  private registerEvents(): void {
    // Active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.updateOpenNoteContext();
      })
    );

    // File modifications
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.currentOpenNote?.path === file.path) {
          await this.updateOpenNoteContext();
        }
      })
    );

    // Health changes
    const unsubHealth = this.kernel.eventBus.on("health:changed", () => {
      this.renderStatus();
    });
    this.register(() => unsubHealth());

    // Services initialized
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.renderStatus();
    });
    this.register(() => unsubServices());

    // Index progress
    const unsubIndex = this.kernel.eventBus.on("index:progress", ({ progress }) => {
      if (progress.phase !== "idle" && progress.phase !== "complete") {
        this.renderIndexingProgress(progress);
      }
    });
    this.register(() => unsubIndex());
  }

  private renderIndexingProgress(progress: {
    current: string | null;
    completed: number;
    total: number;
  }): void {
    if (!this.statusContainer) return;

    let progressEl = this.statusContainer.querySelector(
      ".notient-index-progress"
    ) as HTMLElement;

    if (!progressEl) {
      progressEl = this.statusContainer.createDiv({ cls: "notient-index-progress" });
    }

    const pct =
      progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;

    progressEl.innerHTML = `
      <div class="notient-progress-bar">
        <div class="notient-progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="notient-progress-text">Indexing: ${progress.completed}/${progress.total}</div>
    `;
  }

  // ============ Utilities ============

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }
}
