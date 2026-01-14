# Phase Universe: Foundation Refactor

**Status**: ACTIVE (75% Complete)
**Created**: 2026-01-12
**Updated**: 2026-01-14 (Swarm Architecture Decision)
**Supersedes**: Phase 0-8 Roadmap (archived)

## Progress Summary

| Deliverable | Status | Owner | Notes |
|-------------|--------|-------|-------|
| D1: SQLite Data Layer | ✅ COMPLETE | Gemini | Schema + migrations ready |
| D2: HNSW Worker | ✅ COMPLETE | Gemini | vector.worker.ts operational |
| D3: Event Wiring | ✅ COMPLETE | — | Reranker + action:proposed |
| D4: Swarm Architecture | ✅ COMPLETE | — | All phases merged to beta-spec |
| D5: Cleanup + embed.worker | 🔄 IN PROGRESS | Sage | workflowAgents.ts deleted, embed.worker pending |
| D6: Frontmatter Bridge | ✅ COMPLETE | Archie | syncToFrontmatter() + command |
| D7: Vitals MetadataCache | ✅ COMPLETE | Faye | resolvedLinks direct usage |
| D8: Editor Decorations | ⏸️ DEFERRED | — | After infrastructure complete |
| D9: Context Menus | ✅ COMPLETE | Sage | editor-menu + file-menu |
| D11: Skills Integration | ✅ COMPLETE | Gemini | Skills Registry + UI Badges |

---

## Overview

Phase Universe is a foundational refactor that replaces the entire previous roadmap. No feature work proceeds until this phase is complete. The goal is a **high-performance, Obsidian-native intelligence layer** where the Note is the primary unit of interaction.

### The Core Insight: "The Note is the Unit"

> **Architectural Audit Finding (2026-01-12):**
> Notient currently operates as a "sidecar" — powerful AI infrastructure that runs alongside Obsidian
> but displays all intelligence in the sidebar. The user must look AWAY from their note to see what
> the AI thinks. This is backwards.
>
> **The Correction:** The Note should be the canvas where intelligence is displayed. The sidebar is
> for commands and history, but insights must appear IN the editor, IN the frontmatter, and IN the
> note's context.

### Core Principles

1. **Note is the Unit** — Intelligence surfaces IN the note (frontmatter, decorations, callouts), not just the sidebar.
2. **Obsidian-Native First** — Use `metadataCache`, `processFrontMatter`, Editor Extensions before building custom.
3. **Data layer supports, doesn't replace** — SQLite/Workers for heavy lifting, but Obsidian APIs for user-facing data.
4. **Main thread is sacred** — <16ms operations only. Everything heavy in Workers.
5. **4-Agent Swarm Architecture** — Orchestrator (brain), NoteEditor (Obsidian I/O), ContextBuilder (vault awareness), Worker (workflow executor). Clear separation of concerns. See `SWARM-ARCHITECTURE.md`.
6. **User-controlled intelligence spectrum** — From minimal (passive health display) to proactive (suggestions, completions). User decides.

---

## Architecture: Two Layers

### Layer 1: Infrastructure (D1-D5)
Heavy computation that Obsidian can't do natively. Runs in background, invisible to user.

```
┌─────────────────────────────────────────────────────────────────┐
│                 INFRASTRUCTURE LAYER (Hidden)                    │
│                                                                  │
│  SQLite (sql.js)     HNSW Worker       Embedding Cache          │
│  - chunks            - vector search   - model-scoped           │
│  - embeddings        - O(log N)        - rebuild on change      │
│  - messages          - zero-copy       - background batching    │
│  - actions                                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 2: Integration (D6-D9)
User-facing intelligence that lives IN the note. Uses native Obsidian APIs.

```
┌─────────────────────────────────────────────────────────────────┐
│                 INTEGRATION LAYER (Visible)                      │
│                                                                  │
│  Frontmatter Props    Editor Decorations    Context Menus       │
│  - notient-health     - stale indicators    - "Find related"    │
│  - notient-summary    - entity highlights   - "Enhance this"    │
│  - notient-entities   - ghost completions   - "Classify note"   │
│                                                                  │
│  MetadataCache        Post Processors       Workspace Events    │
│  - use resolvedLinks  - AI callout render   - active-leaf-change│
│  - derive vitals      - entity tooltips     - file-menu         │
└─────────────────────────────────────────────────────────────────┘
```

### The Flow

```
User opens note
      ↓
┌─────────────────────────────────────────────────────────────────┐
│                    OBSIDIAN (Source of Truth)                    │
│  metadataCache.resolvedLinks → connectivity                      │
│  metadataCache.getFileCache() → tags, links, frontmatter        │
│  processFrontMatter() → read/write notient-* properties         │
└────────────────────────────────┬────────────────────────────────┘
                                 │
      ┌──────────────────────────┼──────────────────────────────┐
      ↓                          ↓                              ↓
  Frontmatter              Editor View                    Sidebar
  notient-health: 78       [Decorations]                  [History]
  notient-summary: "..."   "stale" underline              [Chat]
                           entity highlights              [Actions]
```

---

## Architecture Decisions

### Data Layer (What lives WHERE)

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| **Chunks** | SQLite | Too large for frontmatter, model-agnostic |
| **Embeddings** | SQLite | Model-specific blobs, need fast lookup |
| **Conversations** | SQLite | History, searchable, per-note keyed |
| **Actions** | SQLite | Audit trail, undo history |
| **Health Score** | **Frontmatter** | Portable, visible in Obsidian search/dataview |
| **Summary** | **Frontmatter** | Portable, user can see/edit |
| **Entities** | **Frontmatter** | Portable, becomes metadata |
| **Vitals (links/tags)** | **metadataCache** | Already computed by Obsidian, don't duplicate |

### SQLite Persistence Strategy
- Load `notient.db` into memory on startup via `sql.js`
- Work entirely in memory (fast queries)
- Flush to disk via Obsidian `adapter.write()` on:
  - Explicit save (user action)
  - Debounced auto-save (every 30s during activity)
  - Plugin unload
- Location: `.obsidian/plugins/notient/data/notient.db`

### Worker Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAIN THREAD (UI Only)                         │
│                                                                  │
│  Preact UI ←→ Signals ←→ EventBus ←→ ChiefOfStaff               │
│                              ↓                                   │
│                         postMessage                              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────────────────┐
        ↓                      ↓                                  ↓
┌───────────────┐    ┌─────────────────┐    ┌─────────────────────┐
│ vector.worker │    │  embed.worker   │    │  (future)           │
│   ✅ DONE     │    │   📋 THIS PHASE │    │  db.worker          │
│ HNSW index    │    │  4 concurrent   │    │  SQLite queries     │
│ search()      │    │  HTTP calls to  │    │  (if needed)        │
│ addItems()    │    │  Ollama embed   │    │                     │
└───────────────┘    └─────────────────┘    └─────────────────────┘
```

**Phase Universe scope**: `vector.worker` ✅ + `embed.worker` 📋. DB stays on main thread (sql.js is fast enough).

---

## Deliverables

### INFRASTRUCTURE LAYER (D1-D5)

---

### D1: SQLite Data Layer (Priority: CRITICAL) ✅ COMPLETE

**Status**: COMPLETE (2026-01-12)

**Files created:**
- `src/core/db/schema.ts` — Table definitions (Kysely types)
- `src/core/db/database.ts` — sql.js wrapper with Obsidian adapter
- `src/core/db/migrations.ts` — Schema versioning
- `src/core/db/kysely-sqljs.ts` — Kysely driver for sql.js
- `src/core/db/json-migration.ts` — Legacy JSON import

**Schema (v1):** 8 tables (notes, note_tags, note_meta, chunks, embeddings, actions, messages, intelligence)

---

### D2: HNSW Worker Isolation (Priority: CRITICAL) ✅ COMPLETE

**Status**: COMPLETE (2026-01-13)

**Files created:**
- `src/workers/vector.worker.ts` — Worker entry point
- `src/core/vector/workerBridge.ts` — Main thread proxy

**Commit**: `71f557e feat(universe): D2 HNSW Worker isolation complete`

**Key achievements:**
- Main thread has NO `hnswlib-wasm` import
- HNSWVectorStore delegates search to Worker, queries SQLite for metadata
- Binary hnsw.bin persistence only (metadata via SQLite)

---

### D3: Event Wiring Completion (Priority: HIGH) 🔄 IN PROGRESS

Absorbs Phase 0 Issues 3, 6, 7, 8:

| Issue | Fix |
|-------|-----|
| Reranker output parsing | Parse `SCORE: X` format (model outputs lines, not JSON) |
| action:proposed event | Emit from ChiefOfStaff (not TaskQueue) after agent returns |
| Action applier wiring | Wire `action:apply-requested` → ActionApplier in main.ts |
| Capability cards | Wire HealthMonitor → AgentStreamsView props |

**Interview Decision (2026-01-13):** Reranker uses qwen-based models that output `SCORE: 0/3/7/10` lines.
No JSON parsing needed. Simple regex extraction:

```typescript
const match = output.match(/SCORE:\s*(\d+)/);
const score = match ? parseInt(match[1]) : 0;
```

**Key change**: ChiefOfStaff is the ONLY emitter of user-facing events. TaskQueue is internal.

**Estimated effort**: 4 hours (reduced - simpler parsing)

---

### D4: Swarm Architecture (Priority: HIGH) 🔄 REDESIGNED

**Status**: REDESIGNED (2026-01-14 Architecture Decision)

**Previous plan**: Merge actionOrchestrator → ChiefOfStaff (functional composition)

**New plan**: 4-Agent Swarm with clear separation of concerns. See `SWARM-ARCHITECTURE.md` for full specification.

**The Core Insight (2026-01-14):**
> The current 13+ agent system has accidental complexity. Each "agent" (Classifier, Connection, 
> Workflow) does the same thing: build prompt → call LLM → parse output. The complexity isn't 
> in the PROBLEM, it's in the IMPLEMENTATION.
>
> **The Correction:** 4 specialized agents, each with ONE job. Orchestrator reasons about WHAT 
> to do. Other agents focus on HOW to do it well.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR (Brain)                              │
│  • Receives ALL requests (UI, Chat, Editor Decorations)                 │
│  • Makes action plans using reasoning model                             │
│  • Delegates to specialized agents                                       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────────────┐
        ▼                           ▼                                   ▼
┌───────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│    NoteEditor     │     │   ContextBuilder    │     │       Worker        │
│ • Edit/Create     │     │ • Search vault      │     │ • Execute workflows │
│ • Canvas/Bases    │     │ • Find related      │     │ • Classify, Enhance │
│ • Self-verify     │     │ • User behavior     │     │ • Atomize, Connect  │
│ Uses: Skills      │     │ Uses: Search        │     │ Uses: Prompts       │
└───────────────────┘     └─────────────────────┘     └─────────────────────┘
```

**Three Triggers → Orchestrator:**
1. **UI** — Quick Actions, Agent Streams
2. **ChatService** — Hybrid mode (conversation OR agent delegation)
3. **Editor Decorations** — Live conversation during note editing (D8)

**Files to modify:**
- `src/core/agents/chiefOfStaff.ts` → Refactor to pure Orchestrator
- `src/core/agents/workerAgent.ts` → CREATE (unified workflow executor)
- `src/core/agents/noteEditorAgent.ts` → Enhance with self-verification
- `src/core/agents/contextBuilderAgent.ts` → Add behavior/trend tracking
- `src/core/chat/chatService.ts` → Add Orchestrator trigger (hybrid)

**Files to DELETE (in D5):**
- `src/core/agents/classifierAgent.ts` → "classify" workflow in Worker
- `src/core/agents/connectionAgent.ts` → "connect" workflow in Worker
- `src/core/agents/workflowAgents.ts` → Absorbed into Worker

**Implementation Phases:**
1. ✅ Phase 1: Refactor Orchestrator (brain only) — `470a1bf`
2. ✅ Phase 2: Create Worker Agent (unified workflows) — `c2c111a`
3. ✅ Phase 3: Enhance NoteEditor (self-verification) — `b9e0bb0`
4. ✅ Phase 4: Enhance ContextBuilder (behavior tracking) — `f524ef8`
5. ✅ Phase 5: ChatService integration (hybrid mode) — `cf9c289`

**Status**: COMPLETE — All phases merged to beta-spec

---

### D5: Cleanup + embed.worker (Priority: MEDIUM) 📋 READY

**Interview Decision (2026-01-13 + 2026-01-14):**
- Create `embed.worker` for parallel HTTP calls to Ollama (4 concurrent)
- Dead code scope: **EXPANDED** (Swarm Architecture cleanup)
- Hardware: Mid-range GPU (8-12GB) → 4 concurrent is safe

| Issue | Action |
|-------|--------|
| Sequential embeddings | Create `embed.worker` with 4 concurrent HTTP calls |
| Dead ChatAgent | Delete file |
| Absorbed ClassifierAgent | Delete file (now "classify" workflow in Worker) |
| Absorbed ConnectionAgent | Delete file (now "connect" workflow in Worker) |
| Absorbed WorkflowAgents | Delete file (unified into Worker) |
| FS.syncfs race | Solved by Worker isolation |

**embed.worker API:**

```typescript
// Messages TO worker
type EmbedCommand =
  | { type: 'embed'; texts: string[]; requestId: string }
  | { type: 'configure'; ollamaUrl: string; model: string };

// Messages FROM worker
type EmbedResult =
  | { type: 'embedResult'; requestId: string; embeddings: Float32Array[] }
  | { type: 'error'; requestId: string; message: string };
```

**Estimated effort**: 6 hours

---

### INTEGRATION LAYER (D6-D9) — NEW

---

### D6: Frontmatter Intelligence Bridge (Priority: HIGH) ✅ COMPLETE

**Status**: COMPLETE (2026-01-13)
**Owner**: Archie
**Commit**: `8472aec feat(d6): frontmatter intelligence bridge - write-on-demand sync`

**Files modified:**
- `src/core/intelligence/noteIntelligence.ts` — Added `syncToFrontmatter()` method
- `src/main.ts` — Added `sync-intelligence-to-frontmatter` command

**Interview Decision (2026-01-13):** Write-on-demand only. User triggers via command.
No automatic frontmatter writes (avoids Obsidian Sync conflicts).

**Frontmatter Schema:**

```yaml
---
notient-health: "78/100"
notient-summary: "One-line AI summary"
notient-entities:
  - "John Smith"
  - "Machine Learning"
notient-updated: 2026-01-12T10:30:00Z
---
```

**Benefits:**
- Intelligence is PORTABLE (survives note moves, Obsidian sync)
- Visible in Obsidian search (`notient-health:>50`)
- Compatible with Dataview queries

---

### D7: Vitals from MetadataCache (Priority: HIGH) ✅ COMPLETE

**Status**: COMPLETE (2026-01-13)
**Owner**: Faye
**Commit**: `2aee5ab refactor(d7): optimize vitals using metadataCache.resolvedLinks`

**Files modified:**
- `src/core/vitals/simpleVitals.ts` — Refactored to use `metadataCache.resolvedLinks` directly

**Key changes:**
- Replaced O(n) custom `resolveLink()` with direct `resolvedLinks` lookup
- Comment: "O(N) instead of O(N^2)"
- Deleted the custom link resolution method

**Interview Decision (2026-01-13):** Chose to refactor simpleVitals.ts rather than delete it.
Safer approach - same result (use metadataCache) without breaking changes.

---

### D8: Editor Decorations (Priority: MEDIUM) ⏸️ DEFERRED

**Status**: DEFERRED (Infrastructure first, per interview 2026-01-13)
**Updated**: 2026-01-14 (Tab trigger confirmed)

**Interview Decisions:**
- **Trigger**: Ghost text on **Tab key press** (explicit, Copilot-style)
- **UI Framework**: **Strict separation** — CM6 for editor, Preact for sidebar
- **First decoration type**: AI suggestion ghost text (Copilot-style)
- **Data source**: Signal cache → Decoration (reactive)
- **Flow**: Tab → Orchestrator → Worker (completion workflow) → Ghost text widget

**Reference**: `docs/obsidian/OBSIDIAN-EDITOR.md`

**Implementation approach (when ready):**

```typescript
// CodeMirror 6 StateField (NO Preact in editor layer)
import { StateField, Decoration, DecorationSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const notientDecorations = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decorations, transaction) {
    // Update based on intelligence signal changes
  },
  provide: f => EditorView.decorations.from(f)
});
```

**Files to create (future):**
- `src/ui/editor/notientDecorations.ts` — StateField + decorations
- `src/ui/editor/ghostText.ts` — AI completion widget
- `src/ui/editor/index.ts` — Registration with Obsidian

**Estimated effort**: 8 hours (post-infrastructure)

---

### D9: Context Menu Integration (Priority: MEDIUM) ✅ COMPLETE

**Status**: COMPLETE (2026-01-13)
**Owner**: Sage
**Commit**: `4baceba feat(d9): context menu integration - editor and file menu AI actions`

**Files modified:**
- `src/main.ts` — Added editor-menu and file-menu registrations
- `src/types/events.ts` — Added action:find-related, action:enhance, action:analyze event types
- `src/ui/sidebar/components/Omnibar.tsx` — Wired search query signal

**Menu items:**
- **Editor menu** (on selection): "Find related notes", "Enhance this section"
- **File menu** (right-click file): "Analyze note"

**Interview Decision (2026-01-13):** All actions go through TaskQueue (async).
Keep current Agent Streams design for showing results.

---

### D10: SQLite Full Migration (Priority: CRITICAL) 📋 NEW

**Status**: READY (Interview decision 2026-01-13)

**Goal**: Replace ALL JSON stores with SQLite. No backward compatibility needed (early dev).

**Interview Decisions:**
- **Hard cutover**: Delete JSON files, no migration logic
- **Schema redesign**: Review ConversationStore needs, update D1 schema to match
- **No data preservation**: Test data only, clean slate

**Stores to migrate:**

| JSON Store | SQLite Table | Notes |
|------------|--------------|-------|
| `ConversationStore` | `messages` | Redesign schema for ConversationStore needs |
| `ActionHistory` | `actions` | Use existing schema |
| `IntelligenceDb` | `intelligence` | Use existing schema |

**Files to modify:**
- `src/core/db/schema.ts` — Update messages table if needed
- `src/core/chat/conversationStore.ts` — Replace JSON with SQLite
- `src/core/agentic/actionHistory.ts` — Replace JSON with SQLite
- `src/core/intelligence/intelligenceDb.ts` — Replace JSON with SQLite

**DELETE after migration:**
- All `node:fs` imports from migrated files
- JSON file creation/reading logic

**Estimated effort**: 8 hours

---

## Execution Order (Updated 2026-01-14)

```
COMPLETED:
├── D1: SQLite Data Layer ✅
├── D2: HNSW Worker ✅
├── D6: Frontmatter Bridge ✅
├── D7: Vitals MetadataCache ✅
├── D9: Context Menus ✅
└── D11: Skills Integration ✅

NEXT SESSION — D4: Swarm Architecture (NEW PRIORITY):
│
├── Phase 1: Refactor ChiefOfStaff → Orchestrator (brain only)
├── Phase 2: Create WorkerAgent (unified workflow executor)
├── Phase 3: Enhance NoteEditor (self-verification)
├── Phase 4: Enhance ContextBuilder (behavior/trend tracking)
└── Phase 5: ChatService integration (hybrid mode)

PARALLEL WITH D4:
│
├── D10: SQLite Migration (conversations, actions, intelligence)
├── D3: Event Wiring (depends on D4 Phase 1)
└── D5: embed.worker + delete absorbed agents (after D4 Phase 5)

DEFERRED (Post-Infrastructure):
└── D8: Editor Decorations
    └── Ghost text on explicit request (Tab key)
    └── 3rd trigger for Orchestrator
```

**Remaining effort**: ~28 hours (+8 for Swarm Architecture)

---

## Validation Criteria

### Startup Performance

- [ ] Plugin loads, UI shell visible in **<1 second**
- [ ] Note selection triggers context load (vitals, actions) in **<500ms**
- [ ] Full vault indexed in background without UI jank

### Core Functionality

- [ ] Quick Actions produce results (actions appear in pending)
- [ ] Apply button applies actions (note modified, undo available)
- [ ] Search returns reranked results (SCORE: X parsing works)
- [ ] Chat works (streaming, thinking blocks, context)

### Architecture

- [x] Main thread has NO `hnswlib-wasm` import ✅ (D2)
- [ ] All data queries go through SQLite (D10 pending)
- [ ] 4-Agent Swarm operational (D4 pending)
  - [ ] Orchestrator receives all requests
  - [ ] NoteEditor with self-verification
  - [ ] ContextBuilder with behavior tracking
  - [ ] Worker executes all workflows
- [ ] ChatService can trigger Orchestrator (D4 Phase 5)
- [ ] No JSON files for core data (only settings) (D10 pending)
- [ ] embed.worker handles parallel embeddings (D5 pending)
- [ ] Absorbed agents deleted (D5 pending)

### Integration

- [x] `notient-health` appears in frontmatter after sync command ✅ (D6)
- [x] Right-click on selection shows "Notient: Find related" ✅ (D9)
- [x] Right-click on file shows "Notient: Analyze note" ✅ (D9)
- [x] Vitals use `metadataCache.resolvedLinks` ✅ (D7)

### Stability

- [ ] No CPU spikes at idle (<5%)
- [ ] No memory leaks (stable over 1 hour)
- [ ] No console errors during normal operation

---

## Open Questions

1. **FTS5 for full-text search?** — Defer to post-Universe. Vector search is primary.
2. **Multiple embedding models?** — Schema supports it. Implementation deferred.
3. **Cron/scheduled tasks?** — TaskManager supports future queues. Not in Phase Universe scope.
4. ~~**Editor Decorations performance?**~~ — ANSWERED: Ghost text on explicit request only. Strict CM6/Preact separation.
5. ~~**Frontmatter bloat?**~~ — ANSWERED: Write-on-demand. User controls when to sync.

---

## Interview Decisions Log (2026-01-13)

### Infrastructure (Round 1)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Reranker parsing | Parse `SCORE: X` format | Model outputs lines, not JSON |
| Orchestrator | Refactor to ChiefOfStaff | Full orchestrator (route + execute + persist) |
| Parallelism | 4 concurrent embeddings | Mid-range GPU (8-12GB) |
| SQLite migration | Do NOW | Big priority, clean foundation |

### Architecture (Round 2)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| ChiefOfStaff structure | Functional composition | Pure functions, one file |
| Migration strategy | Hard replace JSON | No backward compat needed (early dev) |
| Dead code scope | ChatAgent only | Minimal scope |
| Future workers | Create embed.worker NOW | Parallelize embeddings |

### UX/Vision (Round 3)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| D8 priority | Infrastructure first | Solid foundation before more UI |
| Agent Streams | Keep current design | It works |
| First decoration | AI ghost text | Copilot-style completion |
| UI framework | Strict separation | CM6 for editor, Preact for sidebar |

### Follow-up (Rounds 4-5)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Reranker model | qwen-based, benchmark 3, hardcode best | Simpler than user setting |
| embed.worker scope | Parallelize HTTP calls only | Worker makes 4 concurrent fetch() |
| Data preservation | Nothing to preserve | Test data only |
| Schema for messages | Redesign based on ConversationStore | Better fit |
| Ghost text trigger | On explicit request (Tab) | Not automatic |
| ChiefOfStaff role | Full orchestrator | Routes, executes, AND persists |
| Vision end state | User-controlled spectrum | Minimal → proactive slider |

### Swarm Architecture (2026-01-14)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent count | 4 agents (Orchestrator, NoteEditor, ContextBuilder, Worker) | Clear separation of concerns |
| Worker scope | Unified workflow executor | Absorbs 8 workflow agents + Classifier + Connection |
| ChatService | Hybrid (conversation OR trigger Orchestrator) | Maintains direct chat, enables agent delegation |
| Model config | Configurable per agent type | Orchestrator can use reasoning model, others use faster model |
| Complexity concern | Proceed incrementally | Phase 1: Orchestrator. Phase 2: Worker. Phase 3+: Delete old agents |
| Workflows preserved | Yes, as reusable prompts | No functionality loss, just different executor |
| Three triggers | UI, ChatService, Editor Decorations | All flow through Orchestrator |

### Post-Universe Planning (2026-01-14)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| D8 Ghost Text Trigger | **Tab key** | Explicit request, Copilot-style UX |
| Phase 1 Scope | **ALL**: InsightStream + Quick Actions + Chat | Full feature set after foundation |

---

## Phase 1: Feature Polish (Post-Universe)

> **Prerequisite**: Phase Universe COMPLETE (D1-D11 done, Swarm operational)

### P1.1: InsightStream
Wire agent results to InsightStream in Note Vitals:
- Agent completes → insight appears in stream
- Proactive suggestions from ContextBuilder
- "Vault is talking back" experience

### P1.2: Quick Actions Model
Finalize 3 pinned + 3 contextual:
- **Pinned**: Enhance, Classify, Connect (always visible)
- **Contextual**: Based on note type, tags, recent activity
- Actions trigger Orchestrator → Worker

### P1.3: Chat Improvements
- Contextual suggestion chips (based on active note)
- Chat can trigger Orchestrator for agent tasks
- Agent results stream inline in chat
- Thinking blocks with expand/collapse

### P1.4: Search Enhancement
- Confidence badges on results
- AI justification for rankings
- "Why this result?" expandable

**Estimated effort**: ~40 hours total

---

## Ocean Code Audit (Reference)

These areas were identified as "replicated rather than integrated":

| Area | Current | Correction | Deliverable | Status |
|------|---------|------------|-------------|--------|
| Intelligence storage | Custom JSON | Frontmatter + SQLite | D6, D10 | D6 ✅ |
| Vitals calculation | Re-iterate all files | Use `metadataCache` | D7 | ✅ |
| UI display | Sidebar-only | Editor decorations | D8 | ⏸️ |
| User actions | Sidebar buttons | Context menus | D9 | ✅ |

---

*Phase Universe: Build the foundation, integrate with Obsidian. The Note is the Unit.*
