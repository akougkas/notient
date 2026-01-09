import { type App, ButtonComponent, Modal, TextAreaComponent, setIcon } from "obsidian";
import type { NotientAgent } from "../../core/agent";
import type { AgentTask } from "../../core/agent/types";
import type { ActionApplier, ActionHistory, TrustLevelManager } from "../../core/agentic";
import type { ProposedAction, RiskLevel } from "../../core/agentic/types";
import { ChatSession } from "../../core/chat";
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

    // Load note preview content
    await this.loadNotePreview();

    this.renderHeader(contentEl);
    this.renderContent(contentEl);
    this.renderChatInterface(contentEl);

    // Scroll to bottom of chat
    setTimeout(() => this.scrollToBottom(), 100);
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
    // Use exportAsChatMessages() to preserve full history (not truncated getMessagesForLLM())
    this.task.chatHistory = this.session.exportAsChatMessages();

    // Re-render chat to show user message
    this.renderChatHistory();
    this.scrollToBottom();

    // Call agent for response
    await this.generateResponse();
  }

  /**
   * Generate AI response using NotientAgent (new architecture)
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

    // Disable input during streaming
    if (this.inputEl) {
      this.inputEl.disabled = true;
    }

    try {
      // Use the agent to execute with streaming
      // The agent handles: context building, search, prompt construction
      for await (const event of agent.executeStreaming(this.task, this.abortController.signal)) {
        if (!this.isStreamActive) break;

        switch (event.type) {
          case "chunk":
            this.streamingContent += event.content;
            this.updateStreamingBubble();
            this.scrollToBottom();
            break;

          case "citations":
            // Update task with citations for display
            if (!this.task.result) {
              this.task.result = { type: "chat", data: "", citations: [] };
            }
            this.task.result.citations = event.paths;
            break;

          case "actions":
            // Store proposed actions and render them
            this.pendingActions = event.actions;
            this.renderProposedActions();
            break;

          case "complete":
            // Save the complete response
            this.session.addAssistantMessage(event.result.data as string);
            // Use exportAsChatMessages() to preserve full history
            this.task.chatHistory = this.session.exportAsChatMessages();
            this.task.result = event.result;
            // Update pending actions from result if available
            if (event.result.actions) {
              this.pendingActions = event.result.actions;
              this.renderProposedActions();
            }
            break;

          case "error":
            throw event.error;
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        // Real error - add error message
        this.addErrorMessage(`Error: ${(error as Error).message || "Unknown error"}`);
      }
      // If AbortError, we intentionally don't save the partial response
    } finally {
      this.isStreamActive = false;
      this.streamingContent = "";
      this.streamingBubbleEl = null;
      this.abortController = null;

      // Re-enable input
      if (this.inputEl) {
        this.inputEl.disabled = false;
        this.inputEl.focus();
      }

      // Final re-render and button update
      this.renderChatHistory();
      this.updateSendButton();
      this.scrollToBottom();

      // Emit update so sidebar reflects changes
      this.kernel.eventBus.emit("agent:task-update", { task: this.task });
    }
  }

  /**
   * Helper to add an error message to chat
   */
  private addErrorMessage(content: string): void {
    this.session.addAssistantMessage(content);
    // Use exportAsChatMessages() to preserve full history
    this.task.chatHistory = this.session.exportAsChatMessages();
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

    // Get services
    const trustManager = this.kernel.getService<TrustLevelManager>("trustLevelManager");
    const hasWriteLock = this.kernel.hasWriteLock;

    // Section header
    const header = this.actionsContainerEl.createDiv({ cls: "nv2-actions-header" });
    header.createEl("h3", { text: "Proposed Actions" });
    header.createSpan({
      cls: "nv2-actions-count",
      text: `(${this.pendingActions.length})`,
    });

    // Actions list
    const list = this.actionsContainerEl.createDiv({ cls: "nv2-actions-list" });

    for (const action of this.pendingActions) {
      const actionEl = list.createDiv({ cls: "nv2-action-item" });
      const isApplied = this.appliedActionRecordIds.has(action.id);

      // Risk badge
      const riskBadge = actionEl.createSpan({
        cls: `nv2-risk-badge nv2-risk-${action.risk}`,
        text: action.risk.toUpperCase(),
      });
      riskBadge.setAttribute("aria-label", this.getRiskDescription(action.risk));

      // Action content
      const contentEl = actionEl.createDiv({ cls: "nv2-action-content" });

      // Title with applied indicator
      const titleEl = contentEl.createDiv({ cls: "nv2-action-title" });
      if (isApplied) {
        const checkIcon = titleEl.createSpan({ cls: "nv2-action-applied-icon" });
        setIcon(checkIcon, "check-circle");
        titleEl.createSpan({ text: ` ${action.title}` });
      } else {
        titleEl.setText(action.title);
      }

      // Type and target
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

      // Reason
      if (action.reason) {
        const reasonEl = contentEl.createDiv({ cls: "nv2-action-reason" });
        reasonEl.createSpan({ text: action.reason });
      }

      // Buttons container
      const btnContainer = actionEl.createDiv({ cls: "nv2-action-buttons" });

      if (isApplied) {
        // Show Undo button for applied actions
        const undoBtn = new ButtonComponent(btnContainer)
          .setIcon("undo")
          .setTooltip("Undo this action")
          .onClick(() => this.handleUndo(action));
        undoBtn.buttonEl.addClass("nv2-btn-undo");
      } else {
        // Show Apply button for pending actions
        const trustDecision = trustManager?.evaluate(action, hasWriteLock);
        const canApply = hasWriteLock && trustDecision?.allowed;
        const needsConfirm = trustDecision?.requiresConfirmation ?? true;

        let tooltip = "Apply this action";
        if (!hasWriteLock) {
          tooltip = "Cannot apply: write lock not held";
        } else if (!trustDecision?.allowed) {
          tooltip = trustDecision?.reason || "Action not allowed";
        } else if (needsConfirm) {
          tooltip = "Click to apply (requires confirmation)";
        }

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
    }

    // Status info
    const infoEl = this.actionsContainerEl.createDiv({ cls: "nv2-actions-info" });
    if (!hasWriteLock) {
      setIcon(infoEl.createSpan({ cls: "nv2-info-icon nv2-warning" }), "alert-triangle");
      infoEl.createSpan({ text: "Write lock not held - actions disabled" });
    } else {
      setIcon(infoEl.createSpan({ cls: "nv2-info-icon" }), "info");
      infoEl.createSpan({ text: "Click Apply to execute an action" });
    }

    this.scrollToBottom();
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
        content.createDiv({ cls: "nv2-confirm-warning" }).setText("⚠️ This is a high-risk action.");
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
