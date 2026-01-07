import { Modal, App, TextAreaComponent, ButtonComponent, setIcon } from "obsidian";
import type { Kernel } from "../core/kernel";
import type { AgentTask } from "../core/agent/types";
import type { NotientAgent } from "../core/agent";
import { ChatSession } from "../core/chat";

export class TaskModal extends Modal {
    private chatContainerEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendBtnContainerEl: HTMLElement | null = null;
    private streamingBubbleEl: HTMLElement | null = null;
    private isStreamActive = false;
    private abortController: AbortController | null = null;
    private streamingContent = "";
    private notePreviewContent: string | null = null;

    // New architecture: ChatSession for history management
    private session: ChatSession;

    constructor(app: App, private kernel: Kernel, private task: AgentTask) {
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
                this.notePreviewContent = content.length > 500
                    ? content.slice(0, 500) + "..."
                    : content;
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
            text: this.formatStatus(this.task.status)
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
            this.task.result.citations.forEach(path => {
                const li = list.createEl("li");
                li.createEl("a", {
                    text: path.split('/').pop()?.replace('.md', '') || path,
                    href: "#"
                }).addEventListener("click", () => {
                    this.app.workspace.openLinkText(path, "", false);
                });
            });
        }

        // Chat Container
        this.chatContainerEl = body.createDiv({ cls: "nv2-chat-container" });
        this.renderChatHistory();
    }

    private renderChatInterface(container: HTMLElement): void {
        const footer = container.createDiv({ cls: "nv2-task-modal-footer" });
        const inputContainer = footer.createDiv({ cls: "nv2-chat-input-container" });

        const ta = new TextAreaComponent(inputContainer)
            .setPlaceholder("Ask a follow-up... (Enter to send)")
            .setDisabled(this.isStreamActive);

        this.inputEl = ta.inputEl;
        this.inputEl.rows = 1;

        // Auto-resize
        this.inputEl.addEventListener("input", () => {
            if (this.inputEl) {
                this.inputEl.style.height = "auto";
                this.inputEl.style.height = (this.inputEl.scrollHeight) + "px";
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
        } else {
            new ButtonComponent(this.sendBtnContainerEl)
                .setIcon("send")
                .setTooltip("Send message")
                .onClick(() => this.handleSend());
        }
    }

    private renderChatHistory(): void {
        if (!this.chatContainerEl) return;
        this.chatContainerEl.empty();

        // Render all completed messages
        this.task.chatHistory.forEach(msg => {
            if (msg.role === 'system') return;

            const bubble = this.chatContainerEl!.createDiv({
                cls: `nv2-chat-bubble nv2-bubble-${msg.role}`
            });

            this.renderMessageContent(bubble, msg.content);
        });

        // If streaming, add a streaming bubble
        if (this.isStreamActive && this.streamingContent) {
            this.streamingBubbleEl = this.chatContainerEl.createDiv({
                cls: "nv2-chat-bubble nv2-bubble-assistant nv2-chat-bubble--streaming"
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
                    cls: "nv2-chat-bubble nv2-bubble-assistant nv2-chat-bubble--streaming"
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

        parts.forEach(part => {
            if (part.startsWith('[[') && part.endsWith(']]')) {
                const linkText = part.slice(2, -2);
                container.createEl("a", {
                    text: linkText,
                    cls: "internal-link",
                    href: "#"
                }).addEventListener("click", () => {
                    this.app.workspace.openLinkText(linkText, "", false);
                });
            } else {
                // Handle newlines
                const lines = part.split('\n');
                lines.forEach((line, i) => {
                    if (i > 0) container.createEl("br");
                    container.createSpan({ text: line });
                });
            }
        });
    }

    private async handleSend(): Promise<void> {
        if (!this.inputEl || this.isStreamActive) return;

        const text = this.inputEl.value.trim();
        if (!text) return;

        // Clear input
        this.inputEl.value = "";
        this.inputEl.style.height = "auto";

        // Add user message using ChatSession
        this.session.addUserMessage(text);
        this.task.chatHistory = this.session.getMessagesForLLM();

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
            this.addErrorMessage("Error: AI service not available. Please check your LM Studio connection.");
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

                    case "complete":
                        // Save the complete response
                        this.session.addAssistantMessage(event.result.data as string);
                        this.task.chatHistory = this.session.getMessagesForLLM();
                        this.task.result = event.result;
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
        this.task.chatHistory = this.session.getMessagesForLLM();
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
            case 'search': icon = "search"; break;
            case 'context': icon = "book-open"; break;
            case 'chat': icon = "message-square"; break;
        }
        setIcon(el, icon);
    }

    private formatStatus(status: string): string {
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
}
