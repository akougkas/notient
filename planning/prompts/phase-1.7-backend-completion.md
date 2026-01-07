# Phase 1.7: Backend Completion - Session Prompt

> **For Claude Code Opus 4.5**
> Use "ultrathink" mode for complex architectural decisions.

## Context

You are continuing development on **Notient**, a local-first AI-powered Obsidian plugin. Phase 1.6 (UI/UX Overhaul) is complete. The sidebar now has a two-view layout with Note Vitals and Agent Streams views, styled with the `nv2-*` design system.

**The problem:** The UI looks great but several features are not fully wired to the backend. This phase achieves **UI-backend parity**.

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

**Implementation approach:**

1. In `sidebar.ts`, modify `renderAgentStreamsView()`:
   - Keep agent dashboard cards at top
   - Add chat messages section (if `chatHistory.length > 0`)
   - Add chat input area at bottom (always visible)

2. Create new render methods:
   ```typescript
   private renderChatMessages(): void {
     // Render chat history with user/assistant bubbles
     // Show streaming content with typing indicator
   }
   
   private renderChatInputArea(): void {
     // Textarea for input
     // Attach button (optional - can be Phase 2)
     // Send/Stop button based on isStreaming
   }
   ```

3. Wire up the cancel button:
   ```typescript
   // When isStreaming, show stop button that calls cancelStreaming()
   ```

4. Add CSS classes to `styles.css`:
   - `.nv2-chat-messages` - scrollable container
   - `.nv2-chat-message` - individual message wrapper
   - `.nv2-chat-bubble--user` / `.nv2-chat-bubble--assistant`
   - `.nv2-chat-input-area` - bottom input section
   - `.nv2-chat-textarea` - multiline input
   - `.nv2-send-btn` / `.nv2-stop-btn`

**Reference the UI/UX spec:** `planning/prompts/ui-ux.md` has chat bubble styling.

### Task 2: Search Settings in Settings Tab

**Goal:** Add a "Search" section to settings.ts with configurable options.

**Implementation approach:**

1. Update `src/types/settings.ts`:
   ```typescript
   interface NotientSettings {
     // ... existing
     search: {
       topK: number;           // 1-50, default 10
       enableReranking: boolean; // default true
       minScore: number;       // 0.0-1.0, default 0.3
     };
   }
   ```

2. Update `DEFAULT_SETTINGS` in settings.ts

3. Add new section in `NotientSettingTab.display()`:
   ```typescript
   private renderSearchSection(containerEl: HTMLElement): void {
     // Top-K slider
     // Reranking toggle
     // Min score slider
   }
   ```

4. Wire settings to SearchPipeline:
   - Modify `search()` to read from `kernel.settings.search`

### Task 3: Conversation Persistence Service

**Goal:** Save chat history to disk, restore on sidebar open.

**Implementation approach:**

1. Create `src/services/conversationStore.ts`:
   ```typescript
   interface ConversationData {
     messages: ExtendedChatMessage[];
     lastUpdated: number;
   }
   
   export class ConversationStore {
     async load(): Promise<ConversationData | null>;
     async save(data: ConversationData): Promise<void>;
     async clear(): Promise<void>;
   }
   ```

2. Store in `data.json` under a `conversations` key, or separate file

3. In `sidebar.ts`:
   - Load conversation in `onOpen()`
   - Save after each assistant message completes
   - Add "Clear conversation" button in header

### Task 4: Real Agent Status and Activity

**Goal:** Activity log reflects actual service events.

**Implementation approach:**

1. Define activity event types in `src/types/events.ts`:
   ```typescript
   interface AgentActivityEvent {
     type: 'search_started' | 'search_complete' | 'chat_started' | 'chat_complete' | 'index_progress';
     agent: string;
     timestamp: Date;
     details: Record<string, unknown>;
   }
   ```

2. Emit events from services:
   - SearchPipeline already emits `search:started`, `search:complete`
   - Add similar events for chat operations

3. In sidebar, subscribe to events and build activity log from real data

4. Update agent dashboard cards to show:
   - "idle" when no operation in progress
   - "processing" during active operations
   - "error" if last operation failed

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

1. **Start with Task 1 (Chat Interface)** - Most visible impact
2. **Then Task 2 (Search Settings)** - Quick win
3. **Then Task 3 (Conversation Persistence)** - Depends on Task 1
4. **Then Task 4 (Real Activity)** - Polish
5. **Finally Task 5 (Index Progress)** - Polish

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

1. ✅ Chat messages display as styled bubbles in Agent Streams view
2. ✅ User can type in chat input and send messages
3. ✅ Cancel button stops streaming mid-generation
4. ✅ RAG citations appear as clickable note links
5. ✅ Settings tab has Search section with top-K, reranking, threshold
6. ✅ Chat history persists between sidebar open/close
7. ✅ Clear conversation button works
8. ✅ Activity log shows real events (search, chat operations)
9. ✅ Index progress shows during sync/rebuild
10. ✅ Note count visible in sidebar

## Begin

Start by reading `src/views/sidebar.ts` to understand the current `renderAgentStreamsView()` implementation. Then implement Task 1: Full Chat Interface.

Use the todo_write tool to track progress across tasks.

Good luck! 🚀
