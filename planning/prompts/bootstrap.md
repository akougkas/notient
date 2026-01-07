# MASTER_PLAN.md — Notient (Local-first Obsidian AI Vault Manager)

> **Version 3.0 - Phase 1 Complete, Ready for Phase 2: AGENTIC**
> All foundation work done. Clean architecture. Next: trust levels, bulk operations, undo.

## 0) Purpose and scope of this master plan

This document is the canonical plan for building **Notient** across multiple development phases and work sessions.

- **PRD**: `planning/PRD.md` (v3.0)
- **UI/UX Spec**: `planning/prompts/ui-ux.md`
- **Phase 1.7 Spec**: `planning/prompts/phase-1.7-backend-completion.md`
- **Phase 1.8 Spec**: `planning/prompts/phase-1.8-architecture-refactor.md`
- **Code repository**: `/home/akougkas/projects/notient`

## 1) Product definition

### 1.1 Vision

**Notient = Note + Sentient — Sentient Notes for the thinking human.**

Notient transforms notes from passive files into living entities with health, dynamics, and agency. Using **local LLMs only**, it provides:
- **Note-centric dashboard** with vitals, actions, and omnibar search
- **Agent chat** for conversational AI interactions with streaming
- **Dynamic vault context** awareness per query
- **Agentic operations** with trust levels and universal undo
- **Human-in-steering-wheel** philosophy

### 1.2 The Sentient Notes Philosophy
- Every note has a **pulse**: health score, freshness, connectivity
- Every note has **context**: PARA type, related notes, suggested actions
- Every note can **speak**: through Agents chat, notes become conversational
- The user **steers**; Notient **amplifies**

### 1.3 Non-negotiables (constraints)
- **Local-only**: No cloud model APIs. No user data leaves the machine.
- **Bun-only**: Use Bun for install/build/test. No npm/yarn/pnpm workflows.
- **Language**: TypeScript strict.
- **LLM reasoning**: LM Studio (OpenAI-compatible API) - MUST BE USED (not just configured)
- **Embeddings**: Ollama (local or remote on LAN).
- **Vector Store**: Custom brute-force cosine similarity (pure JS, zero dependencies).
- **Target runtime**: Obsidian desktop (Electron). `manifest.json.isDesktopOnly = true`.
- **No debug cruft**: Console-only logging, no external telemetry.

### 1.4 Non-goals
- Mobile support (desktop-first).
- Cloud API support (OpenAI/Claude/etc).
- Real-time collaboration.
- Vault sync.
- Over-engineered undo beyond Obsidian's capabilities.

### 1.5 Success criteria (product)
- Search feels intelligent (LLM-reranked, not just similarity scores).
- Chat provides useful answers with citations.
- Agent actions respect trust levels.
- User always feels in control.

## 2) Top-level architecture

### 2.1 Runtime model (Obsidian desktop)
- Code runs in Obsidian's plugin environment (Electron renderer with Node APIs available).
- File system access and vault operations go through Obsidian APIs.

### 2.2 System decomposition (Current State - v3.0)

```
Notient Architecture v3.0 (Phase 1 Complete)
├── UI Layer
│   ├── Sidebar (Note Vitals + Agent Streams) ✅
│   ├── TaskModal (popup with chat) ✅
│   ├── Setup Wizard ✅
│   ├── Settings Tab ✅
│   └── Dashboard (Vault Vitals) ✅
│
├── Core Modules
│   ├── Kernel (service orchestration) ✅
│   ├── EventBus (typed pub/sub) ✅
│   │
│   ├── LLM Abstraction (core/llm/) ✅
│   │   ├── LLMProvider interface
│   │   ├── OpenAICompatibleProvider base
│   │   └── LMStudioProvider
│   │
│   ├── Agent Module (core/agent/) ✅
│   │   ├── NotientAgent (execution loop)
│   │   ├── NotientPromptBuilder
│   │   ├── AgentTaskQueue
│   │   └── TaskInference
│   │
│   ├── Chat Module (core/chat/) ✅
│   │   ├── ChatSession
│   │   └── Streaming utilities
│   │
│   ├── VaultContextBuilder ✅
│   └── SearchPipeline (vector + LLM rerank) ✅
│
├── Storage Services
│   ├── SimpleVectorStore (brute-force cosine) ✅
│   ├── IndexManager (state tracking) ✅
│   └── SimpleIndexer (batch processing) ✅
│
└── Agent Services ← Phase 2
    ├── TrustLevelManager
    ├── WorkflowRunner
    └── ActionHistory (undo support)
```

### 2.3 Key architectural decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding granularity | Hybrid (note + sections) | Flexible retrieval, broad + precise |
| Search ranking | LLM reranking | Smarter than pure cosine similarity |
| Vault context | Dynamic per-query | More relevant than static scan |
| Primary UX | Dual panels (search + chat) | Both always visible, no mode switching |
| Agent autonomy | Trust levels | Balance automation vs control |
| Observability | Console-only | No debug telemetry, clean code |
| LLM abstraction | Provider interface | Easy to add new providers (<50 lines) |
| Agent logic | Centralized module | Single source of truth for AI behavior |
| Chat management | Reusable ChatSession | Shared across views |

## 3) Repository layout (code)

### 3.1 Source layout (Current - v3.0)

```
src/
├── main.ts                     # Plugin entry ✅
├── settings.ts                 # Settings tab + store ✅
├── styles.css                  # Design system (nv2-* classes, 4000+ lines) ✅
│
├── views/
│   ├── sidebar.ts              # Two-view (Note Vitals + Agent Streams) ✅
│   ├── taskModal.ts            # Task popup with chat ✅
│   ├── dashboard.ts            # Vault Vitals ✅
│   ├── setupWizard.ts          # Setup wizard modal ✅
│   └── indexOptionsModal.ts    # Index action picker ✅
│
├── core/
│   ├── kernel.ts               # Service manager ✅
│   ├── constants.ts            # App constants ✅
│   ├── events/eventBus.ts      # Typed event bus ✅
│   │
│   ├── llm/                    # LLM Abstraction Layer ✅
│   │   ├── types.ts            # ChatMessage, CompletionOptions
│   │   ├── provider.ts         # LLMProvider interface
│   │   ├── providers/
│   │   │   ├── openai-compatible.ts  # Base implementation
│   │   │   └── lmstudio.ts           # LM Studio specific
│   │   └── index.ts            # Exports
│   │
│   ├── agent/                  # Notient Agent Module ✅
│   │   ├── types.ts            # AgentTask, TaskResult, NoteContext
│   │   ├── promptBuilder.ts    # Notient personality + RAG
│   │   ├── taskInference.ts    # Task type detection
│   │   ├── agentLoop.ts        # Core execution orchestration
│   │   ├── taskQueue.ts        # Sequential queue management
│   │   └── index.ts            # Exports
│   │
│   ├── chat/                   # Reusable Chat Module ✅
│   │   ├── types.ts            # ChatConfig, ExtendedChatMessage
│   │   ├── session.ts          # History management
│   │   ├── streaming.ts        # Stream utilities
│   │   └── index.ts            # Exports
│   │
│   ├── context/
│   │   └── vaultContextBuilder.ts ✅
│   ├── indexer/
│   │   ├── simpleIndexer.ts    # Batch indexing ✅
│   │   └── simpleChunker.ts    # Section extraction ✅
│   ├── search/
│   │   └── pipeline.ts         # Vector + LLM rerank ✅
│   ├── para/
│   │   └── detector.ts         # PARA classification ✅
│   └── vitals/
│       └── simpleVitals.ts     # Vault health metrics ✅
│
├── services/
│   ├── ollama.ts               # Embeddings ✅
│   ├── lmstudio.ts             # @deprecated → use core/llm ✅
│   ├── simpleVectorStore.ts    # Vector storage ✅
│   ├── indexManager.ts         # Index state ✅
│   ├── agentTaskQueue.ts       # Re-export from core/agent ✅
│   ├── healthMonitor.ts        # Service health ✅
│   ├── storagePaths.ts         # File paths ✅
│   └── vaultLock.ts            # Multi-window safety ✅
│
├── adapters/
│   └── obsidianFacade.ts       # Obsidian API wrapper ✅
│
└── types/
    ├── settings.ts             # Settings types ✅
    ├── events.ts               # Event types ✅
    ├── search.ts               # Search types ✅
    ├── agentTask.ts            # Re-export from core/agent ✅
    ├── indexer.ts              # Indexer types ✅
    └── vitals.ts               # Vitals types ✅
```

### 3.2 Data layout (on disk)

```
{vaultRoot}/.obsidian/plugins/notient/
├── data.json                   # Plugin settings
├── index-{modelKey}.json       # Hybrid embeddings (notes + sections)
├── state-{modelKey}.json       # Index state
├── cache/                      # LRU caches
└── locks/                      # Multi-window safety
```

## 4) Core services (Implemented)

### 4.1 LLMProvider Interface ✅

```typescript
interface LLMProvider {
  readonly name: string;
  readonly isReady: boolean;
  
  initialize(): Promise<void>;
  dispose(): void;
  
  // Non-streaming
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
  
  // Streaming
  stream(
    messages: ChatMessage[], 
    options?: CompletionOptions,
    signal?: AbortSignal
  ): AsyncIterable<string>;
  
  // Reranking
  rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]>;
}
```

### 4.2 NotientAgent ✅

```typescript
class NotientAgent {
  // Core execution with streaming
  async *executeStreaming(
    task: AgentTask,
    signal?: AbortSignal
  ): AsyncIterable<AgentStreamEvent>;
  
  // Non-streaming wrapper
  async execute(task: AgentTask): Promise<TaskResult>;
}
```

### 4.3 AgentTaskQueue ✅

```typescript
class AgentTaskQueue {
  enqueue(task: Omit<AgentTask, 'id' | 'status' | 'startedAt'>): string;
  cancel(taskId: string): void;
  getAll(): AgentTask[];
  getById(taskId: string): AgentTask | undefined;
  onTaskUpdate(callback: (task: AgentTask) => void): void;
}
```

### 4.4 ChatSession ✅

```typescript
class ChatSession {
  addUserMessage(content: string, attachments?: ChatAttachment[]): ExtendedChatMessage;
  addAssistantMessage(content: string, attachments?: ChatAttachment[]): ExtendedChatMessage;
  getMessagesForLLM(): ChatMessage[];  // Last 10 (sliding window)
  getMessages(): ExtendedChatMessage[];
  clear(): void;
}
```

### 4.5 VaultContextBuilder ✅

```typescript
interface VaultContextBuilder {
  // Build context relevant to a specific query
  buildForQuery(query: string, candidates: SearchResult[]): VaultContext;

  // Context includes:
  // - Relevant folder paths from candidates
  // - Active tags in candidate notes
  // - Link graph fragment (1-hop from candidates)
  // - PARA distribution of candidates
  // - Recent modifications in relevant areas
  // - contextSummary for LLM prompt
}
```

### 4.6 SearchPipeline ✅

```typescript
interface SearchPipeline {
  search(query: string, options: ExtendedSearchOptions): Promise<SearchResult[]>;
  findRelated(path: string, options: RelatedOptions): Promise<RelatedNote[]>;
  clearCache(): void;

  // Uses settings presets (Quick/Balanced/Thorough/Custom)
  // Phase 1: Vector search (fast, top-50)
  // Phase 2: LLM reranking (smart, final top-K)
}
```

## 5) UI architecture

### 5.1 Sidebar Views ✅

**Note Vitals View:**
- Note card with title, tags, links
- Quick Actions (Enrich, Link, Move) → fire tasks into Agent Streams
- Omnibar search with results
- Insight Stream with dynamic suggestions

**Agent Streams View (Vault-Global):**
- Agent Dashboard: 3 capability cards (Search, Context, Chat Assistant)
  - Combined status: health dot + pulsing when processing
  - Last activity timestamp per agent
- Activity Stream: vault-global task feed (many-to-many: agents ↔ notes)
  - Task cards with: note title, agent, status, progress bar, timestamp
  - Running/queued tasks show cancel button
  - **Click card → opens TaskModal**

### 5.2 TaskModal ✅

Popup that opens when clicking any task card:
- Note preview section
- RAG sources (citations used for context)
- Task results when complete
- **Chat section**: message bubbles, Enter sends, streaming with cancel
- Citations as `[[Note Name]]` links
- Uses ChatSession for history management
- Delegates all AI logic to NotientAgent

### 5.3 Design System ✅

CSS classes use `nv2-*` prefix (4000+ lines). Key tokens:
- `--nv2-accent`: Notient green (#10b981)
- `--nv2-bg-primary/secondary/tertiary`: Obsidian surface colors
- `--nv2-text-primary/secondary/muted`: Obsidian text colors
- `--nv2-font-xs/sm/md/lg/xl`: Typography scale

## 6) Phased roadmap

### Phase 1.5: ARCHITECTURAL RESET ✅ COMPLETE

**Completed:**
- [x] Remove all debug telemetry
- [x] Fix dual note ID generation bug
- [x] Implement LMStudioService
- [x] Hybrid embedding storage
- [x] LLM-based search reranking
- [x] Dynamic vault context builder
- [x] Basic dual-panel sidebar
- [x] Basic chat interface with RAG

### Phase 1.6: UI/UX OVERHAUL ✅ COMPLETE

**Completed:**
- [x] Design system with BEM naming (`nv2-*` prefix)
- [x] Brand colors and typography tokens
- [x] String humanization (no dev jargon)
- [x] Tabbed sidebar (Note + Agents views)
- [x] Note Vitals dashboard (health, links, freshness, tags)
- [x] Omnibar search experience
- [x] Agent streaming via NotientAgent
- [x] Quick actions (Enrich, Link, Move)
- [x] Insight Stream with suggestions
- [x] Agent Dashboard cards
- [x] Activity Log with task cards
- [x] Footer with service status

### Phase 1.7: BACKEND COMPLETION ✅ COMPLETE

**Completed:**
- [x] Search Settings with Presets (Quick/Balanced/Thorough/Custom)
- [x] Agent Task System (AgentTask, AgentTaskQueue, sequential execution)
- [x] TaskModal Popup (note preview, citations, chat, streaming)
- [x] Agent Dashboard Status (health + pulsing, timestamps)
- [x] Index Progress in Footer (progress bar, note count, sync time)

**Key Decisions (implemented):**
- Chat in popup modal only (not main Agent Streams view)
- Enter sends, Shift+Enter for newlines
- Cancel discards partial response entirely
- Last 10 messages to LLM (sliding window)
- Inline `[[Note Name]]` citations (prompted to LLM)
- Session-only activity retention
- Sequential task execution (one at a time)

### Phase 1.8: ARCHITECTURE REFACTOR ✅ COMPLETE

**Completed:**
- [x] LLM Abstraction Layer (`core/llm/`)
  - [x] `LLMProvider` interface for swappable providers
  - [x] `OpenAICompatibleProvider` base class with streaming + reranking
  - [x] `LMStudioProvider` extends base
  - [x] Zero Notient-specific logic in LLM layer
- [x] Notient Agent Module (`core/agent/`)
  - [x] `NotientPromptBuilder` - centralized prompt construction
  - [x] `NotientAgent` - single source of agent logic
  - [x] `AgentTaskQueue` - task queue management
  - [x] `inferTaskType()` - task type detection
- [x] Chat Module (`core/chat/`)
  - [x] `ChatSession` - reusable history management
  - [x] Sliding window for LLM context
  - [x] Streaming utilities
- [x] Build System Modernization
  - [x] Strict TypeScript configuration
  - [x] Biome for linting
  - [x] `bun run build` passes
  - [x] `bun run lint` passes
- [x] Views refactored to pure UI
  - [x] TaskModal delegates to NotientAgent
  - [x] Sidebar delegates to services via Kernel
  - [x] Legacy `services/lmstudio.ts` marked @deprecated

### Phase 2: AGENTIC (Next Priority)

**Goal:** Trust levels, bulk operations, undo system.

**Capabilities:**
- [ ] Trust-level agent actions (low/medium/high risk)
- [ ] Bulk omnibar commands (`/enrich all in folder/`)
- [ ] Workflow runner (note/folder/vault scope)
- [ ] Action history with undo
- [ ] Conversation persistence across sessions
- [ ] Dashboard as command center

**Exit criteria:**
- Low-risk actions auto-apply
- Medium/high-risk actions confirm
- Undo works for tracked actions
- Bulk operations show progress

### Phase 3: INTELLIGENCE

**Goal:** Smart classification, suggestions, inbox workflow.

**Capabilities:**
- Multi-pass processing (classify → enrich → link)
- Inbox triage workflow
- Suggested tags/links with preview
- Background classification
- Note health scoring algorithm

**Exit criteria:**
- Inbox notes get classification suggestions
- User can batch-review suggestions
- Suggestions are previewable and safe

## 7) Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-06 | Hybrid embeddings (note + sections) | Flexible retrieval, broad + precise |
| 2026-01-06 | LLM reranking over pure cosine | Smarter results, competitive with SC v4 |
| 2026-01-06 | Dynamic context per query | More relevant than static vault scan |
| 2026-01-06 | Dual-panel sidebar | Search + chat always visible |
| 2026-01-06 | Trust levels for agents | Balance automation vs user control |
| 2026-01-06 | Remove all debug telemetry | Clean code, no data leaks |
| 2026-01-06 | Full architectural reset | Comprehensive fix over incremental patches |
| 2026-01-06 | Tabbed sidebar (Note + Agents) | Separate note-centric view from chat |
| 2026-01-06 | Sentient Notes philosophy | Notes as living entities with health/agency |
| 2026-01-06 | Omnibar search | Single input for all query types |
| 2026-01-06 | Streaming responses required | Real-time token display for chat |
| 2026-01-06 | Phase 1.6 complete | UI/UX overhaul done |
| 2026-01-06 | Agent Streams = vault-global | Activity feed aggregates all agent tasks |
| 2026-01-06 | Chat in popup modal only | TaskModal opens on card click, chat there |
| 2026-01-06 | Search presets | Quick/Balanced/Thorough + Custom option |
| 2026-01-06 | Sequential task execution | One agent task at a time (queue) |
| 2026-01-06 | Session-only activity | Activity stream clears on restart |
| 2026-01-06 | Enter sends chat | Shift+Enter for newlines |
| 2026-01-06 | Cancel discards partial | Don't keep partial responses |
| 2026-01-06 | 10-message sliding window | LLM context limited to recent messages |
| 2026-01-06 | Prompt LLM for citations | `[[Note Name]]` format in system prompt |
| 2026-01-06 | Phase order: Agentic then Intelligence | Phase 2 = trust levels, Phase 3 = classification |
| 2026-01-06 | LLMProvider interface | Enables swappable providers (<50 lines each) |
| 2026-01-06 | NotientAgent centralization | Single source of truth for agent logic |
| 2026-01-06 | ChatSession reusability | Shared across TaskModal and future views |
| 2026-01-06 | Biome for linting | Modern tooling, strict checks |
| 2026-01-06 | Phase 1.7 complete | Backend parity achieved |
| 2026-01-06 | Phase 1.8 complete | Clean architecture established |

## 8) Current state summary

### Build verification
```bash
$ bun run build      # ✅ Passes
$ bun run typecheck  # ✅ No errors
$ bun run lint       # ✅ Minor warnings only
```

### Code metrics
- **Total TypeScript files:** ~45
- **Lines of CSS:** ~4000 (nv2-* design system)
- **Core modules:** 3 (llm, agent, chat)
- **Service registrations:** 12 in Kernel

### Services registered in Kernel
1. `healthMonitor` - Service health monitoring
2. `ollama` - Embedding generation
3. `lmstudio` - Legacy reasoning (deprecated)
4. `vectorStore` - Vector storage
5. `indexManager` - Index state management
6. `indexer` - Batch indexing
7. `search` - Search pipeline
8. `context` - Vault context builder
9. `vitals` - Vault health metrics
10. `llmProvider` - New LLM abstraction
11. `agent` - NotientAgent
12. `taskQueue` - AgentTaskQueue

### Ready for Phase 2
All Phase 1 work is complete:
- ✅ Clean architecture with separated concerns
- ✅ LLM abstraction for easy provider swapping
- ✅ Centralized agent logic
- ✅ Reusable chat session management
- ✅ Full UI/backend parity
- ✅ Modern build tooling

---

*Last updated: 2026-01-06*
*Author: Anthony Kougkas*
*Version: 3.0 (Phase 1 Complete - Ready for Phase 2: AGENTIC)*
