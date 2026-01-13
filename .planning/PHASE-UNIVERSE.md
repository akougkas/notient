# Phase Universe: Foundation Refactor

**Status**: ACTIVE
**Created**: 2026-01-12
**Updated**: 2026-01-12 (Obsidian Integration Audit)
**Supersedes**: Phase 0-8 Roadmap (archived)

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
5. **Clear orchestration boundaries** — ChiefOfStaff reasons, TaskQueues execute, Agents are tools.

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
│ vector.worker │    │  (future)       │    │  (future)           │
│               │    │  db.worker      │    │  embed.worker       │
│ HNSW index    │    │  SQLite queries │    │  Ollama batching    │
│ search()      │    │                 │    │                     │
│ addItems()    │    │                 │    │                     │
└───────────────┘    └─────────────────┘    └─────────────────────┘
```

**Phase Universe scope**: `vector.worker` only. DB stays on main thread (sql.js is fast enough).

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

**Key change**: ChiefOfStaff is the ONLY emitter of user-facing events. TaskQueue is internal.

**Estimated effort**: 6 hours

---

### D4: Orchestration Simplification (Priority: MEDIUM)

**Remove:**
- `src/core/intelligence/actionOrchestrator.ts` — Merge into ChiefOfStaff
- `src/core/intelligence/actionPipeline.ts` — Inline into agents or ChiefOfStaff
- `src/core/agentic/workflowRunner.ts` — Merge into TaskQueue

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

### INTEGRATION LAYER (D6-D9) — NEW

---

### D6: Frontmatter Intelligence Bridge (Priority: HIGH)

**Goal**: Store AI-derived intelligence IN the note's frontmatter, making it portable and visible.

**Files to modify:**
- `src/core/intelligence/noteIntelligence.ts` — Add frontmatter sync
- `src/adapters/obsidianFacade.ts` — Already has `processFrontMatter()`

**Frontmatter Schema:**

```yaml
---
notient-health: 78
notient-summary: "One-line AI summary of the note's content"
notient-entities:
  - type: person
    name: "John Smith"
  - type: concept
    name: "Machine Learning"
notient-updated: 2026-01-12T10:30:00Z
---
```

**Implementation:**

```typescript
// After agent generates intelligence, sync to frontmatter
async syncToFrontmatter(notePath: string, intelligence: IntelligenceRecord): Promise<void> {
  await this.obsidian.processFrontMatter(notePath, (fm) => {
    fm['notient-health'] = intelligence.health?.overall ?? null;
    fm['notient-summary'] = intelligence.summary ?? null;
    fm['notient-entities'] = intelligence.entities ?? [];
    fm['notient-updated'] = new Date().toISOString();
  });
}
```

**Benefits:**
- Intelligence is PORTABLE (survives note moves, Obsidian sync)
- Visible in Obsidian search (`notient-health:>50`)
- Compatible with Dataview queries
- User can see/edit AI conclusions

**Estimated effort**: 4 hours

---

### D7: Vitals from MetadataCache (Priority: HIGH)

**Goal**: Stop recalculating what Obsidian already knows. Use `metadataCache` as source of truth.

**Current problem** (from audit):
```typescript
// SimpleVaultVitals.ts - REDUNDANT
for (const file of files) {
  const metadata = this.kernel.obsidian.getMetadataByPath(file.path);
  const links = metadata?.links ?? [];  // Re-iterating what metadataCache has
  totalLinks += links.length;
}
```

**Correction:**
```typescript
// Use Obsidian's pre-computed graph directly
const resolvedLinks = this.app.metadataCache.resolvedLinks;

// Backlinks for a note (O(1) lookup, not O(n) iteration)
getBacklinks(path: string): string[] {
  const backlinks: string[] = [];
  for (const [source, targets] of Object.entries(resolvedLinks)) {
    if (targets[path]) backlinks.push(source);
  }
  return backlinks;
}
```

**Files to modify:**
- `src/core/vitals/simpleVitals.ts` — Use metadataCache directly
- `src/services/noteVitalsCalculator.ts` — Already uses it, optimize iterations

**Estimated effort**: 3 hours

---

### D8: Editor Decorations (Priority: MEDIUM)

**Goal**: Show AI insights INSIDE the editor, not just the sidebar.

**Reference**: `docs/obsidian/OBSIDIAN-EDITOR.md`

**Implementation approach:**

```typescript
// Create a CodeMirror 6 StateField for Notient decorations
import { StateField, Decoration, DecorationSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const notientDecorations = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decorations, transaction) {
    // Update based on intelligence changes
  },
  provide: f => EditorView.decorations.from(f)
});
```

**Decoration types:**
1. **Stale indicator** — Underline sections that haven't been updated in 30+ days
2. **Entity highlight** — Subtle background on detected entities (people, concepts)
3. **Health badge** — Small icon in gutter showing note health score

**Files to create:**
- `src/ui/editor/notientDecorations.ts` — StateField + decorations
- `src/ui/editor/index.ts` — Registration with Obsidian

**Estimated effort**: 8 hours

---

### D9: Context Menu Integration (Priority: MEDIUM)

**Goal**: AI actions available via right-click, not just sidebar buttons.

**Reference**: `docs/obsidian/OBSIDIAN-UI.md` (Context menus section)

**Implementation:**

```typescript
// In main.ts onload()
this.registerEvent(
  this.app.workspace.on("editor-menu", (menu, editor, view) => {
    const selection = editor.getSelection();

    if (selection) {
      menu.addItem((item) => {
        item
          .setTitle("Notient: Find related notes")
          .setIcon("search")
          .onClick(() => this.kernel.eventBus.emit("action:find-related", { text: selection }));
      });

      menu.addItem((item) => {
        item
          .setTitle("Notient: Enhance this section")
          .setIcon("sparkles")
          .onClick(() => this.kernel.eventBus.emit("action:enhance", { text: selection }));
      });
    }
  })
);

this.registerEvent(
  this.app.workspace.on("file-menu", (menu, file) => {
    menu.addItem((item) => {
      item
        .setTitle("Notient: Analyze note")
        .setIcon("brain")
        .onClick(() => this.kernel.eventBus.emit("action:analyze", { path: file.path }));
    });
  })
);
```

**Files to modify:**
- `src/main.ts` — Add context menu registration

**Estimated effort**: 3 hours

---

## Execution Order

```
Week 1: Infrastructure
├── D1: SQLite Data Layer (8h) ✅ COMPLETE
├── D2: HNSW Worker (8h)
│   ├── Day 1-2: Worker implementation
│   └── Day 3: Bridge + integration
│
Week 2: Infrastructure + Integration Start
├── D3: Event Wiring (6h)
│   └── Day 1-2: All event fixes
├── D6: Frontmatter Bridge (4h)
│   └── Day 2: Sync intelligence to frontmatter
├── D7: Vitals from MetadataCache (3h)
│   └── Day 3: Refactor vitals to use Obsidian cache
│
Week 3: Orchestration + Integration
├── D4: Orchestration (6h)
│   └── Day 1-2: Consolidation
├── D5: Cleanup (4h)
│   └── Day 3: Remaining issues
├── D9: Context Menus (3h)
│   └── Day 3: Right-click integration
│
Week 4: Editor Integration
└── D8: Editor Decorations (8h)
    └── Day 1-4: CodeMirror 6 StateField + decorations
```

**Total estimated**: 50 hours (~3 weeks at 4h/day)

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

### Integration (NEW)

- [ ] `notient-health` appears in frontmatter after analysis
- [ ] `notient-summary` syncs when intelligence regenerates
- [ ] Right-click on selection shows "Notient: Find related"
- [ ] Right-click on file shows "Notient: Analyze note"
- [ ] Vitals use `metadataCache.resolvedLinks` (no redundant iteration)

### Stability

- [ ] No CPU spikes at idle (<5%)
- [ ] No memory leaks (stable over 1 hour)
- [ ] No console errors during normal operation

---

## Open Questions

1. **FTS5 for full-text search?** — Defer to post-Universe. Vector search is primary.
2. **Multiple embedding models?** — Schema supports it. Implementation deferred.
3. **Cron/scheduled tasks?** — TaskManager supports future queues. Not in Phase Universe scope.
4. **Editor Decorations performance?** — May need throttling on large notes. Test with 10K+ line notes.
5. **Frontmatter bloat?** — Keep `notient-*` fields minimal. Summary max 200 chars.

---

## Ocean Code Audit (Reference)

These areas were identified as "replicated rather than integrated":

| Area | Current | Correction | Deliverable |
|------|---------|------------|-------------|
| Intelligence storage | Custom JSON in `.notient/` | Frontmatter + SQLite | D6 |
| Vitals calculation | Re-iterate all files | Use `metadataCache` | D7 |
| UI display | Sidebar-only | Editor decorations | D8 |
| User actions | Sidebar buttons | Context menus | D9 |

---

*Phase Universe: Build the foundation, integrate with Obsidian. The Note is the Unit.*
