# Phase Galaxy: MVP Nucleus (v2)

**Status**: PLANNING (Interview In Progress)
**Created**: 2026-01-15 (Session 9)
**Updated**: 2026-01-15 (Post-Review Revision)
**Position**: Pre-Helios, Pre-Gaia
**Approach**: TOTAL ANNIHILATION — Fresh implementation, no preservation

---

## Executive Summary

Phase Galaxy is a **complete reimplementation** of Notient's core pipeline:
- **ONE workflow**: Enhance (human-driven, suggestions-only)
- **FOUR agents**: Planner → ContextBuilder → Analyst → Writer
- **NO preservation**: All existing code paths deleted, rebuilt from scratch
- **SUSPENDED**: Chat Service, Chat UI, proactive enhancements

This is NOT a refactor. This is a fresh build using git history for reference only.

---

## Core Decisions (From Interview)

### What We're Building

| Component | Decision | Rationale |
|-----------|----------|-----------|
| **Pipeline** | 4-step linear | Planner → ContextBuilder → Analyst → Writer. Sequential, debuggable. |
| **Entry Point** | Single handler, 3 surfaces | Button + context menu + command palette → same handler |
| **Output** | Suggestions only | Checklist UI, user selects which to apply |
| **Context** | Iterative layers | Start minimal, add context layers, test LLM quality at each step |
| **Trust Levels** | NOT in MVP | MVP is human-driven. Trust levels for future proactive mode |
| **Undo** | SQLite persisted | Last 50 actions survive crash. Safety net. |
| **Apply** | Immediate | Click → modify → undo in Activity tab |

### What We're NOT Building (MVP)

- Chat interface
- Proactive/background enhancements
- Bulk workflows
- Multiple quick actions (only Enhance)
- Trust-level gates (human reviews everything)

---

## Fresh Architecture

### The Four Agents

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER CLICKS ENHANCE                            │
│           (Button OR Context Menu OR Command Palette)                   │
│                    → Same handler, different surfaces                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           1. PLANNER                                    │
│  (Orchestrator - decides what to do)                                    │
│                                                                         │
│  • Receives enhance request                                             │
│  • Analyzes note type, content state                                    │
│  • Decides enhancement strategy                                         │
│  • Calls ContextBuilder                                                 │
│  • Coordinates pipeline flow                                            │
│                                                                         │
│  Communication: Direct function calls to agents                         │
│  On error: Abort entire pipeline                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        2. CONTEXT BUILDER                               │
│  (Separate agent - gathers context)                                     │
│                                                                         │
│  ITERATIVE CONTEXT LAYERS (test each for LLM quality):                  │
│                                                                         │
│  Layer 0: Note content only (baseline)                                  │
│  Layer 1: + Frontmatter metadata                                        │
│  Layer 2: + Obsidian metadata (links, tags from cache)                  │
│  Layer 3: + Notient metadata (prior intelligence from DB)              │
│  Layer 4: + Linked notes (backlinks + outlinks)                         │
│  Layer 5: + Top-K similar notes (vector search + rerank)                │
│  Layer 6: + Vault context (folder structure, project relationship)      │
│  Layer 7: + User preferences                                            │
│  Layer 8: + Temporal context (recent activity)                          │
│                                                                         │
│  MVP starts at Layer 0-2, adds layers based on testing                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           3. ANALYST                                    │
│  (Workflow executor - runs LLM reasoning)                               │
│                                                                         │
│  • Receives context from ContextBuilder                                 │
│  • Constructs prompt based on note type                                 │
│  • Calls LLM (local, via configured provider)                           │
│  • Parses response into structured suggestions                          │
│  • Streams suggestions to UI as generated                               │
│                                                                         │
│  Output: Array of EnhancementSuggestion objects                         │
│  Streaming: Progressive reveal to UI                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            4. WRITER                                    │
│  (Note editor - applies changes)                                        │
│                                                                         │
│  • Receives user-selected suggestions                                   │
│  • Applies changes to note via Obsidian API                             │
│  • Records action in SQLite (for undo)                                  │
│  • Emits action:applied event                                           │
│                                                                         │
│  Apply: Immediate on user selection                                     │
│  Undo: Available in Activity tab                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         UI UPDATES (Events)                             │
│                                                                         │
│  enhance:start     → Activity tab shows "Running"                       │
│  enhance:progress  → Progress indicator updates                         │
│  insight:created   → Suggestions tab populates (streaming)              │
│  enhance:complete  → Activity tab shows "Done"                          │
│  enhance:error     → Activity tab shows error, pipeline aborted         │
│  action:applied    → Suggestion checked off, note modified              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Communication Pattern

```
PIPELINE (Direct Calls)          UI UPDATES (Events)
─────────────────────            ──────────────────
Planner.plan()                   EventBus.emit("enhance:start")
  └→ ContextBuilder.build()      EventBus.emit("enhance:progress", 25%)
       └→ Analyst.analyze()      EventBus.emit("insight:created", suggestion)
            └→ Writer.apply()    EventBus.emit("action:applied")
                                 EventBus.emit("enhance:complete")
```

**Rule**: Direct calls for pipeline flow. Events for UI updates only.

---

## Data Architecture

### SQLite Schema (Fresh - 5 Tables)

```sql
-- Table 1: Notes metadata
CREATE TABLE notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  hash TEXT,              -- Content hash for change detection
  indexed_at INTEGER,     -- Timestamp
  last_enhanced INTEGER   -- Timestamp of last enhance
);

-- Table 2: Chunks for vector search
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT REFERENCES notes(path) ON DELETE CASCADE,
  content TEXT,
  chunk_type TEXT,        -- 'full' | 'section' | 'paragraph'
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT
);

-- Table 3: Embeddings (model-scoped)
CREATE TABLE embeddings (
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT,             -- e.g., 'nomic-embed-text'
  vector BLOB,            -- Float32Array as blob
  created_at INTEGER,
  PRIMARY KEY (chunk_id, model)
);

-- Table 4: Action history (undo - last 50)
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  note_path TEXT,
  action_type TEXT,       -- 'frontmatter_set' | 'content_replace' | etc.
  before_state TEXT,      -- JSON: state before action
  after_state TEXT,       -- JSON: state after action
  applied_at INTEGER,
  undone INTEGER DEFAULT 0
);

-- Trigger to keep only last 50 actions
CREATE TRIGGER prune_actions AFTER INSERT ON actions
BEGIN
  DELETE FROM actions WHERE id NOT IN (
    SELECT id FROM actions ORDER BY applied_at DESC LIMIT 50
  );
END;

-- Table 5: Intelligence cache (per-note analysis)
CREATE TABLE intelligence (
  note_path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
  analysis TEXT,          -- JSON: full LLM analysis output
  suggestions TEXT,       -- JSON: cached suggestions
  health_score INTEGER,
  summary TEXT,
  version INTEGER,        -- Schema version for re-analysis trigger
  analyzed_at INTEGER
);
```

### Storage Locations

```
VAULT ROOT/
├── notes/
│   └── my-note.md
│       └── frontmatter:           ← PORTABLE (syncs)
│           notient-health: 78
│           notient-summary: "..."
│
└── .obsidian/plugins/notient/     ← LOCAL ONLY (device-specific)
    ├── data.json                  # Obsidian plugin settings
    ├── notient.db                 # SQLite (5 tables)
    └── hnsw.bin                   # HNSW index binary
```

### Data Classification

| Data | Location | Syncs? | Persistence |
|------|----------|--------|-------------|
| Health/Summary | Frontmatter | ✅ Yes | Permanent |
| Full analysis | SQLite (intelligence) | ❌ No | Permanent |
| Embeddings | SQLite | ❌ No | Permanent |
| Undo history | SQLite (actions) | ❌ No | Last 50 |
| HNSW index | hnsw.bin | ❌ No | Permanent |

---

## Event System (Minimal)

### Required Events

```typescript
// Pipeline events
type EnhanceEvents = {
  "enhance:start": { noteId: string; timestamp: number };
  "enhance:progress": { noteId: string; percent: number; stage: string };
  "enhance:complete": { noteId: string; suggestionCount: number };
  "enhance:error": { noteId: string; error: string };
};

// Insight events
type InsightEvents = {
  "insight:created": { suggestion: EnhancementSuggestion };
  "insight:dismissed": { suggestionId: string };
};

// Action events
type ActionEvents = {
  "action:applied": { actionId: string; noteId: string };
  "action:undone": { actionId: string };
};

// Index events
type IndexEvents = {
  "index:start": { noteCount: number };
  "index:progress": { completed: number; total: number };
  "index:complete": { noteCount: number; duration: number };
  "index:error": { error: string };
};
```

### NOT Needed (Delete)

- All `chat:*` events
- All `agent:*` events (replaced by `enhance:*`)
- `action:proposed` (suggestions go to insight:created)
- `action:apply-requested` (direct call to Writer)

---

## UI Architecture

### Sidebar Layout (Tabbed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NOTIENT                                                          [⚙️]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [Vitals]  [Suggestions]  [Activity]                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      TAB CONTENT                                 │   │
│  │                                                                  │   │
│  │  (Content depends on selected tab - see below)                  │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ● Ready  │  1,234 notes  │  v0.5.0                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab: Vitals

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NOTE VITALS                                           [my-note.md]     │
│                                                                         │
│  Health: ████████░░ 78%                                                 │
│  Links:  5 in / 12 out                                                  │
│  Age:    Modified 3 days ago                                            │
│  Type:   Meeting notes                                                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    [✨ ENHANCE]                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Last enhanced: Never                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab: Suggestions (Checklist)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SUGGESTIONS                                              [3 pending]   │
│                                                                         │
│  ☐ Add tags: #meeting, #project-alpha                                  │
│    └─ Frontmatter change                                               │
│                                                                         │
│  ☐ Restructure: Add "Action Items" section                             │
│    └─ Content change (preview available)                               │
│                                                                         │
│  ☐ Link to: [[Project Alpha Overview]]                                 │
│    └─ Add outlink                                                      │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  [Apply Selected (0)]  [Select All]  [Dismiss All]                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab: Activity (Full Control)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENT ACTIVITY                                                         │
│                                                                         │
│  ▶ RUNNING: Enhance "my-note.md"                                       │
│    Stage: Analyst (analyzing content)                                  │
│    Progress: ████████░░ 75%                                            │
│    [⏸ Pause]  [✕ Cancel]                                               │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  RECENT:                                                               │
│  ✓ Enhance "meeting-notes.md" (2 min ago) - 3 suggestions              │
│  ✓ Enhance "project-plan.md" (5 min ago) - 5 suggestions               │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  UNDO HISTORY:                                                         │
│  ↩ Added tags to "my-note.md" (1 min ago)  [Undo]                      │
│  ↩ Restructured "meeting-notes.md" (3 min ago)  [Undo]                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Settings (Full Config for Active Components)

### Provider Settings

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LLM PROVIDERS                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Reasoning Model (for Enhance)                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Endpoint: [http://localhost:1234/v1                          ]  │   │
│  │ Model:    [llama-3.1-8b-instruct         ▼]                     │   │
│  │ [Test Connection]  ● Connected                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Embedding Model (for Search)                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Endpoint: [http://localhost:11434                            ]  │   │
│  │ Model:    [nomic-embed-text              ▼]                     │   │
│  │ [Test Connection]  ● Connected                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Index Settings

```
┌─────────────────────────────────────────────────────────────────────────┐
│  VAULT INDEX                                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Status: ● Indexed (1,234 notes)                                        │
│  Last indexed: 2026-01-15 10:30:00                                      │
│  Database size: 2.4 MB                                                  │
│                                                                         │
│  Excluded Folders:                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ .obsidian                                                        │   │
│  │ templates                                                        │   │
│  │ [+ Add folder]                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  [Rebuild Index]  [Clear Index]                                         │
│  ⚠️ Rebuild will re-embed all notes. May take several minutes.          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Danger Zone

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ⚠️ DANGER ZONE                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [Clear All Intelligence]                                               │
│  Removes all cached analysis. Notes will be re-analyzed on demand.      │
│                                                                         │
│  [Clear Undo History]                                                   │
│  Removes all undo history. Actions cannot be reversed.                  │
│                                                                         │
│  [Reset Plugin]                                                         │
│  Deletes all Notient data and resets to fresh install.                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Initialization

### Startup Sequence

```
1. Plugin loads
2. Load SQLite into memory (sync, fast)
3. Validate database schema (migrate if needed)
4. Register event handlers
5. Register commands (Enhance note)
6. Mount sidebar UI
7. [LAZY] HNSW index loaded on first search
8. [LAZY] Embedding worker spawned on first index operation
```

### First Run (New Vault)

```
1. Plugin loads
2. No SQLite found → Create fresh database
3. Show setup wizard:
   - Configure reasoning provider
   - Configure embedding provider
   - Test connections
4. Wizard completes → Show "Ready" in sidebar
5. No indexing until user triggers Enhance or search
```

### Returning User

```
1. Plugin loads
2. Load existing SQLite
3. Quick validation (schema version check)
4. Mount UI immediately (fast startup)
5. Background: Check for changed notes (hash comparison)
6. Offer to re-index changed notes (non-blocking)
```

---

## File Structure (Fresh)

### New Files to Create

```
src/
├── main.ts                       # Plugin entry (simplified)
├── core/
│   ├── kernel.ts                 # Service registry (simplified)
│   ├── events.ts                 # EventBus + event types
│   ├── db/
│   │   ├── database.ts           # SQLite wrapper
│   │   └── schema.ts             # 5-table schema
│   ├── agents/
│   │   ├── types.ts              # Agent interfaces
│   │   ├── planner.ts            # Planner agent
│   │   ├── contextBuilder.ts     # ContextBuilder agent
│   │   ├── analyst.ts            # Analyst agent
│   │   └── writer.ts             # Writer agent
│   ├── enhance/
│   │   ├── pipeline.ts           # Enhance pipeline orchestration
│   │   ├── suggestions.ts        # Suggestion types
│   │   └── prompts.ts            # Enhance prompts
│   ├── search/
│   │   ├── vectorStore.ts        # HNSW wrapper
│   │   └── indexer.ts            # Note indexing
│   └── vitals/
│       └── calculator.ts         # Note health calculation
├── workers/
│   └── embed.worker.ts           # Embedding Web Worker
├── ui/
│   ├── sidebar/
│   │   ├── Sidebar.tsx           # Main sidebar container
│   │   ├── tabs/
│   │   │   ├── VitalsTab.tsx     # Note vitals + Enhance button
│   │   │   ├── SuggestionsTab.tsx # Checklist UI
│   │   │   └── ActivityTab.tsx   # Agent activity + undo
│   │   └── components/
│   │       ├── ProgressBar.tsx
│   │       ├── Checkbox.tsx
│   │       └── Button.tsx
│   └── settings/
│       └── SettingsTab.ts        # Settings panel
├── adapters/
│   └── obsidian.ts               # Obsidian API wrapper
└── types/
    └── index.ts                  # Shared types
```

### Files to DELETE (Everything Else)

All existing files not in the above structure are deleted. Git has history.

---

## Open Areas (Need More Interview)

1. **What does "Enhance" mean for different note types?**
   - Meeting notes vs. research notes vs. daily notes
   - Different prompts? Different suggestions?

2. **Pause/Cancel semantics**
   - What happens to in-flight LLM calls on cancel?
   - Can a paused pipeline resume?

3. **Error recovery**
   - LLM timeout handling
   - Network failure during enhance
   - Corrupt database recovery

4. **Testing strategy**
   - How do we verify LLM quality improvements per context layer?
   - Manual testing? Automated?

5. **Context layer testing methodology**
   - How do we measure if adding a context layer improves suggestions?
   - A/B testing? User feedback?

---

*Phase Galaxy v2: Total annihilation, fresh implementation, no preservation.*
