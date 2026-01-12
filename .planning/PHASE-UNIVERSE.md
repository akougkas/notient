# Phase Universe: Foundation Refactor

**Status**: ACTIVE
**Created**: 2026-01-12
**Supersedes**: Phase 0-8 Roadmap (archived)

---

## Overview

Phase Universe is a foundational refactor that replaces the entire previous roadmap. No feature work proceeds until this phase is complete. The goal is a **high-performance, robust backend** that can support any future feature development.

### Core Principles

1. **Data layer first** — SQLite for metadata, Worker for vectors. No more JSON files.
2. **Main thread is sacred** — <16ms operations only. Everything heavy in Workers.
3. **Eventually consistent UI** — Fast boot, progressive enhancement, context-aware loading.
4. **Clear orchestration boundaries** — ChiefOfStaff reasons, TaskQueues execute, Agents are tools.

---

## Architecture Decisions

### Data Layer

| Component | Current | Target |
|-----------|---------|--------|
| Metadata | JSON files (idx_*.json) | **sql.js WASM** in-memory + flush to .db |
| Vectors | HNSW on main thread | **Web Worker** with postMessage |
| Conversations | Single JSON file | SQLite `messages` table |
| Intelligence | Model-keyed JSON | SQLite `intelligence` table |
| Actions | Time-bucketed JSON | SQLite `actions` table |

**SQLite Persistence Strategy:**
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
        ┌──────────────────────┼──────────────────────┐
        ↓                      ↓                      ↓
┌───────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ vector.worker │    │  db.worker      │    │ embed.worker    │
│               │    │  (future)       │    │  (future)       │
│ HNSW index    │    │ SQLite queries  │    │ Ollama batching │
│ search()      │    │ (if needed)     │    │                 │
│ addItems()    │    │                 │    │                 │
└───────────────┘    └─────────────────┘    └─────────────────┘
```

**Phase Universe scope**: `vector.worker` only. DB stays on main thread (sql.js is fast enough). Embed worker is future optimization.

### Orchestration Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                      ChiefOfStaff (Brain)                        │
│                                                                  │
│  • Routes user intent to appropriate handler                     │
│  • Reasons about context, decides what to do                     │
│  • Can autonomously fire tasks (proactive suggestions)           │
│  • SINGLE source of events to UI signals                         │
│  • Owns agent lifecycle                                          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ↓                           ↓
          ┌─────────────────┐         ┌─────────────────┐
          │ InteractiveQueue │         │ BackgroundQueue │
          │                 │         │                 │
          │ User-triggered  │         │ Proactive tasks │
          │ Quick Actions   │         │ Nightly jobs    │
          │ Chat requests   │         │ Index updates   │
          └────────┬────────┘         └────────┬────────┘
                   │                           │
                   └───────────┬───────────────┘
                               ↓
                    ┌─────────────────┐
                    │     Agents      │
                    │                 │
                    │ Pure functions  │
                    │ Input → Output  │
                    │ No UI access    │
                    │ No event emit   │
                    └─────────────────┘
```

**Key change**: Agents NEVER emit events. They return results to TaskQueue, which reports to ChiefOfStaff, which emits to UI. Single path.

---

## Deliverables

### D1: SQLite Data Layer (Priority: CRITICAL)

**Files to create:**
- `src/core/db/schema.ts` — Table definitions (Kysely types)
- `src/core/db/database.ts` — sql.js wrapper with typed queries
- `src/core/db/migrations.ts` — Schema versioning

**Schema (v1):**

```sql
-- Core metadata
CREATE TABLE notes (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  title TEXT,
  health_score REAL,
  para_type TEXT,
  word_count INTEGER
);

CREATE TABLE note_tags (
  note_path TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_path, tag),
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

CREATE TABLE note_meta (
  note_path TEXT NOT NULL,
  key TEXT NOT NULL,
  value_type TEXT NOT NULL, -- 'text' | 'number' | 'bool' | 'date'
  value_text TEXT,
  value_number REAL,
  PRIMARY KEY (note_path, key),
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

-- Chunks (model-agnostic)
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL,
  tier TEXT NOT NULL, -- 'note' | 'section' | 'block'
  kind TEXT NOT NULL, -- 'paragraph' | 'list' | 'code' | etc.
  parent_chunk_id TEXT,
  heading_path TEXT, -- JSON array
  text TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

-- Embeddings (model-scoped, separate for easy rebuild)
CREATE TABLE embeddings (
  chunk_id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector BLOB NOT NULL, -- Float32Array as blob
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

-- Actions
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  type TEXT NOT NULL,
  risk TEXT NOT NULL,
  note_path TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  undone_at INTEGER,
  payload TEXT NOT NULL -- JSON
);

-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  note_path TEXT, -- null for vault-wide chat
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  thinking TEXT,
  created_at INTEGER NOT NULL
);

-- Intelligence
CREATE TABLE intelligence (
  note_path TEXT PRIMARY KEY,
  health TEXT, -- JSON
  entities TEXT, -- JSON
  suggestions TEXT, -- JSON
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (note_path) REFERENCES notes(path)
);

-- Indexes
CREATE INDEX idx_notes_mtime ON notes(mtime);
CREATE INDEX idx_notes_health ON notes(health_score);
CREATE INDEX idx_chunks_note ON chunks(note_path);
CREATE INDEX idx_embeddings_model ON embeddings(model_key);
CREATE INDEX idx_actions_created ON actions(created_at);
CREATE INDEX idx_messages_note ON messages(note_path);
```

**Migration from JSON:**
- On first load, detect existing JSON files
- Import to SQLite
- Rename JSON files to `.backup`

**Estimated effort**: 8 hours

---

### D2: HNSW Worker Isolation (Priority: CRITICAL)

**Files to create:**
- `src/workers/vector.worker.ts` — Worker entry point
- `src/core/vector/workerBridge.ts` — Main thread proxy

**Worker API:**

```typescript
// Messages TO worker
type VectorCommand =
  | { type: 'init'; config: HNSWConfig }
  | { type: 'search'; embedding: Float32Array; k: number; requestId: string }
  | { type: 'addItems'; items: Array<{ id: string; embedding: Float32Array }> }
  | { type: 'markDeleted'; ids: string[] }
  | { type: 'save' }
  | { type: 'load'; data: ArrayBuffer };

// Messages FROM worker
type VectorResult =
  | { type: 'ready' }
  | { type: 'searchResult'; requestId: string; results: Array<{ id: string; score: number }> }
  | { type: 'addComplete'; count: number }
  | { type: 'saveComplete'; data: ArrayBuffer }
  | { type: 'error'; message: string };
```

**Bridge usage:**

```typescript
const vectorBridge = new VectorWorkerBridge();
await vectorBridge.init();

// Search (returns Promise, handles requestId internally)
const results = await vectorBridge.search(embedding, 50);

// Add items (batched, non-blocking)
await vectorBridge.addItems(newChunks);
```

**Key constraints:**
- Main thread NEVER imports `hnswlib-wasm`
- All embeddings transferred via Transferable (zero-copy)
- Worker persists index to IndexedDB (not main thread file I/O)

**Estimated effort**: 8 hours

---

### D3: Event Wiring Completion (Priority: HIGH)

Absorbs Phase 0 Issues 3, 6, 7, 8:

| Issue | Fix |
|-------|-----|
| Reranker JSON parsing | Strip `<think>` tags, non-greedy regex, validation |
| action:proposed event | Emit from ChiefOfStaff (not TaskQueue) after agent returns |
| Action applier wiring | Wire `action:apply-requested` → ActionApplier in main.ts |
| Capability cards | Wire HealthMonitor → AgentStreamsView props |

**Event flow (corrected):**

```
Agent.execute() returns AgentOutput
        ↓
TaskQueue receives result, updates task status
        ↓
ChiefOfStaff.handleTaskComplete() processes result
        ↓
ChiefOfStaff emits events:
  - "agent:task-update" (status change)
  - "action:proposed" (if actions exist)
  - "insight:generated" (if insights exist)
        ↓
UI signals update via useAppEvents subscriptions
```

**Key change**: ChiefOfStaff is the ONLY emitter of user-facing events. TaskQueue is internal.

**Estimated effort**: 6 hours

---

### D4: Orchestration Simplification (Priority: MEDIUM)

**Remove:**
- `src/core/intelligence/actionOrchestrator.ts` — Merge into ChiefOfStaff
- `src/core/intelligence/actionPipeline.ts` — Inline into agents or ChiefOfStaff
- `src/core/agentic/workflowRunner.ts` — Merge into TaskQueue

**Refactor:**
- `ChiefOfStaff` — Add proactive task firing, consolidate event emission
- `TaskQueue` — Rename to `TaskManager`, support multiple named queues

**TaskManager API:**

```typescript
class TaskManager {
  private queues: Map<string, TaskQueue>;

  constructor() {
    this.queues = new Map([
      ['interactive', new TaskQueue({ concurrency: 1 })],
      ['background', new TaskQueue({ concurrency: 3 })],
    ]);
  }

  enqueue(task: Task, queue: 'interactive' | 'background' = 'interactive'): string {
    return this.queues.get(queue)!.enqueue(task);
  }

  // Future: addQueue('nightly', { schedule: '0 3 * * *' })
}
```

**Estimated effort**: 6 hours

---

### D5: Absorb Remaining Phase 0 Issues (Priority: MEDIUM)

| Issue | Action |
|-------|--------|
| Sequential embeddings | Parallelize in indexer (8 concurrent) |
| Action ID mismatch | Already fixed via ID system |
| Dead ChatAgent | Delete file |
| FS.syncfs race | Solved by Worker isolation |

**Estimated effort**: 4 hours

---

## Execution Order

```
Week 1:
├── D1: SQLite Data Layer (8h)
│   ├── Day 1-2: Schema + sql.js wrapper
│   └── Day 3: Migration from JSON
│
├── D2: HNSW Worker (8h)
│   ├── Day 3-4: Worker implementation
│   └── Day 5: Bridge + integration
│
Week 2:
├── D3: Event Wiring (6h)
│   └── Day 1-2: All event fixes
│
├── D4: Orchestration (6h)
│   └── Day 2-3: Consolidation
│
└── D5: Cleanup (4h)
    └── Day 4: Remaining issues, testing
```

**Total estimated**: 32 hours (~2 weeks at 4h/day)

---

## Validation Criteria

### Startup Performance

- [ ] Plugin loads, UI shell visible in **<1 second**
- [ ] Note selection triggers context load (vitals, actions) in **<500ms**
- [ ] Full vault indexed in background without UI jank

### Core Functionality

- [ ] Quick Actions produce results (actions appear in pending)
- [ ] Apply button applies actions (note modified, undo available)
- [ ] Search returns reranked results (no JSON parse failures)
- [ ] Chat works (streaming, thinking blocks, context)

### Architecture

- [ ] Main thread has NO `hnswlib-wasm` import
- [ ] All metadata queries go through SQLite
- [ ] ChiefOfStaff is single source of UI events
- [ ] No JSON files for core data (only settings)

### Stability

- [ ] No CPU spikes at idle (<5%)
- [ ] No memory leaks (stable over 1 hour)
- [ ] No console errors during normal operation

---

## What This Replaces

The following are **archived** (not deleted, moved to `.planning/_archive/`):

- `ROADMAP.md` (8-phase roadmap)
- `STATE.md` (Phase 0 tracking)
- `phases/00-foundation-repair/` (all files)
- `phases/01-agent-architecture/` (all files)

Phase Universe is the **only active phase** until validation passes.

---

## After Phase Universe

Once validation criteria are met:

1. **Assess**: What features are still needed? What changed?
2. **Design**: Fresh roadmap based on stable foundation
3. **Execute**: Feature phases with confidence in backend

The current Phase 2-8 concepts (Insights Stream, Agent Command Center, Chat Enhancement, etc.) may return in a new roadmap, but they will be re-evaluated against the new architecture.

---

## Open Questions

1. **FTS5 for full-text search?** — Defer to post-Universe. Vector search is primary.
2. **Multiple embedding models?** — Schema supports it. Implementation deferred.
3. **Cron/scheduled tasks?** — TaskManager supports future queues. Not in Phase Universe scope.

---

*Phase Universe: Build the foundation. Everything else follows.*
