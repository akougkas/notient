import { Modal, App, TextAreaComponent, ButtonComponent, setIcon } from "obsidian";
import type { AgentTask } from "../types/agentTask";
import type { Kernel } from "../core/kernel";
import type { LMStudioService, ChatMessage } from "../services/lmstudio";
import type { SearchPipeline } from "../core/search/pipeline";
import type { VaultContextBuilder } from "../core/context/vaultContextBuilder";

export class TaskModal extends Modal {
    private chatContainerEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendBtnContainerEl: HTMLElement | null = null;
    private streamingBubbleEl: HTMLElement | null = null;
    private isStreamActive = false;
    private abortController: AbortController | null = null;
    private streamingContent = "";
    private notePreviewContent: string | null = null;

    constructor(app: App, private kernel: Kernel, private task: AgentTask) {
        super(app);
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

        // Add user message
        this.task.chatHistory.push({
            role: 'user',
            content: text
        });

        // Re-render chat to show user message
        this.renderChatHistory();
        this.scrollToBottom();

        // Call LLM
        await this.generateResponse();
    }

    private async generateResponse(): Promise<void> {
        const lmStudio = this.kernel.getService<LMStudioService>("lmstudio");
        if (!lmStudio?.isReady()) {
            this.task.chatHistory.push({
                role: 'assistant',
                content: "Error: AI service not available. Please check your LM Studio connection."
            });
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
            // Build context for the response
            const searchPipeline = this.kernel.getService<SearchPipeline>("search");
            const contextBuilder = this.kernel.getService<VaultContextBuilder>("context");

            // Get the last user query
            const userMessages = this.task.chatHistory.filter(m => m.role === 'user');
            const query = userMessages[userMessages.length - 1]?.content || "";

            // CRITICAL: Load the current note content (use cached version if we have it)
            let currentNoteData: { title: string; path: string; content: string } | undefined;
            
            if (this.task.notePath && this.task.notePath !== "unknown") {
                try {
                    // Use the full note content, not just the truncated preview
                    const content = await this.kernel.obsidian.readFileByPath(this.task.notePath);
                    if (content) {
                        currentNoteData = {
                            title: this.task.noteTitle,
                            path: this.task.notePath,
                            content: content,
                        };
                    }
                } catch {
                    // Proceed without current note
                }
            }

            let contextSummary = "No vault context available.";
            const relevantNotes: Array<{ title: string; path: string; text: string }> = [];

            // Search for related context
            if (searchPipeline && query) {
                try {
                    // Search using query + note title for better related content
                    const searchQuery = currentNoteData 
                        ? `${query} ${currentNoteData.title}` 
                        : query;
                        
                    const results = await searchPipeline.search(searchQuery, { 
                        topK: 7, 
                        enableReranking: true 
                    });
                    
                    if (contextBuilder && results.length > 0) {
                        const ctx = contextBuilder.buildForQuery(query, results);
                        contextSummary = ctx?.contextSummary || contextSummary;
                    }
                    
                    // Add related notes (exclude current note)
                    for (const r of results) {
                        if (currentNoteData && r.path === currentNoteData.path) continue;
                        if (relevantNotes.length >= 5) break;
                        
                        relevantNotes.push({
                            title: r.title,
                            path: r.path,
                            text: r.chunks[0]?.text || "",
                        });
                    }
                } catch {
                    // Continue without RAG context
                }
            }

            // Build system prompt with FULL vault awareness
            const systemPrompt = lmStudio.buildChatSystemPrompt(
                contextSummary, 
                relevantNotes,
                currentNoteData,  // Include the actual note content!
                query             // Include query for task instructions
            );

            // Build messages (last 10 for sliding window)
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                ...this.task.chatHistory.slice(-10).map(m => ({
                    role: m.role as 'user' | 'assistant' | 'system',
                    content: m.content,
                })),
            ];

            // Stream the response
            for await (const chunk of lmStudio.chatStream(messages, this.abortController.signal)) {
                if (!this.isStreamActive) break;

                this.streamingContent += chunk;
                this.updateStreamingBubble();
                this.scrollToBottom();
            }

            // If completed successfully (not cancelled), save the response
            if (this.isStreamActive && this.streamingContent) {
                this.task.chatHistory.push({
                    role: 'assistant',
                    content: this.streamingContent,
                });
            }

        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                // Real error - add error message
                this.task.chatHistory.push({
                    role: 'assistant',
                    content: `Error: ${(error as Error).message || 'Unknown error'}`,
                });
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
            this.kernel.eventBus.emit('agent:task-update', { task: this.task });
        }
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
