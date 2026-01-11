import { type App, ButtonComponent, Modal, TextAreaComponent, setIcon } from "obsidian";
import type { ChiefOfStaffTask, NotientAgent } from "../../core/agent";
import type { AgentTask } from "../../core/agent/types";
import type { ActionApplier, ActionHistory, TrustLevelManager } from "../../core/agentic";
import type { ProposedAction, RiskLevel } from "../../core/agentic/types";
import type { AgentEvent, StructuredOutput } from "../../core/agents/types";
import { ChatSession, type ConversationStore } from "../../core/chat";
import type { Kernel } from "../../core/kernel";

export class TaskModal extends Modal {
  private chatContainerEl: HTMLElement | null = null;
  private actionsContainerEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtnContainerEl: HTMLElement | null = null;
  private streamingBubbleEl: HTMLElement | null = null;
  private isStreamActive = false;
  private abortController: AbortController | null = null;
  private streamingContent = "";
  private notePreviewContent: string | null = null;
  private pendingActions: ProposedAction[] = [];
  /** Track applied action IDs for undo support */
  private appliedActionRecordIds: Map<string, string> = new Map();

  // New architecture: ChatSession for history management
  private session: ChatSession;

  constructor(
    app: App,
    private kernel: Kernel,
    private task: AgentTask,
  ) {
    super(app);
    // Initialize chat session with existing task history
    this.session = new ChatSession({ maxHistoryLength: 100, maxLLMMessages: 10 });
    this.session.importFromChatMessages(task.chatHistory);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nv2-task-modal");

    // Load persisted conversation history from ConversationStore
    await this.loadPersistedHistory();

    // Load note preview content
    await this.loadNotePreview();

    this.renderHeader(contentEl);
    this.renderContent(contentEl);
    this.renderChatInterface(contentEl);

    // Scroll to bottom of chat
    setTimeout(() => this.scrollToBottom(), 100);
  }

  /**
   * Load persisted conversation history for the current note
   */
  private async loadPersistedHistory(): Promise<void> {
    if (!this.task.notePath || this.task.notePath === "unknown") {
      return;
    }

    const conversationStore = this.kernel.getService<ConversationStore>("conversationStore");
    if (!conversationStore) {
      return;
    }

    const persistedHistory = conversationStore.getHistory(this.task.notePath);
    if (persistedHistory.length > 0) {
      // Use persisted history (ExtendedChatMessage[]) instead of task.chatHistory
      this.session.importMessages(persistedHistory);
      // Sync back to task.chatHistory for compatibility
      this.task.chatHistory = this.session.getMessages();
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Abort any ongoing streaming (discard partial)
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clean up streaming state
    this.isStreamActive = false;
    this.streamingContent = "";
    this.streamingBubbleEl = null;

    // Persist conversation history on close
    this.saveConversationHistory();
  }

  /**
   * Save conversation history to ConversationStore
   */
  private saveConversationHistory(): void {
    if (!this.task.notePath || this.task.notePath === "unknown") {
      return;
    }

    const conversationStore = this.kernel.getService<ConversationStore>("conversationStore");
    if (!conversationStore) {
      return;
    }

    // Get all messages from the session
    const messages = this.session.getMessages();

    // Get existing persisted history to find new messages
    const persistedHistory = conversationStore.getHistory(this.task.notePath);
    const existingIds = new Set(persistedHistory.map((m) => m.id));

    // Append only new messages (ones that don't have a matching ID)
    for (const msg of messages) {
      // Skip system messages
      if (msg.role === "system") continue;

      // Generate a stable ID based on content if not present
      const msgId = `${msg.role}-${this.hashContent(msg.content)}`;

      if (!existingIds.has(msgId)) {
        conversationStore.appendMessage(this.task.notePath, {
          id: msgId,
          role: msg.role,
          content: msg.content,
          timestamp: new Date(),
        });
        existingIds.add(msgId);
      }
    }
  }

  /**
   * Simple hash for content-based deduplication
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(content.length, 100); i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Load the note content for preview
   */
  private async loadNotePreview(): Promise<void> {
    if (!this.task.notePath || this.task.notePath === "unknown") {
      this.notePreviewContent = null;
      return;
    }

    try {
      const content = await this.kernel.obsidian.readFileByPath(this.task.notePath);
      if (content) {
        // Truncate to first 500 chars for preview
        this.notePreviewContent = content.length > 500 ? `${content.slice(0, 500)}...` : content;
      }
    } catch {
      this.notePreviewContent = null;
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "nv2-task-modal-header" });

    // Icon & Title
    const titleSection = header.createDiv({ cls: "nv2-task-modal-title-section" });
    const iconEl = titleSection.createDiv({ cls: "nv2-task-icon" });
    this.renderTaskIcon(iconEl, this.task.agent);

    titleSection.createEl("h2", { text: this.task.noteTitle });

    // Status Badge
    header.createDiv({
      cls: `nv2-task-status-badge nv2-status-${this.task.status}`,
      text: this.formatStatus(this.task.status),
    });
  }

  private renderContent(container: HTMLElement): void {
    const body = container.createDiv({ cls: "nv2-task-modal-body" });

    // Note Preview Section (if available)
    if (this.notePreviewContent) {
      const previewSection = body.createDiv({ cls: "nv2-note-preview" });
      previewSection.createDiv({ cls: "nv2-note-preview-title", text: "Note Preview" });
      previewSection.createDiv({ cls: "nv2-note-preview-content", text: this.notePreviewContent });
    }

    // Show citations if any (RAG sources)
    if (this.task.result?.citations && this.task.result.citations.length > 0) {
      const sourcesDiv = body.createDiv({ cls: "nv2-task-sources" });
      sourcesDiv.createDiv({ cls: "nv2-label", text: "Sources used:" });
      const list = sourcesDiv.createEl("ul");
      for (const path of this.task.result.citations) {
        const li = list.createEl("li");
        li.createEl("a", {
          text: path.split("/").pop()?.replace(".md", "") || path,
          href: "#",
        }).addEventListener("click", () => {
          this.app.workspace.openLinkText(path, "", false);
        });
      }
    }

    // Chat Container
    this.chatContainerEl = body.createDiv({ cls: "nv2-chat-container" });
    this.renderChatHistory();

    // Proposed Actions Container (below chat)
    this.actionsContainerEl = body.createDiv({ cls: "nv2-actions-container" });

    // Load any existing actions from task result
    if (this.task.result?.actions && this.task.result.actions.length > 0) {
      this.pendingActions = this.task.result.actions;
      this.renderProposedActions();
    }
  }

  private renderChatInterface(container: HTMLElement): void {
    const footer = container.createDiv({ cls: "nv2-task-modal-footer" });
    const inputContainer = footer.createDiv({ cls: "nv2-chat-input-container" });

    const ta = new TextAreaComponent(inputContainer)
      .setPlaceholder("Ask a follow-up... (Enter to send)")
      .setDisabled(this.isStreamActive);

    this.inputEl = ta.inputEl;
    this.inputEl.rows = 1;
    this.inputEl.setAttribute("aria-label", "Chat message input");
    this.inputEl.setAttribute("role", "textbox");

    // Auto-resize
    this.inputEl.addEventListener("input", () => {
      if (this.inputEl) {
        this.inputEl.style.height = "auto";
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
      }
    });

    // Enter to send, Shift+Enter for newline
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Send Button container (for dynamic updates)
    this.sendBtnContainerEl = inputContainer.createDiv({ cls: "nv2-chat-actions" });
    this.updateSendButton();
  }

  /**
   * Update just the send/stop button without re-rendering everything
   */
  private updateSendButton(): void {
    if (!this.sendBtnContainerEl) return;

    this.sendBtnContainerEl.empty();

    if (this.isStreamActive) {
      const stopBtn = new ButtonComponent(this.sendBtnContainerEl)
        .setIcon("square")
        .setTooltip("Stop and discard")
        .onClick(() => this.cancelGeneration());
      stopBtn.buttonEl.addClass("nv2-btn-stop");
      stopBtn.buttonEl.setAttribute("aria-label", "Stop generation");
    } else {
      const sendBtn = new ButtonComponent(this.sendBtnContainerEl)
        .setIcon("send")
        .setTooltip("Send message")
        .onClick(() => this.handleSend());
      sendBtn.buttonEl.setAttribute("aria-label", "Send message");
    }
  }

  private renderChatHistory(): void {
    if (!this.chatContainerEl) return;
    this.chatContainerEl.empty();

    // Render all completed messages
    for (const msg of this.task.chatHistory) {
      if (msg.role === "system") continue;

      const bubble = this.chatContainerEl?.createDiv({
        cls: `nv2-chat-bubble nv2-bubble-${msg.role}`,
      });

      this.renderMessageContent(bubble, msg.content);
    }

    // If streaming, add a streaming bubble
    if (this.isStreamActive && this.streamingContent) {
      this.streamingBubbleEl = this.chatContainerEl.createDiv({
        cls: "nv2-chat-bubble nv2-bubble-assistant nv2-chat-bubble--streaming",
      });
      this.streamingBubbleEl.setAttribute("aria-live", "polite");
      this.streamingBubbleEl.setAttribute("aria-label", "Assistant is typing");
      this.renderMessageContent(this.streamingBubbleEl, this.streamingContent);
      // Add typing cursor
      this.streamingBubbleEl.createSpan({ cls: "nv2-typing-cursor" });
    }
  }

  /**
   * Update streaming bubble in-place without full re-render
   */
  private updateStreamingBubble(): void {
    if (!this.streamingBubbleEl) {
      // Need to create it
      if (this.chatContainerEl) {
        this.streamingBubbleEl = this.chatContainerEl.createDiv({
          cls: "nv2-chat-bubble nv2-bubble-assistant nv2-chat-bubble--streaming",
        });
      }
    }

    if (this.streamingBubbleEl) {
      this.streamingBubbleEl.empty();
      this.renderMessageContent(this.streamingBubbleEl, this.streamingContent);
      this.streamingBubbleEl.createSpan({ cls: "nv2-typing-cursor" });
    }
  }

  private renderMessageContent(container: HTMLElement, content: string): void {
    // Parse [[Note Name]] links and render with clickable links
    const parts = content.split(/(\[\[.*?\]\])/g);

    for (const part of parts) {
      if (part.startsWith("[[") && part.endsWith("]]")) {
        const linkText = part.slice(2, -2);
        container
          .createEl("a", {
            text: linkText,
            cls: "internal-link",
            href: "#",
          })
          .addEventListener("click", () => {
            this.app.workspace.openLinkText(linkText, "", false);
          });
      } else {
        // Handle newlines
        const lines = part.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) container.createEl("br");
          container.createSpan({ text: lines[i] });
        }
      }
    }
  }

  private async handleSend(): Promise<void> {
    if (!this.inputEl || this.isStreamActive) return;

    let text = this.inputEl.value.trim();
    if (!text) return;

    // Basic input validation and sanitization
    // Limit message length to prevent token overflow
    const MAX_MESSAGE_LENGTH = 4000;
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH);
    }

    // Clear input
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // Add user message using ChatSession
    this.session.addUserMessage(text);
    this.task.chatHistory = this.session.getMessages();

    // Re-render chat to show user message
    this.renderChatHistory();
    this.scrollToBottom();

    // Call agent for response
    await this.generateResponse();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Response Generation Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Handle chunk event during streaming */
  private handleChunkEvent(content: string): void {
    this.streamingContent += content;
    this.updateStreamingBubble();
    this.scrollToBottom();
  }

  /** Handle citations event */
  private handleCitationsEvent(paths: string[], citations: string[]): void {
    citations.push(...paths);
    if (!this.task.result) {
      this.task.result = { type: "chat", data: "", citations: [] };
    }
    this.task.result.citations = citations;
  }

  /** Handle complete event - extract actions from output */
  private handleCompleteEvent(
    output:
      | StructuredOutput
      | {
          kind: "conversational";
          content?: string;
          delegatedResults?: Array<{ output: StructuredOutput }>;
        },
    citations: string[],
  ): void {
    let responseContent = this.streamingContent;

    if (output.kind === "conversational") {
      responseContent = output.content || this.streamingContent;
      this.extractDelegatedActions(output.delegatedResults);
    } else if (output.kind === "structured") {
      const data = output.data as { actions?: ProposedAction[] };
      if (data.actions) {
        this.pendingActions = data.actions;
      }
    }

    this.session.addAssistantMessage(responseContent);
    this.task.chatHistory = this.session.getMessages();
    this.task.result = {
      type: this.pendingActions.length > 0 ? "action_plan" : "chat",
      data: responseContent,
      citations,
      actions: this.pendingActions.length > 0 ? this.pendingActions : undefined,
    };

    if (this.pendingActions.length > 0) {
      this.renderProposedActions();
    }
  }

  /** Extract actions from delegated results */
  private extractDelegatedActions(delegatedResults?: Array<{ output: StructuredOutput }>): void {
    if (!delegatedResults) return;
    for (const dr of delegatedResults) {
      if (dr.output.kind === "structured") {
        const data = dr.output.data as { actions?: ProposedAction[] };
        if (data.actions) {
          this.pendingActions.push(...data.actions);
        }
      }
    }
  }

  /** Cleanup after streaming completes */
  private cleanupStreaming(): void {
    this.isStreamActive = false;
    this.streamingContent = "";
    this.streamingBubbleEl = null;
    this.abortController = null;

    if (this.inputEl) {
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }

    this.renderChatHistory();
    this.updateSendButton();
    this.scrollToBottom();
    this.kernel.eventBus.emit("agent:task-update", { task: this.task });
  }

  /**
   * Generate AI response using NotientAgent (ChiefOfStaff multi-agent system)
   * UI-only: delegates all AI logic to the agent
   */
  private async generateResponse(): Promise<void> {
    const agent = this.kernel.getService<NotientAgent>("agent");
    if (!agent) {
      this.addErrorMessage(
        "Error: AI service not available. Please check your LM Studio connection.",
      );
      this.renderChatHistory();
      return;
    }

    this.isStreamActive = true;
    this.streamingContent = "";
    this.abortController = new AbortController();
    this.updateSendButton();
    if (this.inputEl) this.inputEl.disabled = true;

    const userMessages = this.task.chatHistory.filter((m) => m.role === "user");
    const chiefTask: ChiefOfStaffTask = {
      query: userMessages[userMessages.length - 1]?.content || "",
      notePath: this.task.notePath,
      noteTitle: this.task.noteTitle,
      chatHistory: this.task.chatHistory,
    };

    const citations: string[] = [];

    try {
      for await (const event of agent.execute(chiefTask, this.abortController.signal)) {
        if (!this.isStreamActive) break;
        this.processAgentEvent(event, citations);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        this.addErrorMessage(`Error: ${(error as Error).message || "Unknown error"}`);
      }
    } finally {
      this.cleanupStreaming();
    }
  }

  /** Process a single agent event */
  private processAgentEvent(event: AgentEvent, citations: string[]): void {
    switch (event.type) {
      case "chunk":
        this.handleChunkEvent(event.content);
        break;
      case "citations":
        this.handleCitationsEvent(event.paths, citations);
        break;
      case "complete":
        // biome-ignore lint/suspicious/noExplicitAny: AgentOutput includes multiple kinds
        this.handleCompleteEvent(event.output as any, citations);
        break;
      case "error":
        throw event.error;
      // No-op for progress events
      case "started":
      case "progress":
      case "delegation-started":
      case "delegation-complete":
        break;
    }
  }

  /**
   * Helper to add an error message to chat
   */
  private addErrorMessage(content: string): void {
    this.session.addAssistantMessage(content);
    this.task.chatHistory = this.session.getMessages();
  }

  /**
   * Cancel generation and discard partial response entirely
   */
  private cancelGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
    }

    // Discard streaming content (don't save it)
    this.isStreamActive = false;
    this.streamingContent = "";
    this.streamingBubbleEl = null;

    // Re-render without the partial response
    this.renderChatHistory();
    this.updateSendButton();

    // Re-enable input
    if (this.inputEl) {
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }

  private scrollToBottom(): void {
    if (this.chatContainerEl) {
      this.chatContainerEl.scrollTop = this.chatContainerEl.scrollHeight;
    }
  }

  private renderTaskIcon(el: HTMLElement, type: string): void {
    let icon = "bot";
    switch (type) {
      case "search":
        icon = "search";
        break;
      case "context":
        icon = "book-open";
        break;
      case "chat":
        icon = "message-square";
        break;
    }
    setIcon(el, icon);
  }

  private formatStatus(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  /**
   * Render proposed actions from the LLM
   * Shows risk badge, title, target path, and Apply/Undo buttons
   */
  private renderProposedActions(): void {
    if (!this.actionsContainerEl) return;

    this.actionsContainerEl.empty();

    if (this.pendingActions.length === 0) {
      return;
    }

    const trustManager = this.kernel.getService<TrustLevelManager>("trustLevelManager");
    const hasWriteLock = this.kernel.hasWriteLock;

    this.renderActionsHeader();

    const list = this.actionsContainerEl.createDiv({ cls: "nv2-actions-list" });
    for (const action of this.pendingActions) {
      this.renderActionItem(list, action, trustManager ?? undefined, hasWriteLock);
    }

    this.renderActionsStatusInfo(hasWriteLock);
    this.scrollToBottom();
  }

  /** Render the actions section header */
  private renderActionsHeader(): void {
    if (!this.actionsContainerEl) return;

    const header = this.actionsContainerEl.createDiv({ cls: "nv2-actions-header" });
    header.createEl("h3", { text: "Proposed Actions" });
    header.createSpan({
      cls: "nv2-actions-count",
      text: `(${this.pendingActions.length})`,
    });
  }

  /** Render a single action item with its controls */
  private renderActionItem(
    list: HTMLElement,
    action: ProposedAction,
    trustManager: TrustLevelManager | undefined,
    hasWriteLock: boolean,
  ): void {
    const actionEl = list.createDiv({ cls: "nv2-action-item" });
    const isApplied = this.appliedActionRecordIds.has(action.id);

    this.renderActionRiskBadge(actionEl, action);
    this.renderActionContent(actionEl, action, isApplied);
    this.renderActionButtons(actionEl, action, isApplied, trustManager, hasWriteLock);
  }

  /** Render the risk level badge */
  private renderActionRiskBadge(container: HTMLElement, action: ProposedAction): void {
    const riskBadge = container.createSpan({
      cls: `nv2-risk-badge nv2-risk-badge--${action.risk}`,
      text: action.risk.toUpperCase(),
    });
    riskBadge.setAttribute("aria-label", this.getRiskDescription(action.risk));
  }

  /** Render the action content (title, meta, reason) */
  private renderActionContent(
    container: HTMLElement,
    action: ProposedAction,
    isApplied: boolean,
  ): void {
    const contentEl = container.createDiv({ cls: "nv2-action-content" });

    const titleEl = contentEl.createDiv({ cls: "nv2-action-title" });
    if (isApplied) {
      const checkIcon = titleEl.createSpan({ cls: "nv2-action-applied-icon" });
      setIcon(checkIcon, "check-circle");
      titleEl.createSpan({ text: ` ${action.title}` });
    } else {
      titleEl.setText(action.title);
    }

    const metaEl = contentEl.createDiv({ cls: "nv2-action-meta" });
    metaEl.createSpan({
      cls: "nv2-action-type",
      text: this.formatActionType(action.type),
    });
    metaEl.createSpan({ text: " → " });
    metaEl.createSpan({
      cls: "nv2-action-target",
      text: action.target.split("/").pop() || action.target,
    });

    if (action.reason) {
      const reasonEl = contentEl.createDiv({ cls: "nv2-action-reason" });
      reasonEl.createSpan({ text: action.reason });
    }
  }

  /** Render the apply/undo buttons for an action */
  private renderActionButtons(
    container: HTMLElement,
    action: ProposedAction,
    isApplied: boolean,
    trustManager: TrustLevelManager | undefined,
    hasWriteLock: boolean,
  ): void {
    const btnContainer = container.createDiv({ cls: "nv2-action-buttons" });

    if (isApplied) {
      const undoBtn = new ButtonComponent(btnContainer)
        .setIcon("undo")
        .setTooltip("Undo this action")
        .onClick(() => this.handleUndo(action));
      undoBtn.buttonEl.addClass("nv2-btn-undo");
      return;
    }

    const trustDecision = trustManager?.evaluate(action, hasWriteLock);
    const canApply = hasWriteLock && trustDecision?.allowed;
    const needsConfirm = trustDecision?.requiresConfirmation ?? true;
    const tooltip = this.getApplyButtonTooltip(hasWriteLock, trustDecision, needsConfirm);

    const applyBtn = new ButtonComponent(btnContainer)
      .setIcon("check")
      .setTooltip(tooltip)
      .setDisabled(!canApply)
      .onClick(() => this.handleApply(action, needsConfirm));

    applyBtn.buttonEl.addClass("nv2-btn-apply");
    if (!canApply) {
      applyBtn.buttonEl.addClass("nv2-btn-disabled");
    }
  }

  /** Get the tooltip text for the apply button based on state */
  private getApplyButtonTooltip(
    hasWriteLock: boolean,
    trustDecision: { allowed: boolean; reason?: string } | undefined,
    needsConfirm: boolean,
  ): string {
    if (!hasWriteLock) {
      return "Cannot apply: write lock not held";
    }
    if (!trustDecision?.allowed) {
      return trustDecision?.reason || "Action not allowed";
    }
    if (needsConfirm) {
      return "Click to apply (requires confirmation)";
    }
    return "Apply this action";
  }

  /** Render the status info bar at the bottom of actions */
  private renderActionsStatusInfo(hasWriteLock: boolean): void {
    if (!this.actionsContainerEl) return;

    const infoEl = this.actionsContainerEl.createDiv({ cls: "nv2-actions-info" });
    if (hasWriteLock) {
      setIcon(infoEl.createSpan({ cls: "nv2-info-icon" }), "info");
      infoEl.createSpan({ text: "Click Apply to execute an action" });
    } else {
      setIcon(infoEl.createSpan({ cls: "nv2-info-icon nv2-warning" }), "alert-triangle");
      infoEl.createSpan({ text: "Write lock not held - actions disabled" });
    }
  }

  /**
   * Handle Apply button click
   */
  private async handleApply(action: ProposedAction, needsConfirm: boolean): Promise<void> {
    const actionApplier = this.kernel.getService<ActionApplier>("actionApplier");
    if (!actionApplier) {
      this.kernel.obsidian.notice("Action applier not available");
      return;
    }

    // For medium/high risk, show a simple confirmation
    if (needsConfirm) {
      const confirmed = await this.showConfirmDialog(action);
      if (!confirmed) return;
    }

    // Apply the action
    const result = await actionApplier.applyConfirmed(action, this.task.id);

    if (result.success && result.recordId) {
      // Track the applied action for undo
      this.appliedActionRecordIds.set(action.id, result.recordId);
      this.kernel.obsidian.notice(`Applied: ${action.title}`);
      this.renderProposedActions();

      // Emit update to refresh sidebar
      this.kernel.eventBus.emit("agent:task-update", { task: this.task });
    } else {
      this.kernel.obsidian.notice(`Failed: ${result.error || "Unknown error"}`);
    }
  }

  /**
   * Handle Undo button click
   */
  private async handleUndo(action: ProposedAction): Promise<void> {
    const actionHistory = this.kernel.getService<ActionHistory>("actionHistory");
    if (!actionHistory) {
      this.kernel.obsidian.notice("Action history not available");
      return;
    }

    const recordId = this.appliedActionRecordIds.get(action.id);
    if (!recordId) {
      this.kernel.obsidian.notice("Cannot undo: record not found");
      return;
    }

    const result = await actionHistory.undo(recordId);

    if (result.success) {
      this.appliedActionRecordIds.delete(action.id);
      this.kernel.obsidian.notice(`Undone: ${action.title}`);
      this.renderProposedActions();

      // Emit update to refresh sidebar
      this.kernel.eventBus.emit("agent:task-update", { task: this.task });
    } else {
      this.kernel.obsidian.notice(`Undo failed: ${result.error || "Unknown error"}`);
    }
  }

  /**
   * Show a simple confirmation dialog for actions
   */
  private async showConfirmDialog(action: ProposedAction): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText("Confirm Action");

      const content = modal.contentEl;
      content
        .createDiv({ cls: "nv2-confirm-message" })
        .setText(
          `Apply "${action.title}"?\n\nThis will ${this.getActionVerb(action.type)} ${action.target.split("/").pop()}.`,
        );

      if (action.risk === "high") {
        const warningDiv = content.createDiv({ cls: "nv2-confirm-warning" });
        const warningIcon = warningDiv.createSpan({ cls: "nv2-confirm-warning-icon" });
        setIcon(warningIcon, "alert-triangle");
        warningDiv.createSpan({ text: "This is a high-risk action." });
      }

      const buttons = content.createDiv({ cls: "nv2-confirm-buttons" });

      new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => {
        modal.close();
        resolve(false);
      });

      new ButtonComponent(buttons)
        .setButtonText("Apply")
        .setCta()
        .onClick(() => {
          modal.close();
          resolve(true);
        });

      modal.open();
    });
  }

  /**
   * Get action verb for confirmation messages
   */
  private getActionVerb(type: string): string {
    switch (type) {
      case "frontmatter_set":
        return "modify the frontmatter of";
      case "frontmatter_add_tags":
        return "add tags to";
      case "append_section":
        return "append a section to";
      case "append_related_links":
        return "add related links to";
      case "move_note":
        return "move";
      default:
        return "modify";
    }
  }

  /**
   * Get human-readable description for risk level
   */
  private getRiskDescription(risk: RiskLevel): string {
    switch (risk) {
      case "low":
        return "Low risk: Safe to apply, easily reversible";
      case "medium":
        return "Medium risk: Requires confirmation before applying";
      case "high":
        return "High risk: Extra confirmation required";
    }
  }

  /**
   * Format action type for display
   */
  private formatActionType(type: string): string {
    return type
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
}
