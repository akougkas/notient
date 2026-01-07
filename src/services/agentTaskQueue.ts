import type { Kernel } from "../core/kernel";
import type { AgentTask } from "../types/agentTask";
import type { LMStudioService, ChatMessage } from "./lmstudio";
import type { SearchPipeline } from "../core/search/pipeline";
import type { VaultContextBuilder } from "../core/context/vaultContextBuilder";

export class AgentTaskQueue {
    private tasks: AgentTask[] = [];
    private currentTask: AgentTask | null = null;
    private currentAbortController: AbortController | null = null;
    private onTaskUpdateCallback?: (task: AgentTask) => void;

    constructor(private kernel: Kernel) { }

    enqueue(task: Omit<AgentTask, 'id' | 'status' | 'startedAt'>): string {
        const id = crypto.randomUUID();
        const newTask: AgentTask = {
            ...task,
            id,
            status: 'queued',
            startedAt: new Date(),
            progress: 0,
            chatHistory: task.chatHistory || []
        };

        this.tasks.push(newTask);
        this.emitUpdate(newTask);

        // Trigger processing (async)
        void this.processNext();

        return id;
    }

    cancel(taskId: string): void {
        const task = this.getById(taskId);
        if (!task) return;

        if (task.status === 'running' || task.status === 'queued') {
            // Abort any ongoing streaming
            if (this.currentTask?.id === taskId && this.currentAbortController) {
                this.currentAbortController.abort();
                this.currentAbortController = null;
            }

            task.status = 'cancelled';
            task.completedAt = new Date();
            this.emitUpdate(task);

            // If it was running, we need to clear currentTask to proceed
            if (this.currentTask?.id === taskId) {
                this.currentTask = null;
                void this.processNext();
            }
        }
    }

    getAll(): AgentTask[] {
        return [...this.tasks];
    }

    getById(taskId: string): AgentTask | undefined {
        return this.tasks.find(t => t.id === taskId);
    }

    onTaskUpdate(callback: (task: AgentTask) => void): void {
        this.onTaskUpdateCallback = callback;
    }

    private async processNext(): Promise<void> {
        if (this.currentTask) return;

        const next = this.tasks.find(t => t.status === 'queued');
        if (!next) return;

        this.currentTask = next;
        next.status = 'running';
        this.emitUpdate(next);

        try {
            await this.executeTask(next);

            // Only mark completed if not already cancelled/failed
            if (next.status === 'running') {
                next.status = 'completed';
                next.completedAt = new Date();
                next.progress = 100;
            }
        } catch (error) {
            if (next.status === 'running') {
                next.status = 'failed';
                next.error = error instanceof Error ? error.message : String(error);
                next.completedAt = new Date();
            }
        } finally {
            this.emitUpdate(next);
            this.currentTask = null;
            this.currentAbortController = null;

            // Process next in queue
            void this.processNext();
        }
    }

    /**
     * Execute a task by calling real AI services
     */
    private async executeTask(task: AgentTask): Promise<void> {
        const lmStudio = this.kernel.getService<LMStudioService>("lmstudio");
        const searchPipeline = this.kernel.getService<SearchPipeline>("search");
        const contextBuilder = this.kernel.getService<VaultContextBuilder>("context");

        // Check if we have the required services
        if (!lmStudio?.isReady()) {
            throw new Error("LM Studio not available - check connection");
        }

        // Get the user query from chat history
        const userMessages = task.chatHistory.filter(m => m.role === 'user');
        const query = userMessages[userMessages.length - 1]?.content;

        if (!query) {
            throw new Error("No query provided for task");
        }

        // Phase 1: Load the CURRENT note content (this is critical for vault awareness!)
        task.progress = 5;
        this.emitUpdate(task);

        let currentNoteData: { title: string; path: string; content: string } | undefined;

        if (task.notePath && task.notePath !== "unknown") {
            try {
                const content = await this.kernel.obsidian.readFileByPath(task.notePath);
                if (content) {
                    currentNoteData = {
                        title: task.noteTitle,
                        path: task.notePath,
                        content: content,
                    };
                    console.log(`[AgentTaskQueue] Loaded current note: ${task.notePath} (${content.length} chars)`);
                }
            } catch (error) {
                console.warn(`[AgentTaskQueue] Failed to load current note ${task.notePath}:`, error);
            }
        }

        // Phase 2: Search for related context (progress 10-30%)
        task.progress = 10;
        this.emitUpdate(task);

        let citations: string[] = [];
        let contextSummary = "No vault context available.";
        const relevantNotes: Array<{ title: string; path: string; text: string }> = [];

        if (searchPipeline && this.kernel.capabilities.search) {
            try {
                // Search using both the query AND the note title for better context
                const searchQuery = currentNoteData 
                    ? `${query} ${currentNoteData.title}` 
                    : query;
                    
                const searchResults = await searchPipeline.search(searchQuery, {
                    topK: 7, // Get more results since we'll filter out current note
                    enableReranking: true,
                });

                task.progress = 20;
                this.emitUpdate(task);

                // Build context from search results
                if (contextBuilder && searchResults.length > 0) {
                    const context = contextBuilder.buildForQuery(query, searchResults);
                    contextSummary = context?.contextSummary || contextSummary;
                }

                // Extract citations and relevant notes (exclude current note)
                for (const result of searchResults) {
                    // Skip the current note - it's already included separately
                    if (currentNoteData && result.path === currentNoteData.path) {
                        continue;
                    }
                    
                    if (relevantNotes.length >= 5) break; // Limit to 5 related notes
                    
                    citations.push(result.path);
                    relevantNotes.push({
                        title: result.title,
                        path: result.path,
                        text: result.chunks[0]?.text || "",
                    });
                }

                task.progress = 30;
                this.emitUpdate(task);
            } catch (error) {
                console.warn("[AgentTaskQueue] Search failed, continuing with current note only:", error);
            }
        }

        // Check if cancelled during search
        if (task.status !== 'running') return;

        // Phase 3: Generate AI response (progress 30-90%)
        task.progress = 40;
        this.emitUpdate(task);

        // Build system prompt with FULL context (current note + RAG results + query)
        const systemPrompt = lmStudio.buildChatSystemPrompt(
            contextSummary, 
            relevantNotes, 
            currentNoteData,  // Pass the actual note content!
            query             // Pass query for task-specific instructions
        );

        console.log(`[AgentTaskQueue] Built prompt: ${systemPrompt.length} chars, ` +
            `currentNote=${!!currentNoteData}, relatedNotes=${relevantNotes.length}`);

        // Build message list for LLM
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...task.chatHistory.slice(-10).map(m => ({
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
            })),
        ];

        // Create abort controller for this task
        this.currentAbortController = new AbortController();

        // Prepare assistant message
        let fullResponse = "";

        try {
            // Stream the response
            for await (const chunk of lmStudio.chatStream(messages, this.currentAbortController.signal)) {
                if (task.status !== 'running') break;

                fullResponse += chunk;

                // Update progress during streaming (40-90%)
                const progressDelta = Math.min(50, fullResponse.length / 20);
                task.progress = Math.min(90, 40 + progressDelta);
                this.emitUpdate(task);
            }
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                // Task was cancelled - don't save partial response
                return;
            }
            throw error;
        }

        // Check if cancelled during streaming
        if (task.status !== 'running') return;

        // Phase 3: Store result (progress 90-100%)
        task.progress = 95;

        // Add assistant response to chat history
        task.chatHistory.push({
            role: 'assistant',
            content: fullResponse,
        });

        // Store result with citations
        task.result = {
            type: 'chat',
            data: fullResponse,
            citations,
        };

        task.progress = 100;
        this.emitUpdate(task);
    }

    private emitUpdate(task: AgentTask): void {
        if (this.onTaskUpdateCallback) {
            this.onTaskUpdateCallback(task);
        }
        this.kernel.eventBus.emit('agent:task-update', { task });
    }
}
