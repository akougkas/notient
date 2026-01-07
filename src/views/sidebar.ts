/**
 * Notient Sidebar View v2 - Sentient Notes UI
 *
 * Two-view layout:
 * - Note View: Vitals Dashboard + Omnibar + Quick Actions
 * - Agents View: Agent Dashboard + Activity Log
 *
 * Features:
 * - Header tabs toggle between views
 * - View state persists during session
 * - AI queries with streaming support
 * - RAG-powered context retrieval
 */

import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  debounce,
  Notice,
  setIcon,
} from "obsidian";
import type { Kernel } from "../core/kernel";
import type { SearchPipeline } from "../core/search/pipeline";
import type { LMStudioService, ChatMessage } from "../services/lmstudio";
import type { VaultContextBuilder } from "../core/context/vaultContextBuilder";
import type { SearchResult } from "../types/search";
import { VIEW_TYPE_SIDEBAR } from "../core/constants";
import { ParaDetector } from "../core/para/detector";

// ============ Types ============

type SidebarView = "note" | "agents";

interface NoteVitals {
  health: {
    score: number;
    status: "healthy" | "attention" | "unhealthy";
  };
  links: {
    backlinks: number;
    outlinks: number;
  };
  freshness: {
    lastModified: Date;
    displayText: string;
  };
  title: string;
  path: string;
  paraType: string;
  tags: string[];
  isIndexed: boolean;
}

interface Attachment {
  id: string;
  type: "rag-citation" | "user-attached";
  filename: string;
  path: string;
}

interface ExtendedChatMessage extends ChatMessage {
  id: string;
  attachments?: Attachment[];
  timestamp: Date;
}

// ============ Main Sidebar View ============

export class NotientSidebarView extends ItemView {
  // State
  private currentView: SidebarView = "note";
  private noteVitals: NoteVitals | null = null;
  private chatHistory: ExtendedChatMessage[] = [];
  private isStreaming = false;
  private streamingContent = "";
  private activeAbortController: AbortController | null = null;
  private lastSearchResults: SearchResult[] = [];

  // DOM references
  private containerEl_: HTMLElement | null = null;
  private contentEl_: HTMLElement | null = null;
  private omnibarInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;

  // Utilities
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

  // ============ Lifecycle ============

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notient-sidebar--v2");
    this.containerEl_ = container;

    this.render();
    this.registerEvents();
    await this.refreshNoteVitals();
  }

  async onClose(): Promise<void> {
    this.cancelStreaming();
    this.chatHistory = [];
    this.lastSearchResults = [];
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

  // ============ Main Render ============

  private render(): void {
    if (!this.containerEl_) return;
    this.containerEl_.empty();

    // Header (clickable to toggle view)
    this.renderHeader();

    // Content area
    this.contentEl_ = this.containerEl_.createDiv({ cls: "nv2-content" });
    
    if (this.currentView === "note") {
      this.renderNoteVitalsView();
    } else {
      this.renderAgentStreamsView();
    }

    // Footer
    this.renderFooter();
  }

  // ============ Header ============

  private renderHeader(): void {
    if (!this.containerEl_) return;

    const header = this.containerEl_.createDiv({ cls: "nv2-header" });

    // Main title with accent styling
    const title = header.createDiv({ cls: "nv2-header-title" });
    if (this.currentView === "note") {
      title.createSpan({ cls: "nv2-accent", text: "Notient" });
      title.createSpan({ text: " Vitals" });
    } else {
      title.createSpan({ cls: "nv2-accent", text: "Notient" });
      title.createSpan({ text: " Agent Streams" });
    }

    // Subtitle
    header.createDiv({
      cls: "nv2-header-subtitle",
      text: this.currentView === "note" ? "Note Dashboard" : "Agent Dashboard",
    });

    // Click header to toggle view
    header.addEventListener("click", () => {
      this.currentView = this.currentView === "note" ? "agents" : "note";
      this.render();
    });
  }

  // ============ Note Vitals View ============

  private renderNoteVitalsView(): void {
    if (!this.contentEl_) return;

    // Note Context Card (if note is open)
    if (this.noteVitals) {
      this.renderNoteCard();
    }

    // Quick Actions section
    this.renderQuickActionsSection();

    // Search Bar
    this.renderSearchSection();

    // Search results (hidden by default)
    this.searchResultsEl = this.contentEl_.createDiv({
      cls: "nv2-search-results nv2-hidden",
    });

    // Insight Stream section
    this.renderInsightStream();
  }

  private renderNoteCard(): void {
    if (!this.contentEl_ || !this.noteVitals) return;

    const card = this.contentEl_.createDiv({ cls: "nv2-note-card" });

    // Title
    card.createDiv({
      cls: "nv2-note-card-title",
      text: this.noteVitals.title,
    });

    // Tags
    const tags = this.noteVitals.tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
    if (tags.length > 0) {
      const tagsRow = card.createDiv({ cls: "nv2-note-card-tags" });
      for (const tag of tags.slice(0, 5)) {
        tagsRow.createDiv({ cls: "nv2-tag", text: `#${tag}` });
      }
      if (tags.length > 5) {
        tagsRow.createDiv({ cls: "nv2-tag", text: `+${tags.length - 5}` });
      }
    }

    // Links section
    const links = card.createDiv({ cls: "nv2-note-card-links" });

    // Backlinks row
    const backlinksRow = links.createDiv({ cls: "nv2-link-row" });
    const blIcon = backlinksRow.createDiv({ cls: "nv2-link-row-icon" });
    setIcon(blIcon, "link");
    const blContent = backlinksRow.createDiv({ cls: "nv2-link-row-content" });
    blContent.createDiv({
      cls: "nv2-link-row-label",
      text: `${this.noteVitals.links.backlinks} backlink${this.noteVitals.links.backlinks !== 1 ? "s" : ""}`,
    });
    if (this.noteVitals.links.backlinks > 0) {
      blContent.createDiv({
        cls: "nv2-link-row-preview",
        text: this.getBacklinkPreview(),
      });
    }

    // Outlinks row
    const outlinksRow = links.createDiv({ cls: "nv2-link-row" });
    const olIcon = outlinksRow.createDiv({ cls: "nv2-link-row-icon" });
    setIcon(olIcon, "arrow-right");
    const olContent = outlinksRow.createDiv({ cls: "nv2-link-row-content" });
    olContent.createDiv({
      cls: "nv2-link-row-label",
      text: `${this.noteVitals.links.outlinks} outlinks`,
    });
  }

  private getBacklinkPreview(): string {
    // Get first backlink title as preview
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return "";
    
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[activeFile.path]) {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (sourceFile && sourceFile instanceof TFile) {
          return sourceFile.basename + "...";
        }
      }
    }
    return "";
  }

  private renderQuickActionsSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Quick Actions" });

    const actions = section.createDiv({ cls: "nv2-quick-actions" });

    // Enrich action (primary)
    const enrichBtn = actions.createDiv({ cls: "nv2-quick-action nv2-quick-action--primary" });
    const enrichIcon = enrichBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(enrichIcon, "sparkles");
    enrichBtn.createDiv({ cls: "nv2-quick-action-label", text: "Enrich" });
    enrichBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(`Enrich and expand "${noteTitle}" with additional context and insights`);
    });

    // Link action
    const linkBtn = actions.createDiv({ cls: "nv2-quick-action" });
    const linkIcon = linkBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(linkIcon, "link");
    linkBtn.createDiv({ cls: "nv2-quick-action-label", text: "Link" });
    linkBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(`Find notes that should be linked to "${noteTitle}"`);
    });

    // Move action
    const moveBtn = actions.createDiv({ cls: "nv2-quick-action" });
    const moveIcon = moveBtn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(moveIcon, "arrow-right-circle");
    moveBtn.createDiv({ cls: "nv2-quick-action-label", text: "Move" });
    moveBtn.addEventListener("click", () => {
      const noteTitle = this.noteVitals?.title || "this note";
      this.prefillChatAndSwitch(`Suggest the best folder/category for "${noteTitle}" based on its content`);
    });
  }

  private renderSearchSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-search-section" });
    const wrapper = section.createDiv({ cls: "nv2-search-wrapper" });
    
    const icon = wrapper.createDiv({ cls: "nv2-search-icon" });
    setIcon(icon, "search");

    this.omnibarInputEl = wrapper.createEl("input", {
      type: "text",
      placeholder: "Search Notient...",
      cls: "nv2-search-input notient-search-input",
    });

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

    this.omnibarInputEl.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value;
      debouncedSearch(query);
    });

    this.omnibarInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.omnibarInputEl!.value = "";
        this.clearSearchResults();
      }
    });
  }

  private renderInsightStream(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Insight Stream" });

    const stream = section.createDiv({ cls: "nv2-insight-stream" });

    // Generate insights based on note vitals (if available)
    const insights = this.generateInsights();
    
    if (insights.length === 0) {
      const empty = stream.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "Open a note to see insights.",
      });
      return;
    }

    for (const insight of insights) {
      const item = stream.createDiv({ cls: "nv2-insight" });
      item.createDiv({
        cls: `nv2-insight-dot ${insight.priority === "low" ? "nv2-insight-dot--secondary" : ""}`,
      });
      
      const content = item.createDiv({ cls: "nv2-insight-content" });
      
      // Parse text for links
      const textEl = content.createDiv({ cls: "nv2-insight-text" });
      if (insight.linkText) {
        const parts = insight.text.split(insight.linkText);
        textEl.createSpan({ text: parts[0] });
        const link = textEl.createEl("a", { text: insight.linkText });
        link.addEventListener("click", () => {
          if (insight.linkPath) this.openFile(insight.linkPath);
        });
        if (parts[1]) textEl.createSpan({ text: parts[1] });
      } else {
        textEl.setText(insight.text);
      }

      // Action button
      if (insight.action) {
        const actionBtn = content.createDiv({
          cls: `nv2-insight-action ${insight.actionPrimary ? "nv2-insight-action--primary" : ""}`,
        });
        if (insight.actionIcon) {
          const actionIcon = actionBtn.createSpan({ cls: "nv2-insight-action-icon" });
          setIcon(actionIcon, insight.actionIcon);
        }
        actionBtn.createSpan({ text: insight.action });
        actionBtn.addEventListener("click", () => {
          if (insight.actionCallback) insight.actionCallback();
        });
      }
    }
  }

  private generateInsights(): Array<{
    text: string;
    linkText?: string;
    linkPath?: string;
    action?: string;
    actionIcon?: string;
    actionPrimary?: boolean;
    actionCallback?: () => void;
    priority: "high" | "low";
  }> {
    if (!this.noteVitals) return [];

    const insights: Array<{
      text: string;
      linkText?: string;
      linkPath?: string;
      action?: string;
      actionIcon?: string;
      actionPrimary?: boolean;
      actionCallback?: () => void;
      priority: "high" | "low";
    }> = [];

    // Insight about connections
    if (this.noteVitals.links.backlinks === 0 && this.noteVitals.links.outlinks === 0) {
      insights.push({
        text: "This note has no connections. Consider linking it to related notes.",
        action: "Find Connections",
        actionIcon: "eye",
        actionCallback: () => {
          this.prefillChatAndSwitch(`Find notes that could be linked to "${this.noteVitals?.title}"`);
        },
        priority: "high",
      });
    } else if (this.noteVitals.links.backlinks > 0) {
      insights.push({
        text: `This note appears strongly related to other notes via ${this.noteVitals.links.backlinks} backlink${this.noteVitals.links.backlinks > 1 ? "s" : ""}.`,
        action: "Review Links",
        actionIcon: "eye",
        actionCallback: () => this.onMetricClick("links"),
        priority: "high",
      });
    }

    // Classification insight
    if (this.noteVitals.paraType === "inbox" || this.noteVitals.paraType === "unknown") {
      insights.push({
        text: `Suggested classification update: Move from #${this.noteVitals.paraType} to #active-projects based on recent edits.`,
        action: "Apply Change",
        actionIcon: "check",
        actionPrimary: true,
        actionCallback: () => {
          this.prefillChatAndSwitch(`Suggest the best PARA category for "${this.noteVitals?.title}" and help me organize it`);
        },
        priority: "low",
      });
    }

    // Index status insight
    if (!this.noteVitals.isIndexed) {
      insights.push({
        text: "This note is not yet indexed for semantic search.",
        action: "Index Now",
        actionIcon: "database",
        actionCallback: () => {
          new Notice("Indexing will happen on next sync");
        },
        priority: "low",
      });
    }

    return insights;
  }

  // ============ Agent Streams View ============

  private renderAgentStreamsView(): void {
    if (!this.contentEl_) return;

    // Status bar
    this.renderAgentStatusBar();

    // Agent Dashboard (service status cards)
    this.renderAgentDashboardSection();

    // Agent Activity Log
    this.renderAgentActivityLog();
  }

  private renderAgentStatusBar(): void {
    if (!this.contentEl_) return;

    const statusBar = this.contentEl_.createDiv({ cls: "nv2-status-bar" });
    
    const left = statusBar.createDiv({ cls: "nv2-status-bar-left" });
    left.createDiv({
      cls: `nv2-status-dot ${this.isStreaming ? "nv2-status-dot--running" : "nv2-status-dot--idle"}`,
    });
    left.createSpan({
      cls: "nv2-status-bar-text",
      text: this.isStreaming ? "Agent working..." : "All agents idle",
    });

    const settingsBtn = statusBar.createEl("button", {
      cls: "nv2-status-bar-btn",
      attr: { "aria-label": "Agent settings" },
    });
    setIcon(settingsBtn, "sliders");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById("notient");
    });
  }

  private renderAgentDashboardSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Agent Dashboard" });

    const dashboard = section.createDiv({ cls: "nv2-agent-dashboard" });
    const grid = dashboard.createDiv({ cls: "nv2-agent-dashboard-grid" });

    const searchReady = this.kernel.capabilities.search;
    const lmReady = this.getLMStudio()?.isReady() ?? false;

    // Semantic Search card
    const searchCard = grid.createDiv({ cls: "nv2-agent-dashboard-card" });
    const searchIcon = searchCard.createDiv({ cls: "nv2-agent-dashboard-card-icon" });
    setIcon(searchIcon, "search");
    searchCard.createDiv({ cls: "nv2-agent-dashboard-card-name", text: "Semantic Search" });
    searchCard.createDiv({
      cls: `nv2-agent-dashboard-card-status ${searchReady ? "nv2-agent-dashboard-card-status--active" : ""}`,
      text: searchReady ? "ready" : "offline",
    });

    // Context Builder card
    const contextCard = grid.createDiv({ cls: "nv2-agent-dashboard-card" });
    const contextIcon = contextCard.createDiv({ cls: "nv2-agent-dashboard-card-icon" });
    setIcon(contextIcon, "braces");
    contextCard.createDiv({ cls: "nv2-agent-dashboard-card-name", text: "Context Builder" });
    contextCard.createDiv({
      cls: `nv2-agent-dashboard-card-status ${searchReady ? "nv2-agent-dashboard-card-status--active" : ""}`,
      text: searchReady ? "idle" : "offline",
    });

    // Result Reranker card
    const rerankerCard = grid.createDiv({ cls: "nv2-agent-dashboard-card" });
    const rerankerIcon = rerankerCard.createDiv({ cls: "nv2-agent-dashboard-card-icon" });
    setIcon(rerankerIcon, "list-ordered");
    rerankerCard.createDiv({ cls: "nv2-agent-dashboard-card-name", text: "Result Reranker" });
    rerankerCard.createDiv({
      cls: `nv2-agent-dashboard-card-status ${lmReady ? "nv2-agent-dashboard-card-status--active" : ""}`,
      text: lmReady ? "idle" : "offline",
    });
  }

  private renderAgentActivityLog(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-activity-log" });
    section.createDiv({ cls: "nv2-activity-log-title", text: "Agent Activity Log" });

    const list = section.createDiv({ cls: "nv2-activity-log-list" });

    // Generate activity items from chat history and search activity
    const activities = this.generateActivityLog();

    if (activities.length === 0) {
      const empty = list.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "No recent agent activity. Use the search or chat to get started.",
      });
      return;
    }

    for (const activity of activities) {
      const item = list.createDiv({
        cls: `nv2-activity-item ${activity.type === "code" ? "nv2-activity-item--blue" : ""}`,
      });

      const header = item.createDiv({ cls: "nv2-activity-header" });
      const agent = header.createDiv({ cls: "nv2-activity-agent" });
      const agentIcon = agent.createDiv({ cls: "nv2-activity-agent-icon" });
      setIcon(agentIcon, activity.icon);
      agent.createDiv({ cls: "nv2-activity-agent-name", text: activity.agentName });
      header.createDiv({ cls: "nv2-activity-time", text: activity.time });

      const body = item.createDiv({ cls: "nv2-activity-body" });
      body.createSpan({ cls: "nv2-agent-name", text: activity.agentName });
      body.createSpan({ text: ` ${activity.description} - ` });
      
      if (activity.status === "in_progress") {
        body.createSpan({ cls: "nv2-activity-status", text: "In Progress" });
      } else {
        const link = body.createSpan({ cls: "nv2-activity-link", text: activity.action });
        link.addEventListener("click", () => {
          if (activity.actionCallback) activity.actionCallback();
        });
      }
    }
  }

  private generateActivityLog(): Array<{
    agentName: string;
    icon: string;
    type: "research" | "code";
    time: string;
    description: string;
    action: string;
    status?: "in_progress" | "complete";
    actionCallback?: () => void;
  }> {
    const activities: Array<{
      agentName: string;
      icon: string;
      type: "research" | "code";
      time: string;
      description: string;
      action: string;
      status?: "in_progress" | "complete";
      actionCallback?: () => void;
    }> = [];

    // Generate from chat history
    const recentChats = this.chatHistory.slice(-5);
    for (const chat of recentChats) {
      if (chat.role === "assistant") {
        const time = this.formatActivityTime(chat.timestamp);
        activities.push({
          agentName: "Research Bot",
          icon: "leaf",
          type: "research",
          time,
          description: `responded to query`,
          action: "View Response",
          status: "complete",
          actionCallback: () => {
            // Scroll to message
          },
        });
      }
    }

    // Add streaming activity if active
    if (this.isStreaming) {
      activities.unshift({
        agentName: "Research Bot",
        icon: "leaf",
        type: "research",
        time: "Now",
        description: `processing query`,
        action: "",
        status: "in_progress",
      });
    }

    // Add recent search activity
    if (this.lastSearchResults.length > 0) {
      activities.push({
        agentName: "Research Bot",
        icon: "leaf",
        type: "research",
        time: "Recently",
        description: `found ${this.lastSearchResults.length} results`,
        action: "View Results",
        status: "complete",
        actionCallback: () => {
          this.currentView = "note";
          this.render();
        },
      });
    }

    return activities.slice(0, 5);
  }

  private formatActivityTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) {
      const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `Today, ${time}`;
    }
    return `Yesterday, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  // Note: Chat functionality is still available but UI is simplified for Agent Streams view
  // Chat messages are shown in the activity log format instead of full chat bubbles

  // ============ Footer ============

  private renderFooter(): void {
    if (!this.containerEl_) return;

    const footer = this.containerEl_.createDiv({ cls: "nv2-footer" });
    const status = footer.createDiv({ cls: "nv2-footer-status" });

    const health = this.kernel.serviceHealth;

    // Ollama status
    const ollamaEl = status.createDiv({ cls: "nv2-footer-service" });
    ollamaEl.createSpan({ text: "Connected to Ollama: " });
    ollamaEl.createSpan({
      cls: `nv2-footer-service-status ${this.getFooterStatusClass(health.ollama.status)}`,
      text: this.getStatusText(health.ollama.status),
    });

    // LM Studio status
    const lmEl = status.createDiv({ cls: "nv2-footer-service" });
    lmEl.createSpan({ text: "LM Studio: " });
    lmEl.createSpan({
      cls: `nv2-footer-service-status ${this.getFooterStatusClass(health.lmstudio.status)}`,
      text: this.getStatusText(health.lmstudio.status),
    });

    // Settings button
    const settingsBtn = footer.createEl("button", { cls: "nv2-footer-settings" });
    settingsBtn.setAttr("aria-label", "Open Notient settings");
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById("notient");
    });
  }

  private getFooterStatusClass(status: string): string {
    switch (status) {
      case "healthy":
        return ""; // Default green
      case "unhealthy":
        return "nv2-footer-service-status--error";
      case "checking":
        return "nv2-footer-service-status--warning";
      default:
        return "nv2-footer-service-status--error";
    }
  }

  private getStatusText(status: string): string {
    switch (status) {
      case "healthy":
        return "Healthy";
      case "unhealthy":
        return "Offline";
      case "checking":
        return "Checking...";
      default:
        return "Unknown";
    }
  }

  // ============ Note Vitals ============

  private async refreshNoteVitals(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile || activeFile.extension !== "md") {
      this.noteVitals = null;
      if (this.currentView === "note") {
        this.render();
      }
      return;
    }

    const metadata = this.app.metadataCache.getFileCache(activeFile);

    // Calculate health score (heuristic based on various factors)
    const healthScore = this.calculateHealthScore(activeFile, metadata);

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
    const frontmatterTags = (metadata?.frontmatter?.tags as string[]) || [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    // Freshness
    const mtime = activeFile.stat.mtime;
    const freshness = this.formatFreshness(mtime);

    // Check if indexed
    const indexManager = this.kernel.getService<{
      isNoteIndexed(path: string): boolean;
    }>("indexManager");
    const isIndexed = indexManager?.isNoteIndexed(activeFile.path) ?? false;

    this.noteVitals = {
      health: {
        score: healthScore,
        status:
          healthScore >= 70
            ? "healthy"
            : healthScore >= 40
              ? "attention"
              : "unhealthy",
      },
      links: {
        backlinks: backlinks.length,
        outlinks: outlinks.length,
      },
      freshness: {
        lastModified: new Date(mtime),
        displayText: freshness,
      },
      title: activeFile.basename,
      path: activeFile.path,
      paraType: this.paraDetector.detectType(activeFile.path),
      tags: allTags,
      isIndexed,
    };

    if (this.currentView === "note") {
      this.render();
    }
  }

  private calculateHealthScore(
    file: TFile,
    metadata: ReturnType<typeof this.app.metadataCache.getFileCache>
  ): number {
    let score = 50; // Base score

    // Freshness factor (up to +20)
    const daysSinceModified = Math.floor(
      (Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceModified <= 7) score += 20;
    else if (daysSinceModified <= 30) score += 10;
    else if (daysSinceModified > 90) score -= 10;

    // Tags factor (up to +10)
    const tagCount = (metadata?.tags?.length || 0) + 
      ((metadata?.frontmatter?.tags as string[])?.length || 0);
    if (tagCount >= 3) score += 10;
    else if (tagCount >= 1) score += 5;

    // Links factor (up to +20)
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const outlinks = Object.keys(resolvedLinks[file.path] || {}).length;
    let backlinks = 0;
    for (const [, links] of Object.entries(resolvedLinks)) {
      if (links[file.path]) backlinks++;
    }

    if (backlinks >= 5) score += 10;
    else if (backlinks >= 1) score += 5;

    if (outlinks >= 5) score += 10;
    else if (outlinks >= 1) score += 5;

    // Indexed factor
    const indexManager = this.kernel.getService<{
      isNoteIndexed(path: string): boolean;
    }>("indexManager");
    if (indexManager?.isNoteIndexed(file.path)) {
      score += 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private formatFreshness(mtime: number): string {
    const now = Date.now();
    const diff = now - mtime;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        return "Just now";
      }
      return `${hours}h ago`;
    } else if (days === 1) {
      return "Yesterday";
    } else if (days < 7) {
      return `${days} days ago`;
    } else if (days < 30) {
      const weeks = Math.floor(days / 7);
      return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    } else {
      const date = new Date(mtime);
      return date.toLocaleDateString();
    }
  }

  // ============ Search ============

  private async performSearch(query: string): Promise<void> {
    const searchPipeline = this.getSearchPipeline();
    if (!searchPipeline || !this.kernel.capabilities.search) {
      this.showSearchError("Search unavailable");
      return;
    }

    this.showSearchLoading();

    try {
      const results = await searchPipeline.search(query, {
        topK: 8,
        enableReranking: this.getLMStudio()?.isReady() ?? false,
      });
      this.lastSearchResults = results;
      this.renderSearchResults(results);
    } catch (error) {
      console.error("[Sidebar] Search error:", error);
      this.showSearchError("Search failed");
    }
  }

  private renderSearchResults(results: SearchResult[]): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    if (results.length === 0) {
      const empty = this.searchResultsEl.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({ cls: "nv2-empty-state-icon", text: "🔍" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "No matches found",
      });
      return;
    }

    for (const result of results) {
      const item = this.searchResultsEl.createDiv({ cls: "nv2-search-result" });

      const header = item.createDiv({ cls: "nv2-search-result-header" });
      header.createSpan({
        cls: "nv2-search-result-title",
        text: result.title,
      });
      header.createSpan({
        cls: "nv2-search-result-score",
        text: `${Math.round(result.bestScore * 100)}%`,
      });

      item.createDiv({
        cls: "nv2-search-result-path",
        text: result.path,
      });

      if (result.chunks.length > 0 && result.chunks[0].text) {
        const preview = result.chunks[0].text;
        item.createDiv({
          cls: "nv2-search-result-preview",
          text: preview.length > 150 ? preview.slice(0, 150) + "..." : preview,
        });
      }

      item.addEventListener("click", () => this.openFile(result.path));
    }
  }

  private showSearchLoading(): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const loading = this.searchResultsEl.createDiv({ cls: "nv2-loading" });
    loading.createDiv({ cls: "nv2-loading-spinner" });
    loading.createSpan({ text: "Thinking..." });
  }

  private showSearchError(message: string): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const empty = this.searchResultsEl.createDiv({ cls: "nv2-empty-state" });
    empty.createDiv({ cls: "nv2-empty-state-text", text: message });
  }

  private clearSearchResults(): void {
    if (this.searchResultsEl) {
      this.searchResultsEl.empty();
      this.searchResultsEl.addClass("nv2-hidden");
    }
    this.lastSearchResults = [];
  }

  // ============ Chat / AI Actions ============

  /**
   * Send a query to the AI agent and update activity log
   */
  private async sendQuery(query: string): Promise<void> {
    const lmStudio = this.getLMStudio();
    if (!lmStudio?.isReady()) {
      new Notice("AI unavailable - LM Studio not connected");
      return;
    }

    // Add user message to history
    const userMessage: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };
    this.chatHistory.push(userMessage);

    // Start streaming
    this.isStreaming = true;
    this.streamingContent = "";
    this.activeAbortController = new AbortController();

    this.render();

    try {
      // Search for context
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

      // Build context
      const contextBuilder = this.getContextBuilder();
      const context = contextBuilder?.buildForQuery(query, searchResults);

      // Build system prompt
      const relevantNotes = searchResults.map((r) => ({
        title: r.title,
        path: r.path,
        text: r.chunks[0]?.text || "",
      }));

      const systemPrompt = lmStudio.buildChatSystemPrompt(
        context?.contextSummary || "No vault context available.",
        relevantNotes
      );

      // Build messages
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...this.chatHistory.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      // Stream response
      for await (const chunk of lmStudio.chatStream(
        messages,
        this.activeAbortController.signal
      )) {
        if (this.activeAbortController.signal.aborted) break;
        this.streamingContent += chunk;
        this.render();
      }

      // Finalize
      if (!this.activeAbortController.signal.aborted) {
        const assistantMessage: ExtendedChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: this.streamingContent,
          attachments: searchResults.slice(0, 3).map((r) => ({
            id: crypto.randomUUID(),
            type: "rag-citation" as const,
            filename: r.title,
            path: r.path,
          })),
          timestamp: new Date(),
        };
        this.chatHistory.push(assistantMessage);
        
        // Show result in notice
        const preview = this.streamingContent.slice(0, 100);
        new Notice(`AI Response: ${preview}${this.streamingContent.length > 100 ? "..." : ""}`);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("[Sidebar] AI query error:", error);
        new Notice("AI query failed. Try again?");
      }
    } finally {
      this.isStreaming = false;
      this.streamingContent = "";
      this.activeAbortController = null;
      this.render();
    }
  }

  private cancelStreaming(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
  }

  /**
   * Switch to agents view and start a query
   */
  private prefillChatAndSwitch(prompt: string): void {
    this.currentView = "agents";
    this.render();
    
    // Start the query immediately
    this.sendQuery(prompt);
  }

  // ============ Events ============

  private registerEvents(): void {
    // Active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.refreshNoteVitals();
      })
    );

    // File modifications
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.noteVitals?.path === file.path) {
          await this.refreshNoteVitals();
        }
      })
    );

    // Health changes
    const unsubHealth = this.kernel.eventBus.on("health:changed", () => {
      this.render();
    });
    this.register(() => unsubHealth());

    // Services initialized
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.render();
    });
    this.register(() => unsubServices());
  }

  // ============ Metric Actions ============

  private onMetricClick(metric: "health" | "links" | "freshness"): void {
    if (!this.noteVitals) {
      new Notice("Open a note to see its vitals");
      return;
    }

    switch (metric) {
      case "health":
        this.prefillChatAndSwitch(
          `Analyze the health of my note "${this.noteVitals.title}" and suggest improvements`
        );
        break;
      case "links":
        this.prefillChatAndSwitch(
          `Show me all the connections for "${this.noteVitals.title}" and suggest new links`
        );
        break;
      case "freshness":
        this.prefillChatAndSwitch(
          `What has changed in "${this.noteVitals.title}" and what should I review?`
        );
        break;
    }
  }

  // ============ Utilities ============

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }
}
