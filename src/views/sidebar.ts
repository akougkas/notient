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

import { ItemView, Notice, TFile, type WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type { AgentTaskQueue } from "../core/agent";
import type { AgentType } from "../core/agent/types";
import type { ActionApplier } from "../core/agentic/actionApplier";
import { isSlashCommand, parseSlashCommand } from "../core/agentic/commandParser";
import type { ProposedAction, WorkflowRun } from "../core/agentic/types";
import type { WorkflowRunner } from "../core/agentic/workflowRunner";
import { VIEW_TYPE_DASHBOARD, VIEW_TYPE_SIDEBAR } from "../core/constants";
import type { ActionOrchestrator } from "../core/intelligence/actionOrchestrator";
import type { NoteIntelligenceService } from "../core/intelligence/noteIntelligence";
import type {
  IntelligenceEntity,
  IntelligenceSuggestedLink,
  IntelligenceSuggestedTag,
  IntelligenceTriageAction,
} from "../core/intelligence/types";
import type { Kernel } from "../core/kernel";
import type { LLMProvider } from "../core/llm";
import { ParaDetector } from "../core/para/detector";
import type { SearchPipeline } from "../core/search/pipeline";
import { type Insight, InsightGenerator } from "../services/insightGenerator";
import {
  type IndexManagerLike,
  type NoteVitals,
  NoteVitalsCalculator,
} from "../services/noteVitalsCalculator";
import type { IndexProgress } from "../types/indexer";
import type { SearchResult } from "../types/search";
import { InsightStream } from "./sidebar/components/InsightStream";
import {
  IntelligenceActions,
  type IntelligenceActionsConfig,
} from "./sidebar/components/IntelligenceActions";
import { NoteCard } from "./sidebar/components/NoteCard";
import { QuickActions, createNoteQuickActions } from "./sidebar/components/QuickActions";
import { type IndexManagerStats, SidebarFooter } from "./sidebar/components/SidebarFooter";
import { TaskModal } from "./taskModal";

// ============ Types ============

type SidebarView = "note" | "agents";

// ============ Main Sidebar View ============

export class NotientSidebarView extends ItemView {
  // State
  private currentView: SidebarView = "note";
  private noteVitals: NoteVitals | null = null;
  private _lastSearchResults: SearchResult[] = [];

  // DOM references
  private containerEl_: HTMLElement | null = null;
  private contentEl_: HTMLElement | null = null;

  // Search State
  private omnibarInputEl: HTMLInputElement | null = null;
  private searchResultsEl: HTMLElement | null = null;
  private selectedResultIndex = -1;
  private isSearching = false;
  private currentSearchMode: "quick" | "balanced" | "thorough" = "balanced";
  private isShowingHints = false;
  private currentHints: any[] = [];

  // Services (extracted)
  private paraDetector: ParaDetector;
  private vitalsCalculator: NoteVitalsCalculator;
  private insightGenerator: InsightGenerator;
  private sidebarFooter: SidebarFooter | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private kernel: Kernel,
  ) {
    super(leaf);
    this.paraDetector = new ParaDetector(kernel.settings);
    this.vitalsCalculator = new NoteVitalsCalculator(this.app, this.paraDetector);
    this.insightGenerator = new InsightGenerator({
      prefillChatAndSwitch: (prompt) => this.prefillChatAndSwitch(prompt),
      onMetricClick: (metric) => this.onMetricClick(metric),
      showNotice: (msg) => new Notice(msg),
    });
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
    this._lastSearchResults = [];
    // Clean up DOM references to prevent memory leaks
    this.containerEl_ = null;
    this.contentEl_ = null;
    this.omnibarInputEl = null;
    this.searchResultsEl = null;
    this.sidebarFooter = null;
    this.currentHints = [];
  }

  // ============ Service Getters ============

  private getSearchPipeline(): SearchPipeline | null {
    return this.kernel.getService<SearchPipeline>("search");
  }

  private getLLMProvider(): LLMProvider | null {
    return this.kernel.getService<LLMProvider>("llmProvider");
  }

  private getWorkflowRunner(): WorkflowRunner | null {
    return this.kernel.getService<WorkflowRunner>("workflowRunner");
  }

  private getNoteIntelligence(): NoteIntelligenceService | null {
    return this.kernel.getService<NoteIntelligenceService>("intelligence");
  }

  private getActionApplier(): ActionApplier | null {
    return this.kernel.getService<ActionApplier>("actionApplier");
  }

  private getActionOrchestrator(): ActionOrchestrator | null {
    return this.kernel.getService<ActionOrchestrator>("actionOrchestrator");
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
      this.renderNoteIntelligenceSection();
    }

    // Omnibar (search + commands)
    this.renderSearchSection();

    // Quick Actions section
    this.renderQuickActionsSection();

    // Intelligence 2.0 Actions section
    this.renderIntelligenceActionsSection();

    // Insight Stream section
    this.renderInsightStream();
  }

  private renderNoteCard(): void {
    if (!this.contentEl_ || !this.noteVitals) return;
    const backlinkPreview = this.getBacklinkPreview();
    const noteCard = new NoteCard(this.noteVitals, backlinkPreview);
    noteCard.render(this.contentEl_);
  }

  private renderNoteIntelligenceSection(): void {
    if (!this.contentEl_ || !this.noteVitals) return;

    const intelligence = this.getNoteIntelligence();
    if (!intelligence) return;

    const record = intelligence.getRecord(this.noteVitals.path);

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Intelligence" });

    const stream = section.createDiv({ cls: "nv2-insight-stream" });

    // Summary
    const summaryItem = stream.createDiv({ cls: "nv2-insight" });
    summaryItem.createDiv({
      cls: `nv2-insight-dot ${record?.summaryShort ? "" : "nv2-insight-dot--secondary"}`,
    });
    const summaryContent = summaryItem.createDiv({ cls: "nv2-insight-content" });
    const summaryText = summaryContent.createDiv({ cls: "nv2-insight-text" });
    summaryText.setText(
      record?.summaryShort ??
        "No AI summary yet. It will generate in the background after indexing, or you can generate it now.",
    );

    if (!record?.summaryShort) {
      const actionBtn = summaryContent.createDiv({
        cls: "nv2-insight-action nv2-insight-action--primary",
      });
      actionBtn.createSpan({ text: "Generate summary" });
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void intelligence.regenerate(this.noteVitals?.path ?? "");
        new Notice("Generating note summary…");
      });
    }

    // Health breakdown (from intelligence store)
    if (record?.health) {
      const h = record.health;
      const healthItem = stream.createDiv({ cls: "nv2-insight" });
      healthItem.createDiv({ cls: "nv2-insight-dot nv2-insight-dot--secondary" });
      const healthContent = healthItem.createDiv({ cls: "nv2-insight-content" });
      const healthText = healthContent.createDiv({ cls: "nv2-insight-text" });
      healthText.setText(
        `Health: ${h.score}/100 (freshness ${h.breakdown.freshness}, connectivity ${h.breakdown.connectivity}, structure ${h.breakdown.structure}, metadata ${h.breakdown.metadata})`,
      );
    }

    // Entities (New)
    if (record?.entities && record.entities.length > 0) {
      this.renderEntities(stream, record.entities);
    }

    // Suggestions (tags/links) (New)
    if (
      (record?.suggestedTags && record.suggestedTags.length > 0) ||
      (record?.suggestedLinks && record.suggestedLinks.length > 0)
    ) {
      this.renderSuggestions(stream, record.suggestedTags ?? [], record.suggestedLinks ?? []);
    }

    // Triage Action (New)
    if (record?.triageAction) {
      this.renderTriageAction(stream, record.triageAction);
    }
  }

  private renderEntities(container: HTMLElement, entities: IntelligenceEntity[]): void {
    const item = container.createDiv({ cls: "nv2-insight" });
    item.createDiv({ cls: "nv2-insight-dot nv2-insight-dot--secondary" });
    const content = item.createDiv({ cls: "nv2-insight-content" });

    content.createDiv({ cls: "nv2-insight-label", text: "Entities identified" });

    const pillContainer = content.createDiv({ cls: "nv2-entity-cloud" });

    // Show top 8 entities
    for (const entity of entities.slice(0, 8)) {
      const pill = pillContainer.createDiv({
        cls: "nv2-entity-pill",
        title: `${entity.type}: ${entity.context || "No context"}`,
      });
      pill.setText(entity.name);
    }
  }

  private renderSuggestions(
    container: HTMLElement,
    tags: IntelligenceSuggestedTag[],
    links: IntelligenceSuggestedLink[],
  ): void {
    const item = container.createDiv({ cls: "nv2-insight" });
    item.createDiv({ cls: "nv2-insight-dot" });
    const content = item.createDiv({ cls: "nv2-insight-content" });
    content.createDiv({ cls: "nv2-insight-label", text: "Suggestions" });

    // Tags
    if (tags.length > 0) {
      const row = content.createDiv({ cls: "nv2-suggestion-row" });
      for (const t of tags.slice(0, 3)) {
        const btn = row.createEl("button", {
          cls: "nv2-suggestion-btn",
          text: `+ #${t.tag}`,
          title: `${Math.round(t.confidence * 100)}% - ${t.reason}`,
        });
        btn.addEventListener("click", () =>
          this.applySuggestion(
            btn,
            {
              type: "frontmatter_add_tags",
              payload: { tags: [t.tag] },
              risk: "low",
              title: `Add tag #${t.tag}`,
              reason: t.reason,
            },
            `Added #${t.tag}`,
            "add tag",
          ),
        );
      }
    }

    // Links
    if (links.length > 0) {
      const list = content.createDiv({ cls: "nv2-suggestion-list" });
      for (const l of links.slice(0, 3)) {
        const row = list.createDiv({ cls: "nv2-suggestion-link-row" });
        row.createSpan({ text: `Link to [[${l.title}]]?`, title: l.reason });
        const applyBtn = row.createEl("button", { cls: "nv2-suggestion-icon-btn", text: "Link" });
        applyBtn.addEventListener("click", () =>
          this.applySuggestion(
            applyBtn,
            {
              type: "append_related_links",
              payload: { links: [l.title] },
              risk: "medium",
              title: `Link to [[${l.title}]]`,
              reason: l.reason,
            },
            `Linked to [[${l.title}]]`,
            "link",
            row,
          ),
        );
      }
    }
  }

  private async applySuggestion(
    btn: HTMLButtonElement,
    action: Omit<ProposedAction, "id" | "target" | "requiresWriteLock">,
    successMsg: string,
    failLabel: string,
    removeEl?: HTMLElement,
  ): Promise<void> {
    // Disable immediately to prevent double-click
    btn.disabled = true;

    if (!this.noteVitals) {
      btn.disabled = false;
      return;
    }
    const applier = this.getActionApplier();
    if (!applier) {
      new Notice("Action Applier service not available");
      btn.disabled = false;
      return;
    }
    const result = await applier.applyConfirmed({
      ...action,
      id: window.crypto.randomUUID(),
      target: this.noteVitals.path,
      requiresWriteLock: true,
    } as ProposedAction);
    if (result.success) {
      new Notice(successMsg);
      (removeEl ?? btn).remove();
    } else {
      new Notice(`Failed to ${failLabel}: ${result.error}`);
      btn.disabled = false;
    }
  }

  private renderTriageAction(container: HTMLElement, action: IntelligenceTriageAction): void {
    const item = container.createDiv({ cls: "nv2-insight" });
    item.createDiv({ cls: "nv2-insight-dot nv2-insight-dot--action" });
    const content = item.createDiv({ cls: "nv2-insight-content" });

    const box = content.createDiv({ cls: "nv2-triage-box" });

    const title = box.createDiv({ cls: "nv2-triage-title" });
    setIcon(title.createSpan({ cls: "nv2-triage-icon" }), "inbox");
    title.createSpan({ text: "Inbox Triage" });

    const msg = box.createDiv({ cls: "nv2-triage-message" });
    if (action.type === "move") {
      msg.setText(`Move to "${action.target}"? ${action.reason}`);
    } else if (action.type === "tag") {
      msg.setText(`Tag as ${action.target}? ${action.reason}`);
    } else {
      msg.setText(`${action.type}: ${action.target} (${action.reason})`);
    }

    const actions = box.createDiv({ cls: "nv2-triage-actions" });
    const applyBtn = actions.createEl("button", {
      cls: "nv2-triage-btn nv2-triage-btn--primary",
      text: "Apply",
    });
    applyBtn.addEventListener("click", async () => {
      if (!this.noteVitals) return;
      const applier = this.getActionApplier();
      if (!applier) return;

      applyBtn.disabled = true;
      applyBtn.textContent = "Applying...";

      if (!action.target) {
        new Notice("Triage action missing target");
        applyBtn.disabled = false;
        return;
      }

      let proposed: ProposedAction | null = null;
      if (action.type === "move") {
        let toPath = action.target;
        // Fix up the path if needed (simple heuristic)
        if (!toPath.endsWith(".md")) {
          // It's a folder, append current filename
          const name = this.app.vault.getAbstractFileByPath(this.noteVitals.path)?.name;
          if (name) {
            toPath = `${toPath}/${name}`.replace(/\/+/g, "/");
          }
        }

        proposed = {
          id: window.crypto.randomUUID(),
          type: "move_note",
          target: this.noteVitals.path,
          payload: {
            from: this.noteVitals.path,
            to: toPath,
          },
          risk: "medium",
          title: `Move to ${action.target}`,
          reason: action.reason,
          requiresWriteLock: true,
        };
      } else if (action.type === "tag") {
        proposed = {
          id: window.crypto.randomUUID(),
          type: "frontmatter_add_tags",
          target: this.noteVitals.path,
          payload: { tags: [action.target.replace(/^#/, "")] },
          risk: "low",
          title: `Add tag ${action.target}`,
          reason: action.reason,
          requiresWriteLock: true,
        };
      }

      if (proposed) {
        const result = await applier.applyConfirmed(proposed);
        if (result.success) {
          new Notice("Applied triage action");
          box.remove();
        } else {
          new Notice(`Failed: ${result.error}`);
          applyBtn.disabled = false;
        }
      } else {
        new Notice("Unsupported triage action type");
        applyBtn.disabled = false;
      }
    });

    const dismissBtn = actions.createEl("button", { cls: "nv2-triage-btn", text: "Dismiss" });
    dismissBtn.addEventListener("click", () => {
      box.remove();
    });
  }

  private getBacklinkPreview(): string {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return "";
    return this.vitalsCalculator.getBacklinkPreview(activeFile);
  }

  private renderQuickActionsSection(): void {
    if (!this.contentEl_) return;
    const noteTitle = this.noteVitals?.title || "this note";
    const actions = createNoteQuickActions(noteTitle, (prompt) =>
      this.prefillChatAndSwitch(prompt),
    );
    const quickActions = new QuickActions(actions);
    quickActions.render(this.contentEl_);
  }

  private renderIntelligenceActionsSection(): void {
    if (!this.contentEl_) return;

    const orchestrator = this.getActionOrchestrator();
    const actionApplier = this.getActionApplier();

    // Only render if both services are available
    if (!orchestrator || !actionApplier) return;

    const config: IntelligenceActionsConfig = {
      orchestrator,
      actionApplier,
      getContext: async () => {
        if (!this.noteVitals) return null;
        // Read the note content
        const file = this.app.vault.getAbstractFileByPath(this.noteVitals.path);
        if (!(file instanceof TFile)) return null;

        try {
          const noteContent = await this.app.vault.cachedRead(file);
          return {
            notePath: this.noteVitals.path,
            noteTitle: this.noteVitals.title,
            noteContent,
          };
        } catch {
          return null;
        }
      },
      getExistingPaths: () => {
        const files = this.kernel.obsidian.getMarkdownFiles();
        return new Set(files.map((f) => f.path));
      },
    };

    const intelligenceActions = new IntelligenceActions(config);
    intelligenceActions.render(this.contentEl_);
  }

  private renderSearchSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-omnibar" });

    // Header with Mode Switcher (Interactive Pills)
    const header = section.createDiv({ cls: "nv2-omnibar-header" });
    const currentMode = this.currentSearchMode || "balanced"; // Default to balanced if not set

    const modes = [
      { key: "quick", icon: "⚡", label: "Quick" },
      { key: "balanced", icon: "⚖️", label: "Balanced" },
      { key: "thorough", icon: "🧠", label: "Thorough" },
    ];

    // Omnibar Wrapper (Glassmorphism Container)
    const wrapper = section.createDiv({ cls: "nv2-omnibar-wrapper" });

    // Icon
    const icon = wrapper.createDiv({ cls: "nv2-omnibar-icon" });
    setIcon(icon, "search");

    // Input with accessibility
    const modeInfo = this.getSearchModeInfo();
    this.omnibarInputEl = wrapper.createEl("input", {
      type: "text",
      placeholder: modeInfo.placeholder,
      cls: "nv2-omnibar-input",
      attr: {
        "aria-label": "Search your notes or enter a command",
        autocomplete: "off",
        role: "searchbox",
      },
    });

    // Right side controls (Mode Switcher + Kbd Hint)
    const right = wrapper.createDiv({ cls: "nv2-omnibar-right" });

    // Mode Pills
    modes.forEach((mode) => {
      const isActive = currentMode === mode.key;
      const pill = right.createDiv({
        cls: `nv2-mode-pill nv2-mode--${mode.key}`,
        attr: { "data-mode": mode.key },
      });
      if (!isActive) pill.style.opacity = "0.5";
      if (isActive) pill.style.transform = "scale(1.05)";

      pill.createSpan({ text: mode.icon });
      // Only show label for active mode to save space, or show all if plenty of space
      // For now, sleek icon-only for non-active
      if (isActive) pill.createSpan({ text: mode.label });

      pill.addEventListener("click", () => {
        this.setSearchMode(mode.key as any);
      });
    });

    const hint = right.createDiv({ cls: "nv2-omnibar-hint" });
    hint.createSpan({ text: "⌘K", cls: "nv2-omnibar-kbd" });

    // Floating Results Container
    this.searchResultsEl = section.createDiv({ cls: "nv2-omnibar-results nv2-hidden" });

    // Debounce logic
    const debounceMs = currentMode === "quick" ? 50 : 150;
    const debouncedSearch = debounce(
      async (query: string) => {
        if (isSlashCommand(query)) {
          // Already handled by input event for hints
          return;
        }
        if (query.length >= 2) {
          // Show loading state
          this.renderLoadingState();
          await this.performSearch(query);
        } else {
          this.clearSearchResults();
        }
      },
      debounceMs,
      false,
    );

    this.omnibarInputEl.addEventListener("input", (e) => {
      this.selectedResultIndex = -1;
      const query = (e.target as HTMLInputElement).value;

      // Command / Agent Hints
      if (query.startsWith("/") || query.startsWith("@")) {
        this.showCommandHints(query);
        return;
      }

      // Normal Search
      debouncedSearch(query);
    });

    this.omnibarInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.omnibarInputEl) this.omnibarInputEl.value = "";
        this.clearSearchResults();
        this.omnibarInputEl?.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.navigateResults(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.navigateResults(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const query = this.omnibarInputEl?.value.trim() || "";

        // Handle Hint Selection
        if (this.isShowingHints && this.selectedResultIndex >= 0) {
          const selectedHint = this.currentHints[this.selectedResultIndex];
          if (selectedHint) {
            this.selectHint(selectedHint);
          }
          return;
        }

        if (this.selectedResultIndex >= 0 && this._lastSearchResults[this.selectedResultIndex]) {
          this.openFile(this._lastSearchResults[this.selectedResultIndex].path);
          this.clearSearchResults();
        } else if (isSlashCommand(query)) {
          void this.handleSlashCommand(query);
        } else if (this.isAgentCommand(query)) {
          this.handleAgentCommand(query);
        } else if (query.length >= 2) {
          void this.performSearch(query);
        }
      }
    });

    // Focus handling
    this.omnibarInputEl.addEventListener("focus", () => {
      section.addClass("nv2-omnibar--focused");
    });
    this.omnibarInputEl.addEventListener("blur", () => {
      setTimeout(() => section.removeClass("nv2-omnibar--focused"), 150);
    });
  }

  private renderLoadingState(): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");
    const container = this.searchResultsEl.createDiv({ cls: "nv2-loading-container" });
    container.createDiv({ cls: "nv2-loading-spinner" });
    container.createSpan({ text: "Searching..." });
  }

  private getSearchModeInfo(): {
    key: string;
    icon: string;
    label: string;
    description: string;
    placeholder: string;
  } {
    const preset = this.kernel.settings.search.preset;
    switch (preset) {
      case "quick":
        return {
          key: "quick",
          icon: "⚡",
          label: "Quick",
          description: "Fast file name search (no AI)",
          placeholder: "Search, /command, or @agent...",
        };
      case "thorough":
        return {
          key: "thorough",
          icon: "🧠",
          label: "Thorough",
          description: "Deep semantic search with AI reranking",
          placeholder: "Search, /command, or @agent...",
        };
      default:
        return {
          key: "balanced",
          icon: "⚖️",
          label: "Balanced",
          description: "Semantic search with vitality scores",
          placeholder: "Search, /command, or @agent...",
        };
    }
  }

  /**
   * Handle slash command execution
   */
  private async handleSlashCommand(input: string): Promise<void> {
    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) {
      new Notice("Workflow system not available. Services may still be initializing.");
      return;
    }

    // Parse the command
    const result = parseSlashCommand(input, this.kernel.obsidian);

    if (!result.success) {
      new Notice(`Command error: ${result.error.message}`);
      return;
    }

    const parsed = result.parsed;

    // Start the workflow
    const startResult = await workflowRunner.startFromCommand(parsed);

    if (!startResult.success) {
      new Notice(`Workflow error: ${startResult.error}`);
      return;
    }

    // Clear input and show success
    if (this.omnibarInputEl) {
      this.omnibarInputEl.value = "";
    }
    this.clearSearchResults();

    const scopeText = parsed.scope === "vault" ? "entire vault" : `folder "${parsed.target}"`;
    new Notice(
      `Started ${parsed.command} workflow on ${scopeText} (${startResult.noteCount} notes)`,
    );

    // Switch to agents view to show progress
    this.currentView = "agents";
    this.render();
  }

  private renderInsightStream(): void {
    if (!this.contentEl_) return;
    const insights = this.insightGenerator.generate(this.noteVitals);
    const insightStream = new InsightStream(insights, (path) => this.openFile(path));
    insightStream.render(this.contentEl_);
  }

  // ============ Agent Streams View ============

  private renderAgentStreamsView(): void {
    if (!this.contentEl_) return;

    // Status bar
    this.renderAgentStatusBar();

    // Active Workflow (if any)
    this.renderActiveWorkflow();

    // Agent Dashboard (service status cards)
    this.renderAgentDashboardSection();

    // Agent Activity Log
    this.renderAgentActivityLog();
  }

  /**
   * Render the active workflow card (if any)
   */
  private renderActiveWorkflow(): void {
    if (!this.contentEl_) return;

    const workflowRunner = this.getWorkflowRunner();
    if (!workflowRunner) return;

    const currentWorkflow = workflowRunner.getCurrentWorkflow();
    const queuedWorkflows = workflowRunner.getQueuedWorkflows();

    if (!currentWorkflow && queuedWorkflows.length === 0) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Active Workflows" });

    const container = section.createDiv({ cls: "nv2-workflow-container" });

    // Render current workflow
    if (currentWorkflow) {
      this.renderWorkflowCard(container, currentWorkflow, true);
    }

    // Render queued workflows
    for (const workflow of queuedWorkflows) {
      this.renderWorkflowCard(container, workflow, false);
    }
  }

  /**
   * Render a single workflow card
   */
  private renderWorkflowCard(
    container: HTMLElement,
    workflow: WorkflowRun,
    isActive: boolean,
  ): void {
    const card = container.createDiv({
      cls: `nv2-workflow-card ${isActive ? "nv2-workflow-card--active" : ""}`,
    });

    // Header with command name and scope
    const header = card.createDiv({ cls: "nv2-workflow-header" });
    const titleEl = header.createDiv({ cls: "nv2-workflow-title" });

    const iconEl = titleEl.createSpan({ cls: "nv2-workflow-icon" });
    setIcon(iconEl, this.getWorkflowIcon(workflow.spec.command));

    titleEl.createSpan({
      text: `/${workflow.spec.command}`,
      cls: "nv2-workflow-command",
    });

    const scopeText =
      workflow.spec.scope === "vault"
        ? "vault"
        : workflow.spec.targets.length === 1
          ? workflow.spec.targets[0].split("/").pop() || "note"
          : `${workflow.spec.targets.length} notes`;
    titleEl.createSpan({
      text: ` on ${scopeText}`,
      cls: "nv2-workflow-scope",
    });

    // Status badge
    const statusBadge = header.createDiv({
      cls: `nv2-workflow-status nv2-workflow-status--${workflow.status}`,
      text: workflow.status,
    });

    // Progress section (only for running workflows)
    if (workflow.status === "running") {
      const progressContainer = card.createDiv({ cls: "nv2-workflow-progress-container" });

      const progressBar = progressContainer.createDiv({ cls: "nv2-workflow-progress" });
      const percent =
        workflow.progress.total > 0
          ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
          : 0;
      progressBar.createDiv({
        cls: "nv2-workflow-progress-fill",
        attr: { style: `width: ${percent}%` },
      });

      const progressText = progressContainer.createDiv({ cls: "nv2-workflow-progress-text" });
      progressText.setText(
        `${workflow.progress.completed}/${workflow.progress.total} complete${workflow.progress.failed > 0 ? ` (${workflow.progress.failed} failed)` : ""}`,
      );
    }

    // Actions
    const actions = card.createDiv({ cls: "nv2-workflow-actions" });

    if (workflow.status === "running" || workflow.status === "queued") {
      const cancelBtn = actions.createEl("button", {
        cls: "nv2-workflow-btn nv2-workflow-btn--cancel",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const workflowRunner = this.getWorkflowRunner();
        if (workflowRunner) {
          workflowRunner.cancel(workflow.id);
          new Notice("Workflow cancelled");
          this.render();
        }
      });
    }

    // Review queue indicator
    if (workflow.reviewQueue.length > 0) {
      const reviewBadge = actions.createDiv({
        cls: "nv2-workflow-review-badge",
        text: `${workflow.reviewQueue.length} pending review`,
      });
      reviewBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        // Open Dashboard view to review pending actions
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
        if (leaves.length > 0) {
          this.app.workspace.setActiveLeaf(leaves[0], { focus: true });
        } else {
          new Notice("Open Dashboard from command palette to review pending actions");
        }
      });
    }

    // Error display (collapsible)
    if (workflow.errors.length > 0) {
      const errorsContainer = card.createDiv({ cls: "nv2-workflow-errors" });
      const errorHeader = errorsContainer.createDiv({ cls: "nv2-workflow-errors-header" });

      const errorIcon = errorHeader.createSpan({ cls: "nv2-workflow-errors-icon" });
      setIcon(errorIcon, "alert-triangle");

      errorHeader.createSpan({
        cls: "nv2-workflow-errors-title",
        text: `${workflow.errors.length} error${workflow.errors.length > 1 ? "s" : ""}`,
      });

      const toggleIcon = errorHeader.createSpan({ cls: "nv2-workflow-errors-toggle" });
      setIcon(toggleIcon, "chevron-down");

      const errorList = errorsContainer.createDiv({
        cls: "nv2-workflow-errors-list nv2-workflow-errors-list--collapsed",
      });

      for (const err of workflow.errors.slice(0, 5)) {
        const errorItem = errorList.createDiv({ cls: "nv2-workflow-error-item" });
        errorItem.createDiv({
          cls: "nv2-workflow-error-text",
          text: err.error,
        });
      }

      if (workflow.errors.length > 5) {
        errorList.createDiv({
          cls: "nv2-workflow-errors-more",
          text: `...and ${workflow.errors.length - 5} more`,
        });
      }

      // Toggle expand/collapse
      errorHeader.addEventListener("click", (e) => {
        e.stopPropagation();
        const isCollapsed = errorList.classList.contains("nv2-workflow-errors-list--collapsed");
        errorList.classList.toggle("nv2-workflow-errors-list--collapsed");
        setIcon(toggleIcon, isCollapsed ? "chevron-up" : "chevron-down");
      });
    }
  }

  /**
   * Get icon for workflow command
   */
  private getWorkflowIcon(command: string): string {
    switch (command) {
      case "enrich":
        return "sparkles";
      case "classify":
        return "folder-tree";
      case "link":
        return "link";
      default:
        return "play";
    }
  }

  private renderAgentStatusBar(): void {
    if (!this.contentEl_) return;

    const statusBar = this.contentEl_.createDiv({ cls: "nv2-status-bar" });

    const left = statusBar.createDiv({ cls: "nv2-status-bar-left" });
    // Check if any agents are running by querying the task queue
    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    const hasRunningTasks = taskQueue?.getAll().some((t) => t.status === "running") ?? false;
    left.createDiv({
      cls: `nv2-status-dot ${hasRunningTasks ? "nv2-status-dot--running" : "nv2-status-dot--idle"}`,
    });
    left.createSpan({
      cls: "nv2-status-bar-text",
      text: hasRunningTasks ? "Agent working..." : "All agents idle",
    });

    const settingsBtn = statusBar.createEl("button", {
      cls: "nv2-status-bar-btn",
      attr: { "aria-label": "Agent settings" },
    });
    setIcon(settingsBtn, "sliders");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      (
        this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
      ).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        "notient",
      );
    });
  }

  private renderAgentDashboardSection(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Agent Dashboard" });

    const dashboard = section.createDiv({ cls: "nv2-agent-dashboard" });
    const grid = dashboard.createDiv({ cls: "nv2-agent-dashboard-grid" });

    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    const tasks = taskQueue?.getAll() || [];

    // Helper to get status
    const getStatus = (type: AgentType) => {
      const isRunning = tasks.some((t) => t.agent === type && t.status === "running");
      if (isRunning) return "working";

      switch (type) {
        case "search":
          return this.kernel.capabilities.search ? "ready" : "offline";
        case "context":
          return this.kernel.capabilities.search ? "idle" : "offline"; // Context depends on search
        case "chat":
          return this.kernel.capabilities.reasoning ? "idle" : "offline";
      }
    };

    const renderCard = (type: AgentType, name: string, icon: string) => {
      const status = getStatus(type);
      const card = grid.createDiv({ cls: "nv2-agent-dashboard-card" });
      const iconEl = card.createDiv({ cls: "nv2-agent-dashboard-card-icon" });
      setIcon(iconEl, icon);

      card.createDiv({ cls: "nv2-agent-dashboard-card-name", text: name });

      const statusEl = card.createDiv({
        cls: "nv2-agent-dashboard-card-status",
        text: status,
      });

      if (status === "working") {
        statusEl.addClass("nv2-status-pulsing");
      } else if (status === "ready" || status === "idle") {
        statusEl.addClass("nv2-agent-dashboard-card-status--active");
      }
    };

    renderCard("search", "Semantic Search", "search");
    renderCard("context", "Context Builder", "braces");
    renderCard("chat", "Chat Assistant", "message-square");
  }

  private renderAgentActivityLog(): void {
    if (!this.contentEl_) return;

    const section = this.contentEl_.createDiv({ cls: "nv2-activity-log" });
    section.createDiv({ cls: "nv2-activity-log-title", text: "Agent Activity Log" });

    const list = section.createDiv({ cls: "nv2-activity-log-list" });

    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    const tasks = taskQueue?.getAll() || [];

    // Sort by startedAt desc
    const sortedTasks = [...tasks].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (sortedTasks.length === 0) {
      const empty = list.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({
        cls: "nv2-empty-state-text",
        text: "No recent agent activity. Use Quick Actions or Search to start a task.",
      });
      return;
    }

    for (const task of sortedTasks) {
      const item = list.createDiv({
        cls: `nv2-activity-item nv2-task-card nv2-task-${task.status}`,
      });
      // Click to open modal
      item.addEventListener("click", () => {
        new TaskModal(this.app, this.kernel, task).open();
      });

      const header = item.createDiv({ cls: "nv2-activity-header" });
      const agent = header.createDiv({ cls: "nv2-activity-agent" });
      const agentIcon = agent.createDiv({ cls: "nv2-activity-agent-icon" });

      let icon = "bot";
      switch (task.agent) {
        case "search":
          icon = "search";
          break;
        case "context":
          icon = "file-search";
          break;
        case "chat":
          icon = "message-square";
          break;
      }
      setIcon(agentIcon, icon);

      agent.createDiv({ cls: "nv2-activity-agent-name", text: this.getAgentName(task.agent) });
      header.createDiv({ cls: "nv2-activity-time", text: this.formatActivityTime(task.startedAt) });

      const body = item.createDiv({ cls: "nv2-activity-body" });
      body.createDiv({ cls: "nv2-task-note", text: task.noteTitle });

      if (task.status === "running") {
        const progress = item.createDiv({ cls: "nv2-task-progress" });
        progress.createDiv({
          cls: "nv2-task-progress-bar",
          attr: { style: `width: ${task.progress || 0}%` },
        });
      }

      item.createDiv({
        cls: `nv2-task-status-foot nv2-status-${task.status}`,
        text: task.status,
      });
    }
  }

  private getAgentName(type: AgentType): string {
    switch (type) {
      case "search":
        return "Agent Search";
      case "context":
        return "Context Agent";
      case "chat":
        return "Chat Assistant";
      default:
        return "Agent";
    }
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

    const indexManager = this.kernel.getService<IndexManagerStats>("indexManager");

    this.sidebarFooter = new SidebarFooter(this.kernel.settings, this.kernel.serviceHealth, () => {
      (
        this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
      ).setting.open();
      (this.app as unknown as { setting: { openTabById(id: string): void } }).setting.openTabById(
        "notient",
      );
    });
    this.sidebarFooter.render(this.containerEl_, indexManager);
  }

  private updateFooterStats(): void {
    if (!this.sidebarFooter) return;
    const indexManager = this.kernel.getService<IndexManagerStats>("indexManager");
    this.sidebarFooter.updateStats(indexManager);
  }

  private updateIndexProgress(progress: IndexProgress): void {
    if (!this.sidebarFooter) return;
    this.sidebarFooter.updateProgress(progress);
    if (progress.phase === "complete") {
      this.updateFooterStats();
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

    const indexManager = this.kernel.getService<IndexManagerLike>("indexManager");
    this.noteVitals = await this.vitalsCalculator.calculate(activeFile, indexManager);

    if (this.currentView === "note") {
      this.render();
    }
  }

  // ============ Search ============

  private async performSearch(query: string): Promise<void> {
    const preset = this.kernel.settings.search.preset;

    // Quick mode: instant fuzzy search on file names (no embedding)
    if (preset === "quick") {
      this.performQuickSearch(query);
      return;
    }

    // Semantic search (balanced/thorough)
    const searchPipeline = this.getSearchPipeline();
    if (!searchPipeline || !this.kernel.capabilities.search) {
      // Fallback to quick search if semantic unavailable
      this.performQuickSearch(query);
      return;
    }

    this.isSearching = true;
    this.showSearchLoading();

    const startTime = Date.now();
    try {
      const results = await searchPipeline.search(query, {
        topK: preset === "thorough" ? 12 : 8,
        enableReranking: preset === "thorough" && (this.getLLMProvider()?.isReady ?? false),
      });
      this._lastSearchResults = results;
      this.selectedResultIndex = -1;
      this.renderSearchResults(results, Date.now() - startTime);
    } catch (error) {
      console.error("[Sidebar] Search error:", error);
      this.showSearchError("Search failed");
    } finally {
      this.isSearching = false;
    }
  }

  private performQuickSearch(query: string): void {
    const files = this.app.vault.getMarkdownFiles();
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\s+/).filter((w) => w.length > 0);

    // Score files by fuzzy match on path and name
    const scored: Array<{ file: TFile; score: number }> = [];
    for (const file of files) {
      const pathLower = file.path.toLowerCase();
      const nameLower = file.basename.toLowerCase();

      let score = 0;
      for (const word of words) {
        if (nameLower.includes(word)) score += 0.6;
        else if (pathLower.includes(word)) score += 0.3;
      }
      // Exact name match bonus
      if (nameLower === queryLower) score += 0.5;
      else if (nameLower.startsWith(queryLower)) score += 0.3;

      if (score > 0) scored.push({ file, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, 10);

    // Convert to SearchResult format for consistent rendering
    this._lastSearchResults = topResults.map(({ file, score }) => ({
      noteId: file.path,
      path: file.path,
      title: file.basename,
      bestScore: Math.min(score, 1),
      paraType: this.paraDetector.detectType(file.path) as SearchResult["paraType"],
      chunks: [],
      mtimeMs: file.stat.mtime,
    }));

    this.selectedResultIndex = -1;
    this.renderSearchResults(this._lastSearchResults, 0, true);
  }

  private renderSearchResults(
    results: SearchResult[],
    durationMs: number,
    isQuickMode = false,
  ): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    // Update internal state
    this._lastSearchResults = results;
    this.isShowingHints = false;

    if (results.length === 0) {
      const empty = this.searchResultsEl.createDiv({ cls: "nv2-empty-state" });
      empty.createDiv({ cls: "nv2-empty-icon", text: "🔍" });
      empty.createDiv({ cls: "nv2-empty-text", text: "No matches found" });
      return;
    }

    // Results header with count and timing
    const header = this.searchResultsEl.createDiv({ cls: "nv2-results-meta" });
    header.createSpan({ text: `${results.length} results found` });
    if (durationMs > 0) {
      header.createSpan({ text: `${durationMs}ms` });
    }

    // Results list (scrollable)
    const list = this.searchResultsEl.createDiv({ cls: "nv2-omnibar-results-list" });

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const item = list.createDiv({
        cls: `nv2-result-item${i === this.selectedResultIndex ? " nv2-result-item--selected" : ""}`,
      });

      // --- Left Side: Main Info ---
      const left = item.createDiv({ cls: "nv2-result-main" });

      // Title Row
      const top = left.createDiv({ cls: "nv2-result-top" });
      // Optional Icon based on file type? For now just title
      // setIcon(top.createDiv({cls: "nv2-result-icon"}), "file-text");

      top.createSpan({ cls: "nv2-result-title", text: result.title });

      if (result.paraType && result.paraType !== "unknown") {
        top.createSpan({
          cls: `nv2-result-para nv2-para--${result.paraType}`,
          text: result.paraType,
        });
      }

      // Context / Path
      const bestChunk = result.chunks[0];
      const headingPath = bestChunk?.headingPath?.length ? bestChunk.headingPath.join(" › ") : "";
      left.createDiv({
        cls: "nv2-result-context",
        text: headingPath || result.path.replace(/\.md$/, ""),
      });

      // Snippet (Semantic Mode Only)
      if (!isQuickMode && bestChunk?.text) {
        const preview = this.buildChunkPreview(bestChunk.text, 120);
        if (preview) {
          left.createDiv({ cls: "nv2-result-snippet" }, (el) => {
            el.setText(preview);
          });
        }
      }

      // --- Right Side: Dual Scores ---
      const right = item.createDiv({ cls: "nv2-result-scores" });

      // 1. Similarity Score (Percent)
      if (!isQuickMode) {
        const simScore = right.createDiv({ cls: "nv2-score-sim" });
        const simPct = Math.round(result.bestScore * 100);
        simScore.createSpan({ text: `${simPct}%` });
        simScore.createSpan({ text: "sim", cls: "nv2-score-sim-label" });
      }

      // 2. Vitality Score (Ring)
      const vitality = this.calculateVitalityScore(result.path);
      if (vitality !== null) {
        const vitContainer = right.createDiv({ cls: "nv2-score-vit" });

        // Ring Background
        vitContainer.createDiv({ cls: "nv2-vit-ring-bg" });

        // Ring Fill (Conic Gradient)
        // Color based on score
        let color = "var(--nv2-status-error)";
        if (vitality >= 70) color = "var(--nv2-status-healthy)";
        else if (vitality >= 40) color = "var(--nv2-status-warning)";

        const fill = vitContainer.createDiv({ cls: "nv2-vit-ring-fill" });
        fill.style.background = `conic-gradient(${color} ${vitality}%, transparent 0)`;

        // Value
        vitContainer.createSpan({ cls: "nv2-vit-value", text: `${vitality}` });
      }

      // Interaction
      item.addEventListener("click", () => {
        this.openFile(result.path);
        this.clearSearchResults();
      });

      item.addEventListener("mouseenter", () => {
        this.selectedResultIndex = i;
        this.updateResultSelection();
      });
    }
  }

  private updateResultSelection(): void {
    const items = this.searchResultsEl?.querySelectorAll(".nv2-result-item");
    if (!items) return;

    items.forEach((item, index) => {
      if (index === this.selectedResultIndex) {
        item.addClass("nv2-result-item--selected");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.removeClass("nv2-result-item--selected");
      }
    });

    // Also handle hints selection update if showing hints
    const hintItems = this.searchResultsEl?.querySelectorAll(".nv2-hint-item");
    if (hintItems) {
      hintItems.forEach((item, index) => {
        if (index === this.selectedResultIndex) {
          item.addClass("nv2-hint-item--selected");
          item.scrollIntoView({ block: "nearest" });
        } else {
          item.removeClass("nv2-hint-item--selected");
        }
      });
    }
  }

  private navigateResults(dir: number): void {
    const listLength = this.isShowingHints
      ? this.currentHints.length
      : this._lastSearchResults.length;
    if (listLength === 0) return;

    this.selectedResultIndex += dir;

    if (this.selectedResultIndex < 0) this.selectedResultIndex = listLength - 1;
    if (this.selectedResultIndex >= listLength) this.selectedResultIndex = 0;

    this.updateResultSelection();
  }

  private calculateVitalityScore(path: string): number | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const metadata = this.app.metadataCache.getFileCache(file);
    return this.vitalsCalculator.calculateHealthScore(file, metadata);
  }

  private buildChunkPreview(text: string, maxChars: number): string {
    // Tiered chunks include a contextual header (# title / ## heading / Tags:).
    // For UI previews, strip that and show the most useful body snippet.
    const lines = text.split("\n");
    const bodyLines = lines.filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith("# ")) return false;
      if (t.startsWith("## ")) return false;
      if (t.startsWith("Tags:")) return false;
      if (t.startsWith("Path:")) return false;
      if (t === "Sketch:" || t === "Outline:") return false;
      return true;
    });

    const normalized = bodyLines.join(" ").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    return normalized.length > maxChars
      ? `${normalized.slice(0, maxChars).trimEnd()}…`
      : normalized;
  }

  private showSearchLoading(): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const loading = this.searchResultsEl.createDiv({ cls: "nv2-omnibar-loading" });
    loading.createDiv({ cls: "nv2-omnibar-spinner" });
    loading.createSpan({ text: "Searching..." });
  }

  private showSearchError(message: string): void {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const empty = this.searchResultsEl.createDiv({ cls: "nv2-omnibar-empty" });
    empty.createDiv({ cls: "nv2-omnibar-empty-text", text: message });
  }

  private setSearchMode(mode: "quick" | "balanced" | "thorough"): void {
    this.currentSearchMode = mode;
    // Re-render only the search section to update UI state
    // In a fuller React/Svelte app we'd just update state, here we manually re-render or update classes
    // For simplicity in this vanilla TS setup, we'll re-render the whole search section or just update classes
    // Let's implement a lighter update:

    const pills = this.contentEl_?.querySelectorAll(".nv2-mode-pill");
    pills?.forEach((p) => {
      const pill = p as HTMLElement;
      const pillMode = pill.getAttribute("data-mode");
      if (pillMode === mode) {
        pill.style.opacity = "1";
        pill.style.transform = "scale(1.05)";
        // Show label
        if (!pill.querySelector("span:nth-child(2)")) {
          const label = mode.charAt(0).toUpperCase() + mode.slice(1);
          pill.createSpan({ text: label });
        }
      } else {
        pill.style.opacity = "0.5";
        pill.style.transform = "scale(1)";
        // Hide label if exists (simple remove)
        const labelSpan = pill.querySelector("span:nth-child(2)");
        if (labelSpan) labelSpan.remove();
      }
    });

    // Update placeholder
    if (this.omnibarInputEl) {
      const info = this.getSearchModeInfo();
      this.omnibarInputEl.placeholder = info.placeholder;
    }
  }

  private selectHint(hint: any): void {
    if (!this.omnibarInputEl) return;

    // Complete the input with the hint
    // e.g. if typing "/en", and select "/enrich", replace input
    this.omnibarInputEl.value = `${hint.command} `;
    this.omnibarInputEl.focus();
    this.clearSearchResults(); // Hide hints
    this.isShowingHints = false;
  }

  private showCommandHints(query: string): void {
    if (!this.searchResultsEl) return;

    this.isShowingHints = true;
    this.searchResultsEl.empty();
    this.searchResultsEl.removeClass("nv2-hidden");

    const panel = this.searchResultsEl.createDiv({ cls: "nv2-hints-panel" });

    // Mock data for commands - logic would ideally pull from a registry
    let hints: any[] = [];
    const isAgent = query.startsWith("@");

    if (isAgent) {
      panel.createDiv({ cls: "nv2-hint-header", text: "Available Agents" });
      const allAgents = [
        { command: "@chat", desc: "General chat assistant", example: "@chat how are you?" },
        { command: "@search", desc: "Search web & vault", example: "@search 'latest AI news'" },
        {
          command: "@writer",
          desc: "Content drafting agent",
          example: "@writer 'blog post about...'",
        },
        {
          command: "@coder",
          desc: "Code generation agent",
          example: "@coder 'python script to...'",
        },
      ];
      hints = allAgents.filter((a) => a.command.startsWith(query));
    } else {
      panel.createDiv({ cls: "nv2-hint-header", text: "Workflow Commands" });
      const allCmds = [
        { command: "/enrich", desc: "Add metadata & tags", example: "/enrich properties" },
        { command: "/summarize", desc: "Summarize current note", example: "/summarize" },
        { command: "/link", desc: "Find related connections", example: "/link" },
        { command: "/classify", desc: "Auto-classify PARA/Tags", example: "/classify" },
      ];
      hints = allCmds.filter((c) => c.command.startsWith(query));
    }

    this.currentHints = hints; // Store for selection

    if (hints.length === 0) {
      panel.createDiv({ cls: "nv2-empty-state", text: "No matching commands found" });
      return;
    }

    hints.forEach((h, i) => {
      const item = panel.createDiv({
        cls: `nv2-hint-item ${i === this.selectedResultIndex ? "nv2-hint-item--selected" : ""}`,
      });
      item.createDiv({ cls: "nv2-hint-key", text: h.command });
      item.createDiv({ cls: "nv2-hint-desc", text: h.desc });
      item.createDiv({ cls: "nv2-hint-example", text: h.example });

      item.addEventListener("mouseenter", () => {
        this.selectedResultIndex = i;
        // Update selection visually
        panel
          .querySelectorAll(".nv2-hint-item")
          .forEach((el) => el.removeClass("nv2-hint-item--selected"));
        item.addClass("nv2-hint-item--selected");
      });

      item.addEventListener("click", () => {
        this.selectHint(h);
      });
    });
  }

  private clearSearchResults(): void {
    if (this.searchResultsEl) {
      this.searchResultsEl.empty();
      this.searchResultsEl.addClass("nv2-hidden");
    }
    this._lastSearchResults = [];
    this.selectedResultIndex = -1;
    this.isShowingHints = false;
  }

  /**
   * Check if input is an @agent command (e.g., @agent summarize this note)
   */
  private isAgentCommand(input: string): boolean {
    return input.trim().startsWith("@");
  }

  /**
   * Handle @agent command - sends task to agent queue
   */
  private handleAgentCommand(input: string): void {
    const trimmed = input.trim();
    const match = trimmed.match(/^@(\w+)\s*(.*)/);

    if (!match) {
      new Notice("Invalid command. Use: @agent <task description>");
      return;
    }

    const [, agentType, taskDescription] = match;
    const validAgents = ["chat", "search", "context", "enrich", "classify", "link"];

    // Default to chat agent for general queries
    const agent = validAgents.includes(agentType.toLowerCase()) ? agentType.toLowerCase() : "chat";
    const prompt = agent === agentType.toLowerCase() ? taskDescription : trimmed.slice(1); // Remove @ if using default

    if (!prompt.trim()) {
      new Notice("Please provide a task description after @agent");
      return;
    }

    // Enqueue task
    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    if (taskQueue) {
      taskQueue.enqueue({
        agent: agent as "chat" | "search" | "context",
        notePath: this.noteVitals?.path || "unknown",
        noteTitle: this.noteVitals?.title || "Unknown Note",
        chatHistory: [{ role: "user", content: prompt }],
      });
      new Notice(`Task sent to ${agent} agent`);

      // Clear and switch to agents view
      if (this.omnibarInputEl) this.omnibarInputEl.value = "";
      this.clearSearchResults();
      this.currentView = "agents";
      this.render();
    } else {
      new Notice("Agent system not available");
    }
  }

  /**
   * Switch to agents view and start a query
   */
  private prefillChatAndSwitch(prompt: string): void {
    this.currentView = "agents";

    // Enqueue task
    const taskQueue = this.kernel.getService<AgentTaskQueue>("taskQueue");
    if (taskQueue) {
      taskQueue.enqueue({
        agent: "chat",
        notePath: this.noteVitals?.path || "unknown",
        noteTitle: this.noteVitals?.title || "Unknown Note",
        chatHistory: [{ role: "user", content: prompt }],
      });
    }

    this.render();
  }

  // ============ Events ============

  private registerEvents(): void {
    // Active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.refreshNoteVitals();
      }),
    );

    // File modifications
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.noteVitals?.path === file.path) {
          await this.refreshNoteVitals();
        }
      }),
    );

    // Health changes
    const unsubHealth = this.kernel.eventBus.on("health:changed", () => {
      this.render();
    });
    this.register(() => unsubHealth());

    // Services initialized
    const unsubServices = this.kernel.eventBus.on("services:initialized", () => {
      this.render();
      this.updateFooterStats();
    });
    this.register(() => unsubServices());

    // Agent Task Updates
    const unsubTask = this.kernel.eventBus.on("agent:task-update", () => {
      if (this.currentView === "agents") {
        this.render(); // Re-render to show progress/status
      }
    });
    this.register(() => unsubTask());

    // Index Progress
    const unsubProgress = this.kernel.eventBus.on(
      "index:progress",
      (payload: { progress: IndexProgress }) => {
        this.updateIndexProgress(payload.progress);
      },
    );
    this.register(() => unsubProgress());

    // Index Complete
    const unsubIndexComplete = this.kernel.eventBus.on("index:complete", () => {
      if (this.sidebarFooter) {
        this.sidebarFooter.setLastSyncTime(new Date());
      }
      this.updateFooterStats();
    });
    this.register(() => unsubIndexComplete());

    // Intelligence updates (Phase 3)
    const unsubIntelligence = this.kernel.eventBus.on("intelligence:updated", ({ path }) => {
      if (this.currentView === "note" && this.noteVitals?.path === path) {
        this.render();
      }
    });
    this.register(() => unsubIntelligence());

    // Settings changed (refresh footer when index changes)
    const unsubSettings = this.kernel.eventBus.on("settings:changed", () => {
      this.updateFooterStats();
    });
    this.register(() => unsubSettings());

    // Workflow events (Milestone 2.4)
    const unsubWorkflowStarted = this.kernel.eventBus.on("workflow:started", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowStarted());

    const unsubWorkflowProgress = this.kernel.eventBus.on("workflow:progress", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowProgress());

    const unsubWorkflowCompleted = this.kernel.eventBus.on("workflow:completed", (event) => {
      const { workflow } = event;
      new Notice(
        `Workflow complete: ${workflow.progress.completed}/${workflow.progress.total} notes processed${workflow.progress.failed > 0 ? ` (${workflow.progress.failed} failed)` : ""}`,
      );
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowCompleted());

    const unsubWorkflowCancelled = this.kernel.eventBus.on("workflow:cancelled", () => {
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowCancelled());

    const unsubWorkflowFailed = this.kernel.eventBus.on("workflow:failed", (event) => {
      new Notice(`Workflow failed: ${event.error}`);
      if (this.currentView === "agents") {
        this.render();
      }
    });
    this.register(() => unsubWorkflowFailed());
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
          `Analyze the health of my note "${this.noteVitals.title}" and suggest improvements`,
        );
        break;
      case "links":
        this.prefillChatAndSwitch(
          `Show me all the connections for "${this.noteVitals.title}" and suggest new links`,
        );
        break;
      case "freshness":
        this.prefillChatAndSwitch(
          `What has changed in "${this.noteVitals.title}" and what should I review?`,
        );
        break;
    }
  }

  // ============ Utilities ============

  private async openFile(path: string): Promise<void> {
    await this.kernel.obsidian.openFile(path);
  }
}
