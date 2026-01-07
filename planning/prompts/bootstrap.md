# MASTER_PLAN.md — Notient (Local-first Obsidian AI Vault Manager)

> **Version 2.3 - Phase 1.7 Architecture Refined**
> Agent Streams = vault-global activity feed. Chat in popup modal. Presets for search.

## 0) Purpose and scope of this master plan

This document is the canonical plan for building **Notient** across multiple development phases and work sessions.

- **PRD**: `planning/PRD.md` (v2.3)
- **UI/UX Spec**: `planning/prompts/ui-ux.md`
- **Phase 1.7 Spec**: `planning/prompts/phase-1.7-backend-completion.md`
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

### 2.2 System decomposition (Current State)

```
Notient Architecture v2.3
├── UI Layer
│   ├── Sidebar (Note Vitals + Agent Streams) ✅
│   ├── TaskModal (popup with chat) ← Phase 1.7
│   ├── Setup Wizard ✅
│   ├── Settings Tab ✅
│   └── Dashboard (Vault Vitals) - basic
│
├── Core Services
│   ├── Kernel (service orchestration) ✅
│   ├── EventBus (typed pub/sub) ✅
│   └── VaultContextBuilder (dynamic, per-query) ✅
│
├── AI Services
│   ├── OllamaService (embeddings) ✅
│   ├── LMStudioService (reasoning, reranking, chat streaming) ✅
│   └── SearchPipeline (vector + LLM rerank) ✅
│
├── Storage Services
│   ├── SimpleVectorStore (brute-force cosine) ✅
│   ├── IndexManager (state tracking) ✅
│   └── AgentTaskQueue (task queue, session-only) ← Phase 1.7
│
└── Agent Services ← Phase 2/3
    ├── ClassificationAgent
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

## 3) Repository layout (code)

### 3.1 Source layout (Current)

```
src/
├── main.ts                     # Plugin entry ✅
├── settings.ts                 # Settings tab + store ✅
├── styles.css                  # Design system (nv2-* classes) ✅
│
├── views/
│   ├── sidebar.ts              # Two-view (Note Vitals + Agent Streams) ✅
│   ├── taskModal.ts            # Task popup with chat ← Phase 1.7
│   ├── dashboard.ts            # Vault Vitals (basic) ✅
│   ├── setupWizard.ts          # Setup wizard modal ✅
│   └── indexOptionsModal.ts    # Index action picker ✅
│
├── core/
│   ├── kernel.ts               # Service manager ✅
│   ├── constants.ts            # App constants ✅
│   ├── events/eventBus.ts      # Typed event bus ✅
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
│   ├── lmstudio.ts             # Reasoning/chat/streaming ✅
│   ├── simpleVectorStore.ts    # Vector storage ✅
│   ├── indexManager.ts         # Index state ✅
│   ├── agentTaskQueue.ts       # Task queue (session-only) ← Phase 1.7
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
    └── agentTask.ts            # Task/queue types ← Phase 1.7
```

### 3.2 Data layout (on disk)

```
{vaultRoot}/.obsidian/plugins/notient/
├── data.json                   # Plugin settings
├── index-{modelKey}.json       # Hybrid embeddings (notes + sections)
├── state-{modelKey}.json       # Index state
├── conversations.json          # Chat history (Phase 1.7)
├── cache/                      # LRU caches
└── locks/                      # Multi-window safety
```

## 4) Core services (Implemented)

### 4.1 LMStudioService ✅

```typescript
interface LMStudioService {
  // Health & status
  listModels(): Promise<string[]>;
  isReady(): boolean;

  // Reasoning operations
  rerank(query: string, candidates: RerankCandidate[]): Promise<RankedResult[]>;
  chat(messages: ChatMessage[]): Promise<string>;

  // Streaming support ✅
  chatStream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
  
  // Context building
  buildChatSystemPrompt(context: string, notes: RelevantNote[]): string;
}
```

### 4.2 VaultContextBuilder ✅

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

### 4.3 SearchPipeline ✅

```typescript
interface SearchPipeline {
  search(query: string, options: ExtendedSearchOptions): Promise<SearchResult[]>;
  findRelated(path: string, options: RelatedOptions): Promise<RelatedNote[]>;
  clearCache(): void;

  // Phase 1: Vector search (fast, top-50)
  // Phase 2: LLM reranking (smart, final top-K)
  // Phase 3: Build dynamic context for chat
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

### 5.2 TaskModal (Phase 1.7)

Popup that opens when clicking any task card:
- Note preview section
- RAG sources (citations used for context)
- Task results when complete
- **Chat section**: message bubbles, Enter sends, streaming with cancel
- Citations as `[[Note Name]]` links

### 5.3 Design System ✅

CSS classes use `nv2-*` prefix. Key tokens:
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
- [x] Agent streaming via sendQuery()
- [x] Quick actions (Enrich, Link, Move)
- [x] Insight Stream with suggestions
- [x] Agent Dashboard cards
- [x] Activity Log from chat history
- [x] Footer with service status

### Phase 1.7: BACKEND COMPLETION (Next Priority)

**Goal:** Achieve UI-backend parity with hybrid scope.

**Scope:** Foundation now, defer bulk operations to Phase 2.

**Search Settings with Presets:**
- [ ] Preset dropdown: Quick / Balanced / Thorough / Custom
- [ ] Custom mode reveals: top-K slider, reranking toggle, min score
- [ ] Wire presets to SearchPipeline

**Agent Task System (Core New Architecture):**
- [ ] `AgentTask` type with status, progress, per-task chat history
- [ ] `AgentTaskQueue` service (sequential, one at a time)
- [ ] Activity stream with full task cards (not just activity log)
- [ ] Quick Actions fire tasks → appear in stream
- [ ] Cancel button (always cancelable)

**TaskModal Popup:**
- [ ] Note preview section
- [ ] RAG sources (citations)
- [ ] Task results display
- [ ] Chat section with message bubbles
- [ ] Enter sends, Shift+Enter newline
- [ ] Streaming with cursor, cancel discards partial
- [ ] Citations as `[[Note Name]]` links (prompt LLM to use format)

**Agent Dashboard Status:**
- [ ] Three capability cards: Semantic Search, Context Builder, Chat Assistant
- [ ] Combined status: health dot + pulsing when processing
- [ ] Last activity timestamp per agent

**Index Progress in Footer:**
- [ ] Non-blocking progress bar during indexing
- [ ] Note count: "X notes indexed"
- [ ] Last sync timestamp

**Key Decisions (from interview):**
- Chat in popup modal only (not main Agent Streams view)
- Enter sends, Shift+Enter for newlines
- Cancel discards partial response entirely
- Last 10 messages to LLM (sliding window)
- Inline `[[Note Name]]` citations (prompt LLM)
- Session-only activity retention
- Sequential task execution (one at a time)

**Deferred to Phase 2:**
- Bulk omnibar commands
- Complex queue management
- Conversation persistence across sessions
- Multi-agent orchestration on single note

**Exit criteria:**
- Task cards appear in activity stream
- TaskModal opens with full context + chat
- Search presets work correctly
- Agent dashboard shows real status

### Phase 2: AGENTIC

**Goal:** Trust levels, bulk operations, undo system.

**Capabilities:**
- Trust-level agent actions (low/medium/high risk)
- Bulk omnibar commands (`/enrich all in folder/`)
- Workflow runner (note/folder/vault scope)
- Action history with undo
- Conversation persistence across sessions
- Dashboard as command center

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
| 2026-01-06 | Phase 1.6 complete | UI/UX overhaul done, backend parity needed |
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

---

*Last updated: 2026-01-06*
*Author: Anthony Kougkas*
*Version: 2.3 (Phase 1.7 Architecture Refined)*
