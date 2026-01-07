# Phase 1.7: Backend Completion - Session Prompt

> **For Claude Code Opus 4.5**
> Use "ultrathink" mode for complex architectural decisions.

## Context

You are continuing development on **Notient**, a local-first AI-powered Obsidian plugin. Phase 1.6 (UI/UX Overhaul) is complete. The sidebar now has a two-view layout with Note Vitals and Agent Streams views, styled with the `nv2-*` design system.

**The problem:** The UI looks great but several features are not fully wired to the backend. This phase achieves **UI-backend parity**.

---

## Design Decisions (From User Interview)

These decisions were made in the Phase 1.7 planning session. **Follow them exactly.**

### Chat Interface
| Decision | Choice |
|----------|--------|
| Send behavior | **Enter sends**, Shift+Enter for newlines |
| Cancel mid-stream | **Discard partial response entirely** (remove message) |
| Context window | **Last 10 messages** sliding window |
| RAG citations | **Inline `[[Note Name]]` links** within response text |

### Persistence & Storage
| Decision | Choice |
|----------|--------|
| Persistence | **Always auto-save** (no opt-in toggle) |
| Pruning | **Configurable** max messages setting (default 50) |
| Storage | **Separate `conversations.json`** file |
| Activity retention | **Session only** (clears on Obsidian restart) |

### Agent Streams Architecture (IMPORTANT!)
| Decision | Choice |
|----------|--------|
| Scope | **Vault-global activity stream** (not per-note chat!) |
| Relationship | **Many-to-many**: 1 agent → multiple notes, 1 note → multiple agents |
| Activity items | **Full cards** (note title, agent, status, progress, actions) |
| Click behavior | Opens **popup modal** with full context (note preview + RAG + results + chat) |
| Chat location | **Inside popup modal** (not in main Agent Streams view) |
| Task launch | **Quick Actions** for current note + **Omnibar** for bulk/specific |
| Concurrency | **One task at a time** (sequential queue) |
| Cancelable | **Yes, always** via X button |
| Clear conversation | **In popup modal** (discreet placement) |

### Settings & Dashboard
| Decision | Choice |
|----------|--------|
| Agent cards | **Capabilities**: Semantic Search, Context Builder, Chat Assistant |
| Agent status | **Combined** (health + pulsing indicator during operations) |
| Search settings | **Presets** (Quick/Balanced/Thorough) + Custom option |
| Index progress | **Footer bar** (non-blocking progress indicator) |
| Cross-view badges | **No** - agent activity only visible in Agent Streams |

### Phase 1.7 Scope (Hybrid Approach)
| Decision | Choice |
|----------|--------|
| Chat | ✅ Works now - in popup modal when clicking activity |
| Quick Actions | ✅ Fire tasks → appear in activity stream |
| Activity stream | ✅ Full cards with click-to-modal |
| Bulk omnibar | ❌ Defer to Phase 2 |
| Background orchestration | ❌ Defer complex queue system to Phase 2 |

---

## Repository Structure

```
/home/akougkas/projects/notient/
├── src/
│   ├── main.ts                 # Plugin entry, service initialization
│   ├── settings.ts             # Settings tab UI
│   ├── styles.css              # nv2-* design system
│   ├── views/
│   │   ├── sidebar.ts          # Main sidebar (Note Vitals + Agent Streams)
│   │   ├── setupWizard.ts      # First-run configuration
│   │   └── dashboard.ts        # Vault Vitals (secondary view)
│   ├── core/
│   │   ├── kernel.ts           # Service registry
│   │   ├── search/pipeline.ts  # Semantic search + reranking
│   │   └── context/vaultContextBuilder.ts
│   ├── services/
│   │   ├── lmstudio.ts         # Chat + reranking (has streaming)
│   │   ├── ollama.ts           # Embeddings
│   │   └── indexManager.ts     # Index state
│   └── types/
│       └── settings.ts         # NotientSettings interface
├── planning/
│   ├── PRD.md                  # Product requirements (v2.2)
│   ├── prompts/
│   │   ├── bootstrap.md        # Master plan
│   │   └── ui-ux.md            # Design system spec
│   └── design-snaps/           # UI mockups
└── package.json
```

## Current State Assessment

### What Works ✅
1. **Sidebar renders** with Note Vitals and Agent Streams views
2. **Search** works via omnibar with LLM reranking
3. **Streaming** is implemented in `lmstudio.ts` via `chatStream()`
4. **Quick Actions** call `prefillChatAndSwitch()` which sends AI queries
5. **Settings tab** has service configuration, chunk size slider, PARA mapping
6. **Index management** has sync, rebuild, trim, export/import

### What's Broken or Incomplete 🔴

#### 1. Chat Interface (sidebar.ts)
- `sendQuery()` shows AI response only as a `Notice` toast
- No visible chat bubbles in the Agent Streams view
- Activity Log generates entries but doesn't show actual chat messages
- Cancel button exists in concept but isn't rendered

**Files to modify:** `src/views/sidebar.ts`, `src/styles.css`

#### 2. Settings Parity (settings.ts)
- Missing: top-K results slider for search
- Missing: reranking enable/disable toggle  
- Missing: minimum similarity threshold
- Missing: prompt template customization

**Files to modify:** `src/settings.ts`, `src/types/settings.ts`

#### 3. Conversation Persistence
- Chat history is in-memory only (`chatHistory: ExtendedChatMessage[]`)
- No persistence between sidebar closes
- No clear conversation button

**Files to create:** `src/services/conversationStore.ts`
**Files to modify:** `src/views/sidebar.ts`, `src/main.ts`

#### 4. Agent Dashboard Accuracy (sidebar.ts)
- Shows hardcoded "Research Bot", "Context Builder", "Result Reranker"
- Status is derived from service availability, not actual activity
- Activity log entries are fabricated, not from real events

**Files to modify:** `src/views/sidebar.ts`

#### 5. Index State Feedback
- No progress indicator during indexing
- Note count not visible in sidebar
- No last sync timestamp

**Files to modify:** `src/views/sidebar.ts`, `src/core/indexer/simpleIndexer.ts`

## Implementation Tasks

### Task 1: Full Chat Interface in Agent Streams View

**Goal:** Replace the Activity Log with a proper chat interface when there are messages.

**Key decisions:**
- **Enter sends**, Shift+Enter for newlines
- **Cancel discards** partial response entirely (remove the message element)
- **Last 10 messages** sent to LLM (sliding window)
- **Inline citations** as `[[Note Name]]` clickable links

**Implementation approach:**

1. In `sidebar.ts`, modify `renderAgentStreamsView()`:
   - Keep agent dashboard cards at top
   - Add chat messages section (scrollable, auto-scroll to bottom)
   - Add chat input area at bottom (always visible)

2. Create new render methods:
   ```typescript
   private renderChatMessages(container: HTMLElement): void {
     // Get messages for current note from ConversationStore
     const noteId = this.currentNote?.path || '_global';
     const messages = this.conversationStore.getMessages(noteId);

     // Render last N messages (N = setting, default 50 display, 10 for LLM)
     for (const msg of messages) {
       this.renderChatBubble(container, msg);
     }

     // If streaming, show partial response with cursor
     if (this.isStreaming && this.streamingContent) {
       this.renderStreamingBubble(container, this.streamingContent);
     }
   }

   private renderChatBubble(container: HTMLElement, msg: ChatMessage): void {
     const bubble = container.createDiv({ cls: `nv2-chat-bubble nv2-chat-bubble--${msg.role}` });

     // For assistant messages, parse [[Note Name]] as clickable links
     if (msg.role === 'assistant') {
       this.renderContentWithCitations(bubble, msg.content);
     } else {
       bubble.createSpan({ text: msg.content });
     }
   }

   private renderContentWithCitations(container: HTMLElement, content: string): void {
     // Parse [[Note Name]] patterns and make them clickable
     const regex = /\[\[([^\]]+)\]\]/g;
     let lastIndex = 0;
     let match;

     while ((match = regex.exec(content)) !== null) {
       // Add text before match
       if (match.index > lastIndex) {
         container.createSpan({ text: content.slice(lastIndex, match.index) });
       }
       // Add clickable link
       const link = container.createEl('a', {
         cls: 'nv2-citation-link',
         text: match[1]
       });
       link.addEventListener('click', () => this.openNote(match[1]));
       lastIndex = regex.lastIndex;
     }
     // Add remaining text
     if (lastIndex < content.length) {
       container.createSpan({ text: content.slice(lastIndex) });
     }
   }

   private renderChatInputArea(container: HTMLElement): void {
     const inputArea = container.createDiv({ cls: 'nv2-chat-input-area' });

     const textarea = inputArea.createEl('textarea', {
       cls: 'nv2-chat-textarea',
       attr: { placeholder: 'Ask Notient... (Enter to send)' }
     });

     // Enter sends, Shift+Enter for newline
     textarea.addEventListener('keydown', (e) => {
       if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         this.sendChatMessage(textarea.value);
         textarea.value = '';
       }
     });

     // Send/Stop button
     const btn = inputArea.createEl('button', {
       cls: this.isStreaming ? 'nv2-stop-btn' : 'nv2-send-btn'
     });
     setIcon(btn, this.isStreaming ? 'square' : 'send');

     btn.addEventListener('click', () => {
       if (this.isStreaming) {
         this.cancelStreaming(); // Discard partial response
       } else {
         this.sendChatMessage(textarea.value);
         textarea.value = '';
       }
     });
   }
   ```

3. Implement cancel behavior:
   ```typescript
   private cancelStreaming(): void {
     this.abortController?.abort();
     this.isStreaming = false;
     this.streamingContent = '';
     // Don't save partial message - just discard
     this.renderAgentStreamsView(); // Re-render without partial
   }
   ```

4. Sliding window for LLM context:
   ```typescript
   private buildLLMContext(): ChatMessage[] {
     const noteId = this.currentNote?.path || '_global';
     const allMessages = this.conversationStore.getMessages(noteId);
     // Only send last 10 to LLM
     return allMessages.slice(-10);
   }
   ```

5. Add CSS classes to `styles.css`:
   ```css
   .nv2-chat-messages {
     flex: 1;
     overflow-y: auto;
     padding: var(--nv2-space-3);
     display: flex;
     flex-direction: column;
     gap: var(--nv2-space-2);
   }

   .nv2-chat-bubble {
     max-width: 85%;
     padding: var(--nv2-space-3);
     border-radius: var(--nv2-radius-lg);
     font-size: var(--nv2-font-sm);
     line-height: 1.5;
   }

   .nv2-chat-bubble--user {
     align-self: flex-end;
     background: var(--nv2-bg-tertiary);
     border-bottom-right-radius: var(--nv2-radius-sm);
   }

   .nv2-chat-bubble--assistant {
     align-self: flex-start;
     background: var(--nv2-bg-secondary);
     border-bottom-left-radius: var(--nv2-radius-sm);
   }

   .nv2-citation-link {
     color: var(--nv2-accent);
     cursor: pointer;
     text-decoration: underline;
   }

   .nv2-chat-input-area {
     display: flex;
     gap: var(--nv2-space-2);
     padding: var(--nv2-space-3);
     border-top: 1px solid var(--nv2-border);
   }

   .nv2-chat-textarea {
     flex: 1;
     min-height: 40px;
     max-height: 120px;
     resize: none;
     background: var(--nv2-bg-tertiary);
     border: 1px solid var(--nv2-border);
     border-radius: var(--nv2-radius-md);
     padding: var(--nv2-space-2);
   }

   .nv2-send-btn, .nv2-stop-btn {
     width: 40px;
     height: 40px;
     border-radius: 50%;
     display: flex;
     align-items: center;
     justify-content: center;
   }

   .nv2-send-btn {
     background: var(--nv2-accent);
     color: white;
   }

   .nv2-stop-btn {
     background: var(--color-red);
     color: white;
   }
   ```

### Task 2: Search Settings with Presets

**Goal:** Add a "Search" section with preset-based configuration.

**Key decision:** Use **Presets** (Quick/Balanced/Thorough) + Custom option instead of raw sliders.

**Implementation approach:**

1. Update `src/types/settings.ts`:
   ```typescript
   type SearchPreset = 'quick' | 'balanced' | 'thorough' | 'custom';

   interface SearchSettings {
     preset: SearchPreset;
     // Custom values (only used when preset === 'custom')
     custom: {
       topK: number;           // 1-50
       enableReranking: boolean;
       minScore: number;       // 0.0-1.0
     };
   }

   // Preset definitions
   const SEARCH_PRESETS = {
     quick: { topK: 5, enableReranking: false, minScore: 0.5 },
     balanced: { topK: 10, enableReranking: true, minScore: 0.3 },
     thorough: { topK: 25, enableReranking: true, minScore: 0.2 },
   };

   interface NotientSettings {
     // ... existing
     search: SearchSettings;
   }
   ```

2. Update `DEFAULT_SETTINGS`:
   ```typescript
   search: {
     preset: 'balanced',
     custom: { topK: 10, enableReranking: true, minScore: 0.3 }
   }
   ```

3. Add new section in `NotientSettingTab.display()`:
   ```typescript
   private renderSearchSection(containerEl: HTMLElement): void {
     new Setting(containerEl).setName('Search').setHeading();

     // Preset dropdown
     new Setting(containerEl)
       .setName('Search mode')
       .setDesc('Quick for speed, Thorough for completeness')
       .addDropdown(dropdown => {
         dropdown
           .addOption('quick', 'Quick (5 results, no AI reranking)')
           .addOption('balanced', 'Balanced (10 results, AI reranking)')
           .addOption('thorough', 'Thorough (25 results, AI reranking)')
           .addOption('custom', 'Custom...')
           .setValue(this.plugin.settings.search.preset)
           .onChange(async (value: SearchPreset) => {
             this.plugin.settings.search.preset = value;
             await this.plugin.saveSettings();
             this.display(); // Re-render to show/hide custom options
           });
       });

     // Show custom sliders only when preset === 'custom'
     if (this.plugin.settings.search.preset === 'custom') {
       this.renderCustomSearchSettings(containerEl);
     }
   }

   private renderCustomSearchSettings(containerEl: HTMLElement): void {
     // Top-K slider
     new Setting(containerEl)
       .setName('Results count')
       .setDesc('Number of results to return (1-50)')
       .addSlider(slider => {
         slider.setLimits(1, 50, 1)
           .setValue(this.plugin.settings.search.custom.topK)
           .setDynamicTooltip()
           .onChange(async (value) => {
             this.plugin.settings.search.custom.topK = value;
             await this.plugin.saveSettings();
           });
       });

     // Reranking toggle
     new Setting(containerEl)
       .setName('AI reranking')
       .setDesc('Use LM Studio to reorder results by relevance')
       .addToggle(toggle => {
         toggle.setValue(this.plugin.settings.search.custom.enableReranking)
           .onChange(async (value) => {
             this.plugin.settings.search.custom.enableReranking = value;
             await this.plugin.saveSettings();
           });
       });

     // Min score slider
     new Setting(containerEl)
       .setName('Minimum score')
       .setDesc('Filter out results below this similarity (0.0-1.0)')
       .addSlider(slider => {
         slider.setLimits(0, 1, 0.05)
           .setValue(this.plugin.settings.search.custom.minScore)
           .setDynamicTooltip()
           .onChange(async (value) => {
             this.plugin.settings.search.custom.minScore = value;
             await this.plugin.saveSettings();
           });
       });
   }
   ```

4. Helper to get effective search settings:
   ```typescript
   function getEffectiveSearchSettings(settings: SearchSettings): {
     topK: number;
     enableReranking: boolean;
     minScore: number;
   } {
     if (settings.preset === 'custom') {
       return settings.custom;
     }
     return SEARCH_PRESETS[settings.preset];
   }
   ```

5. Wire to SearchPipeline:
   - Modify `search()` to call `getEffectiveSearchSettings(kernel.settings.search)`

### Task 3: Agent Task System & Activity Stream

**Goal:** Implement vault-global activity stream with task cards and popup modals.

**Key architecture:**
- Agent Streams = vault-global activity feed (not per-note chat!)
- Quick Actions fire tasks that appear as cards in the stream
- Clicking a card opens a modal with full context + chat
- Chat happens inside the modal, not in main view

**Implementation approach:**

1. Create `src/types/agentTask.ts`:
   ```typescript
   type AgentType = 'search' | 'context' | 'chat';
   type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

   interface AgentTask {
     id: string;
     agent: AgentType;
     notePath: string;
     noteTitle: string;
     status: TaskStatus;
     progress?: number;        // 0-100 for running tasks
     startedAt: Date;
     completedAt?: Date;
     result?: TaskResult;
     error?: string;
     chatHistory: ChatMessage[]; // Per-task conversation
   }

   interface TaskResult {
     type: 'enrichment' | 'links' | 'classification' | 'chat';
     data: unknown;           // Varies by type
     citations: string[];     // Note paths used as RAG context
   }
   ```

2. Create `src/services/agentTaskQueue.ts`:
   ```typescript
   export class AgentTaskQueue {
     private tasks: AgentTask[] = [];       // Activity stream (session only)
     private currentTask: AgentTask | null = null;
     private abortController: AbortController | null = null;

     // Queue management
     enqueue(task: Omit<AgentTask, 'id' | 'status' | 'startedAt'>): string;
     cancel(taskId: string): void;
     getAll(): AgentTask[];
     getById(taskId: string): AgentTask | undefined;

     // Task execution
     private async processNext(): Promise<void>;
     private async executeTask(task: AgentTask): Promise<void>;

     // Events
     onTaskUpdate: (task: AgentTask) => void;
   }
   ```

3. Modify `sidebar.ts` - `renderAgentStreamsView()`:
   ```typescript
   private renderAgentStreamsView(): void {
     // Agent capability cards at top (with combined status)
     this.renderAgentDashboard(container);

     // Activity stream - list of task cards
     const stream = container.createDiv({ cls: 'nv2-activity-stream' });
     const tasks = this.taskQueue.getAll();

     if (tasks.length === 0) {
       stream.createDiv({ cls: 'nv2-empty-state', text: 'No agent activity yet. Use Quick Actions to get started.' });
     } else {
       for (const task of tasks.reverse()) { // Most recent first
         this.renderTaskCard(stream, task);
       }
     }
   }

   private renderTaskCard(container: HTMLElement, task: AgentTask): void {
     const card = container.createDiv({ cls: `nv2-task-card nv2-task-card--${task.status}` });

     // Header: Agent icon + Note title
     const header = card.createDiv({ cls: 'nv2-task-card__header' });
     setIcon(header.createSpan(), this.getAgentIcon(task.agent));
     header.createSpan({ text: task.noteTitle, cls: 'nv2-task-card__title' });

     // Status + progress
     const status = card.createDiv({ cls: 'nv2-task-card__status' });
     if (task.status === 'running') {
       // Progress bar
       const bar = status.createDiv({ cls: 'nv2-progress-bar' });
       bar.createDiv({ cls: 'nv2-progress-fill', attr: { style: `width: ${task.progress || 0}%` } });
     } else {
       status.createSpan({ text: this.getStatusLabel(task.status) });
     }

     // Timestamp
     card.createDiv({ cls: 'nv2-task-card__time', text: this.formatTime(task.startedAt) });

     // Actions
     const actions = card.createDiv({ cls: 'nv2-task-card__actions' });
     if (task.status === 'running' || task.status === 'queued') {
       const cancelBtn = actions.createEl('button', { cls: 'nv2-icon-btn', attr: { title: 'Cancel' } });
       setIcon(cancelBtn, 'x');
       cancelBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         this.taskQueue.cancel(task.id);
       });
     }

     // Click to open modal
     card.addEventListener('click', () => this.openTaskModal(task));
   }
   ```

4. Create `src/views/taskModal.ts` - Full context popup:
   ```typescript
   export class TaskModal extends Modal {
     constructor(app: App, private task: AgentTask, private kernel: NotientKernel) {
       super(app);
     }

     onOpen() {
       const { contentEl } = this;
       contentEl.addClass('nv2-task-modal');

       // Note preview section
       this.renderNotePreview(contentEl);

       // RAG sources section (if available)
       if (this.task.result?.citations.length) {
         this.renderSources(contentEl);
       }

       // Results section
       if (this.task.result) {
         this.renderResults(contentEl);
       }

       // Chat section
       this.renderChat(contentEl);
     }

     private renderChat(container: HTMLElement): void {
       const chatSection = container.createDiv({ cls: 'nv2-modal-chat' });
       chatSection.createEl('h4', { text: 'Chat with Agent' });

       // Messages
       const messages = chatSection.createDiv({ cls: 'nv2-chat-messages' });
       for (const msg of this.task.chatHistory) {
         this.renderMessage(messages, msg);
       }

       // Input (with Enter to send)
       const inputArea = chatSection.createDiv({ cls: 'nv2-chat-input-area' });
       // ... (same as Task 1 implementation)
     }
   }
   ```

5. Wire Quick Actions to task queue:
   ```typescript
   // In sidebar.ts Quick Actions handler
   private handleQuickAction(action: 'enrich' | 'link' | 'move'): void {
     if (!this.currentNote) return;

     const taskId = this.taskQueue.enqueue({
       agent: action === 'link' ? 'context' : 'chat',
       notePath: this.currentNote.path,
       noteTitle: this.currentNote.basename,
       chatHistory: [],
     });

     // Switch to Agent Streams view to show the task
     this.switchToView('agents');
   }
   ```

6. CSS for task cards:
   ```css
   .nv2-task-card {
     padding: var(--nv2-space-3);
     background: var(--nv2-bg-secondary);
     border-radius: var(--nv2-radius-md);
     border-left: 3px solid var(--nv2-border);
     cursor: pointer;
     margin-bottom: var(--nv2-space-2);
     transition: transform 0.1s ease;
   }

   .nv2-task-card:hover {
     transform: translateX(2px);
   }

   .nv2-task-card--running {
     border-left-color: var(--nv2-accent);
   }

   .nv2-task-card--completed {
     border-left-color: var(--color-green);
   }

   .nv2-task-card--failed {
     border-left-color: var(--color-red);
   }

   .nv2-task-card__header {
     display: flex;
     align-items: center;
     gap: var(--nv2-space-2);
     margin-bottom: var(--nv2-space-1);
   }

   .nv2-task-card__title {
     font-weight: var(--font-medium);
     flex: 1;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }
   ```

### Task 4: Agent Dashboard with Combined Status

**Goal:** Agent capability cards show health + active operation indicator.

**Key decision:** Combined status = service health + pulsing dot when processing.

**Implementation approach:**

1. Update agent card rendering in `sidebar.ts`:
   ```typescript
   private renderAgentDashboard(container: HTMLElement): void {
     const dashboard = container.createDiv({ cls: 'nv2-agent-dashboard' });

     const agents = [
       { id: 'search', name: 'Semantic Search', icon: 'search', service: 'ollama' },
       { id: 'context', name: 'Context Builder', icon: 'book-open', service: 'ollama' },
       { id: 'chat', name: 'Chat Assistant', icon: 'message-circle', service: 'lmstudio' },
     ];

     for (const agent of agents) {
       this.renderAgentCard(dashboard, agent);
     }
   }

   private renderAgentCard(container: HTMLElement, agent: AgentConfig): void {
     const card = container.createDiv({ cls: 'nv2-agent-card' });

     // Icon
     const iconEl = card.createDiv({ cls: 'nv2-agent-card__icon' });
     setIcon(iconEl, agent.icon);

     // Name
     card.createDiv({ cls: 'nv2-agent-card__name', text: agent.name });

     // Status: health + activity indicator
     const statusEl = card.createDiv({ cls: 'nv2-agent-card__status' });

     // Health from service
     const health = this.kernel.serviceHealth[agent.service];
     const healthDot = statusEl.createSpan({
       cls: `nv2-status-dot nv2-status-dot--${health.status}`
     });

     // Activity indicator (pulsing when this agent has running task)
     const hasRunningTask = this.taskQueue.getAll()
       .some(t => t.agent === agent.id && t.status === 'running');

     if (hasRunningTask) {
       statusEl.createSpan({ cls: 'nv2-pulse-dot', attr: { title: 'Processing...' } });
     }

     // Last activity timestamp
     const lastTask = this.taskQueue.getAll()
       .filter(t => t.agent === agent.id)
       .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

     if (lastTask) {
       statusEl.createSpan({
         cls: 'nv2-agent-card__last',
         text: this.formatTimeAgo(lastTask.startedAt)
       });
     }
   }
   ```

2. CSS for status indicators:
   ```css
   .nv2-status-dot {
     width: 8px;
     height: 8px;
     border-radius: 50%;
     display: inline-block;
   }

   .nv2-status-dot--connected { background: var(--color-green); }
   .nv2-status-dot--connecting { background: var(--color-yellow); }
   .nv2-status-dot--disconnected { background: var(--color-red); }

   .nv2-pulse-dot {
     width: 8px;
     height: 8px;
     border-radius: 50%;
     background: var(--nv2-accent);
     animation: pulse 1.5s ease-in-out infinite;
     margin-left: var(--nv2-space-1);
   }

   @keyframes pulse {
     0%, 100% { opacity: 1; transform: scale(1); }
     50% { opacity: 0.5; transform: scale(1.2); }
   }
   ```

### Task 5: Index Progress Feedback

**Goal:** Show indexing progress in UI.

**Implementation approach:**

1. Modify `SimpleIndexer` to emit progress events:
   ```typescript
   eventBus.emit('index:progress', { 
     current: processedCount, 
     total: totalNotes, 
     percent: Math.round(processedCount / totalNotes * 100)
   });
   ```

2. In sidebar footer or header, show progress bar when indexing:
   ```typescript
   // Subscribe to index:progress
   // Render: "Indexing: 45/200 notes (23%)"
   ```

3. Show note count in footer: "📊 1,234 notes indexed"

4. Show last sync time: "Last sync: 5 min ago"

## Implementation Order

**Phase 1.7 uses a Hybrid approach - build foundation now, defer complexity to Phase 2.**

1. **Task 2: Search Settings with Presets** - Quick win, improves search UX immediately
2. **Task 5: Index Progress in Footer** - Simple, visible feedback during sync
3. **Task 3: Agent Task System** - Core architecture for activity stream + modal
4. **Task 4: Agent Dashboard Status** - Wire up health + activity indicators
5. **Task 1: Chat in Modal** - Implement chat UI inside TaskModal (builds on Task 3)

**What to defer to Phase 2:**
- Bulk omnibar commands (`/enrich all in Projects/`)
- Complex queue management (priority, retry)
- Conversation persistence across sessions (Task 3 stores per-task, session-only)
- Multi-agent orchestration on single note

## Code Style Guidelines

1. **TypeScript strict mode** - No `any` types without eslint-disable comment
2. **BEM-ish CSS naming** - Use `nv2-` prefix for new classes
3. **Obsidian API** - Use `createDiv()`, `createEl()`, `setIcon()` from Obsidian
4. **Event cleanup** - Always `this.register(() => unsubscribe())` for event listeners
5. **No debug logs in production** - Use `console.log` sparingly, prefix with `[Notient]`

## Testing Checklist

After each task, verify:

- [ ] Build succeeds: `bun run build`
- [ ] No TypeScript errors: `bun run typecheck` (if available)
- [ ] Sidebar renders without errors
- [ ] Feature works as expected in Obsidian

## Reference Files

Before starting, read these files to understand patterns:
- `src/views/sidebar.ts` - Current sidebar implementation
- `src/settings.ts` - Settings tab patterns
- `src/services/lmstudio.ts` - Streaming chat implementation
- `src/styles.css` - Design system tokens
- `planning/prompts/ui-ux.md` - Design specifications

## Success Criteria

Phase 1.7 is complete when:

### Search & Settings
1. ✅ Settings tab has Search section with Presets (Quick/Balanced/Thorough/Custom)
2. ✅ Custom mode shows top-K slider, reranking toggle, min score slider
3. ✅ SearchPipeline respects settings

### Agent Streams View
4. ✅ Agent Streams shows vault-global activity stream (not per-note)
5. ✅ Quick Actions fire tasks that appear as cards in stream
6. ✅ Task cards show: note title, agent, status, progress bar, timestamp
7. ✅ Running/queued tasks show cancel button
8. ✅ Clicking a card opens TaskModal

### TaskModal (Popup)
9. ✅ Modal shows note preview section
10. ✅ Modal shows RAG sources (citations) if available
11. ✅ Modal shows task results when complete
12. ✅ Modal has chat section with message bubbles
13. ✅ Chat input: Enter sends, Shift+Enter newlines
14. ✅ Streaming shows tokens in real-time with cursor
15. ✅ Cancel discards partial response entirely
16. ✅ Citations render as clickable `[[Note Name]]` links

### Agent Dashboard
17. ✅ Three capability cards: Semantic Search, Context Builder, Chat Assistant
18. ✅ Cards show service health (green/yellow/red dot)
19. ✅ Cards show pulsing indicator when actively processing
20. ✅ Cards show "last used X ago" timestamp

### Index Progress
21. ✅ Footer shows progress bar during indexing
22. ✅ Footer shows note count: "X notes indexed"
23. ✅ Footer shows last sync time

## Begin

**Recommended sequence:**

1. **Read first:**
   - `src/views/sidebar.ts` - Current sidebar implementation
   - `src/settings.ts` - Settings tab patterns
   - `src/services/lmstudio.ts` - Streaming implementation

2. **Implement in order:**
   - Task 2 (Search Presets) → Quick win, small diff
   - Task 5 (Index Progress) → Small, visible improvement
   - Task 3 (Agent Task System) → Core new architecture
   - Task 4 (Dashboard Status) → Builds on Task 3
   - Task 1 (Chat in Modal) → Builds on Task 3's TaskModal

3. **Test after each task:**
   - `bun run build` passes
   - Feature works in Obsidian
   - No console errors

4. **Use TodoWrite** to track progress across tasks.

**Key files to create:**
- `src/types/agentTask.ts` - Task types
- `src/services/agentTaskQueue.ts` - Queue management
- `src/views/taskModal.ts` - Popup modal

**Key files to modify:**
- `src/types/settings.ts` - Add SearchSettings
- `src/settings.ts` - Add Search section with presets
- `src/views/sidebar.ts` - Agent Streams redesign
- `src/styles.css` - New task card and modal styles

Good luck! Notient is coming alive! 🧠
