# Phase Galaxy: MVP Nucleus (FINAL)

**Status**: READY FOR IMPLEMENTATION
**Created**: 2026-01-15 (Session 9)
**Updated**: 2026-01-15 (18 Interview Rounds Complete)
**Position**: Pre-Helios, Pre-Gaia
**Version**: 0.1.0 (Fresh Start)
**Approach**: TOTAL ANNIHILATION — Complete reimplementation

---

## Executive Summary

Phase Galaxy is a **complete reimplementation** of Notient's core pipeline:
- **ONE workflow**: Enhance (human-driven, suggestions-only)
- **FOUR agents**: Planner → ContextBuilder → Analyst → Writer
- **NO preservation**: All existing code paths deleted, rebuilt from scratch
- **SUSPENDED**: Chat Service, Chat UI, proactive enhancements

This is NOT a refactor. This is a fresh build. Version 0.1.0.

---

## Core Philosophy

### Notes Are Living Entities

> Notes have LIFE. They EVOLVE through enhancement cycles.
> A simple idea can become a massive project document.
> Notes have MATURITY, VITALITY, and ORIGIN.

**NOT generic categories** (meeting, daily, research). Instead:
- **Maturity**: Raw capture → Adolescent → Mature → Synthesis-ready
- **Vitality**: Health score, connectivity, structure, freshness
- **I-PARA**: Inbox → Projects/Areas/Resources/Archives
- **Origin**: User-written, web-clipped, AI-generated

### Human-Driven Pipeline

MVP is **entirely human-driven**:
1. User clicks Enhance
2. Pipeline runs (may take seconds to minutes)
3. Suggestions returned as checklist
4. User selects which to apply
5. User clicks Apply
6. Changes made, undo available

**NO automatic application. NO trust levels (yet).** Trust levels are for future proactive mode.

---

## Interview Decisions (18 Rounds, 72 Questions)

### Pipeline Architecture

| Decision | Choice |
|----------|--------|
| Pipeline Steps | 4-step: Planner → ContextBuilder → Analyst → Writer |
| Agent Names | Planner, ContextBuilder, Analyst, Writer (no "Worker" confusion) |
| Agent Interface | Hybrid (functional core, class wrapper for lifecycle) |
| Communication | Direct calls for pipeline, events for UI updates |
| Error Handling | Abort entire pipeline on any failure |

### Enhance Behavior

| Decision | Choice |
|----------|--------|
| Entry Points | Single handler, 3 surfaces (button, context menu, command palette) |
| Output | Suggestions only (checklist, user selects) |
| Suggestion Types | Metadata + Structure (frontmatter, links, sections, NO text rewriting) |
| Deletions | Full editing (add/modify/delete, user reviews all) |
| Apply Flow | Immediate (click → modify → undo in Activity tab) |
| Cancel | Hard abort (kill immediately, discard partial) |
| Pause | NOT SUPPORTED (removed, only cancel) |
| No Suggestions | Show "Note already well-structured" message |

### Note Intelligence

| Decision | Choice |
|----------|--------|
| Type Detection | Heuristics (folder, tags, frontmatter) |
| Maturity Impact | Adaptive (young→structure, adolescent→connections, mature→synthesis) |
| PARA Moves | Suggest only (user decides on folder moves) |
| Origin Awareness | Flag in LLM context (LLM adapts suggestions) |
| Vitals Usage | Pass to LLM as context (LLM prioritizes based on vitals) |
| Ambiguous Type | Best guess (proceed with highest confidence) |
| Type Override | No override (system decides) |

### Context Building

| Decision | Choice |
|----------|--------|
| Context Strategy | Start minimal (Layer 0-2), add layers iteratively, test quality |
| Context Layers | 0: Content → 1: Frontmatter → 2: Obsidian metadata → 3: Notient DB → 4: Linked notes → 5: Top-K similar → 6: Vault context → 7: User prefs → 8: Temporal |
| Top-K Search | 10 results for context building |
| Testing Method | Claude as judge comparing outputs per layer |

### LLM Integration

| Decision | Choice |
|----------|--------|
| Response Format | Flexible JSON (required + optional fields) |
| Parse Errors | Fallback parsing (JSON → YAML → regex) |
| Streaming | Wait for complete (buffer, parse at end) |
| Timeout | Ask user ("LLM slow. Wait or cancel?") |
| Agent Identity | No identity (pure task prompt) |
| PARA Knowledge | Assume known (no explanation in prompt) |
| Few-Shot | No examples (zero-shot) |
| Multi-Provider | Separate providers (reasoning ≠ reranking ≠ embedding) |

### Data Persistence

| Decision | Choice |
|----------|--------|
| SQLite Tables | 5 tables (notes, chunks, embeddings, actions, intelligence) |
| Undo History | SQLite (last 50 actions, survives crash) |
| Cache Expiry | On note change (hash invalidation) |
| Portable Data | Frontmatter only (notient-health, notient-summary) |

### Indexing

| Decision | Choice |
|----------|--------|
| Chunking | Hierarchical semantic (preserve existing implementation) |
| Note Size | Soft limit (warn >50KB, index anyway) |
| Index Refresh | File watcher for active note (Obsidian API) |
| Index Timing | After wizard (background start) |
| Embeddings | Web Worker (non-blocking) |

### UI

| Decision | Choice |
|----------|--------|
| Sidebar Layout | Tabbed: [Vitals] [Suggestions] [Activity] |
| Suggestion Detail | Expandable (click for preview + reasoning) |
| Apply Confirm | No confirm (immediate, undo available) |
| Status Footer | Clickable (opens system health modal) |
| Keyboard Shortcuts | None (avoid conflicts) |
| Sidebar Resize | Obsidian default |

### Settings

| Decision | Choice |
|----------|--------|
| Scope | Full config for all active components |
| Wizard | Full guided setup (providers, test, index options, first note) |
| Commands | Just "Notient: Enhance note" (one command) |

### System Behavior

| Decision | Choice |
|----------|--------|
| Startup | Load SQLite only, HNSW lazy on first search |
| Offline Mode | Graceful degradation (vitals work, Enhance disabled) |
| DB Corruption | Attempt repair, then delete/recreate |
| Concurrent Edit | Detect hash change before apply, abort if changed |
| Production Logs | Errors only |
| Dev Mode | Full debug (toggle in settings) |
| Test Strategy | Full suite (unit + integration + E2E) |

### Obsidian Integration

| Decision | Choice |
|----------|--------|
| Write Method | processFrontMatter for frontmatter, Vault API for content |
| Metadata Cache | Full integration (read + refresh after writes) |

---

## Architecture

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
│  • Receives enhance request                                             │
│  • Analyzes note maturity, origin, vitals                               │
│  • Decides enhancement strategy                                         │
│  • Coordinates pipeline flow                                            │
│  • On error: Abort entire pipeline                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        2. CONTEXT BUILDER                               │
│                                                                         │
│  ITERATIVE LAYERS (start minimal, add based on testing):                │
│                                                                         │
│  Layer 0: Note content only                                             │
│  Layer 1: + Frontmatter metadata                                        │
│  Layer 2: + Obsidian metadata (links, tags from cache)                  │
│  Layer 3: + Notient metadata (prior intelligence from DB)               │
│  Layer 4: + Linked notes (backlinks + outlinks)                         │
│  Layer 5: + Top-10 similar notes (vector search)                        │
│  Layer 6: + Vault context (folder structure, I-PARA)                    │
│  Layer 7: + User preferences                                            │
│  Layer 8: + Temporal context (recent activity)                          │
│                                                                         │
│  MVP: Layers 0-2. Add layers via Claude-judged testing.                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           3. ANALYST                                    │
│                                                                         │
│  • Receives context from ContextBuilder                                 │
│  • Constructs lean prompt (no persona, zero-shot)                       │
│  • Calls LLM (local, via configured provider)                           │
│  • Buffers complete response, then parses                               │
│  • Handles parse errors via fallback (JSON → YAML → regex)              │
│  • Returns structured EnhancementSuggestion[]                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            4. WRITER                                    │
│                                                                         │
│  • Receives user-selected suggestions                                   │
│  • Checks note hash (abort if changed during enhance)                   │
│  • Applies via processFrontMatter / vault.modify()                      │
│  • Records action in SQLite (for undo)                                  │
│  • Triggers metadataCache refresh                                       │
│  • Emits action:applied event                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event System

```typescript
// Pipeline events
"enhance:start": { noteId: string; timestamp: number }
"enhance:progress": { noteId: string; percent: number; stage: string }
"enhance:complete": { noteId: string; suggestionCount: number }
"enhance:error": { noteId: string; error: string }

// Insight events
"insight:created": { suggestion: EnhancementSuggestion }
"insight:dismissed": { suggestionId: string }

// Action events
"action:applied": { actionId: string; noteId: string }
"action:undone": { actionId: string }

// Index events
"index:start": { noteCount: number }
"index:progress": { completed: number; total: number }
"index:complete": { noteCount: number; duration: number }
"index:error": { error: string }
```

---

## SQLite Schema

```sql
-- Table 1: Notes metadata
CREATE TABLE notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  hash TEXT,
  indexed_at INTEGER,
  last_enhanced INTEGER
);

-- Table 2: Chunks (hierarchical semantic)
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT REFERENCES notes(path) ON DELETE CASCADE,
  content TEXT,
  chunk_type TEXT,  -- 'full' | 'section' | 'paragraph'
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT
);

-- Table 3: Embeddings
CREATE TABLE embeddings (
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT,
  vector BLOB,
  created_at INTEGER,
  PRIMARY KEY (chunk_id, model)
);

-- Table 4: Actions (undo - last 50)
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  note_path TEXT,
  action_type TEXT,
  before_state TEXT,
  after_state TEXT,
  applied_at INTEGER,
  undone INTEGER DEFAULT 0
);

CREATE TRIGGER prune_actions AFTER INSERT ON actions
BEGIN
  DELETE FROM actions WHERE id NOT IN (
    SELECT id FROM actions ORDER BY applied_at DESC LIMIT 50
  );
END;

-- Table 5: Intelligence cache
CREATE TABLE intelligence (
  note_path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
  analysis TEXT,
  suggestions TEXT,
  health_score INTEGER,
  summary TEXT,
  version INTEGER,
  analyzed_at INTEGER
);
```

---

## UI Layout

### Sidebar (Tabbed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NOTIENT                                                          [⚙️]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [Vitals]  [Suggestions]  [Activity]                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  TAB CONTENT (see below)                                                │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ● Ready  │  1,234 notes  │  v0.1.0              [clickable → modal]   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Vitals Tab

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NOTE VITALS                                           [my-note.md]     │
│                                                                         │
│  Health: ████████░░ 78%                                                 │
│  Links:  5 in / 12 out                                                  │
│  Age:    Modified 3 days ago                                            │
│  Maturity: Adolescent                                                   │
│  I-PARA: Projects/Alpha                                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    [✨ ENHANCE]                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Last enhanced: Never                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Suggestions Tab (Checklist)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SUGGESTIONS                                              [3 pending]   │
│                                                                         │
│  ☐ Add tags: #meeting, #project-alpha                         [▼]      │
│    └─ Frontmatter change                                               │
│                                                                         │
│  ☐ Add section: "Action Items"                                [▼]      │
│    └─ Structure change (expandable preview)                            │
│                                                                         │
│  ☐ Link to: [[Project Alpha Overview]]                        [▼]      │
│    └─ Outlink suggestion                                               │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  [Apply Selected (0)]  [Select All]  [Dismiss All]                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Activity Tab

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENT ACTIVITY                                                         │
│                                                                         │
│  ▶ RUNNING: Enhance "my-note.md"                                       │
│    Stage: Analyst (analyzing content)                                  │
│    Progress: ████████░░ 75%                                            │
│    [✕ Cancel]                                                          │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  RECENT:                                                               │
│  ✓ Enhance "meeting-notes.md" (2 min ago)                              │
│  ✓ Enhance "project-plan.md" (5 min ago)                               │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────     │
│  UNDO HISTORY:                                                         │
│  ↩ Added tags to "my-note.md" (1 min ago)  [Undo]                      │
│  ↩ Added section to "meeting.md" (3 min ago)  [Undo]                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
├── main.ts                       # Plugin entry (simplified)
├── core/
│   ├── kernel.ts                 # Service registry
│   ├── events.ts                 # EventBus + types
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
│   │   ├── pipeline.ts           # Pipeline orchestration
│   │   ├── suggestions.ts        # Suggestion types
│   │   └── prompts.ts            # Lean prompts
│   ├── search/
│   │   ├── vectorStore.ts        # HNSW wrapper
│   │   └── indexer.ts            # Hierarchical semantic indexer
│   └── vitals/
│       └── calculator.ts         # Maturity, health, vitals
├── workers/
│   └── embed.worker.ts           # Embedding Web Worker
├── ui/
│   ├── sidebar/
│   │   ├── Sidebar.tsx           # Main container
│   │   ├── tabs/
│   │   │   ├── VitalsTab.tsx
│   │   │   ├── SuggestionsTab.tsx
│   │   │   └── ActivityTab.tsx
│   │   └── components/
│   │       ├── ProgressBar.tsx
│   │       ├── Checkbox.tsx
│   │       ├── Button.tsx
│   │       └── HealthModal.tsx
│   └── settings/
│       ├── SettingsTab.ts
│       └── SetupWizard.ts
├── adapters/
│   └── obsidian.ts               # Obsidian API wrapper
└── types/
    └── index.ts                  # Shared types
```

---

## Initialization Flows

### First Run (New Vault)

```
1. Plugin loads
2. No SQLite → Create fresh database
3. Show Setup Wizard:
   - Step 1: Configure reasoning provider + test
   - Step 2: Configure embedding provider + test
   - Step 3: Index options (excluded folders)
   - Step 4: Optional: Test enhance on a note
4. Wizard completes → Start background indexing
5. Show sidebar with "Indexing..." status
6. Indexing completes → "Ready" status
```

### Returning User

```
1. Plugin loads
2. Load SQLite into memory
3. Validate schema version
4. Mount sidebar immediately
5. Background: Check file hashes for changes
6. Re-index changed notes silently
7. [LAZY] HNSW loaded on first search
```

### Offline Mode

```
1. Plugin loads
2. LLM connection test fails
3. Show "Offline" status in footer
4. Vitals, history, undo: WORK
5. Enhance button: DISABLED with message
6. When connection restored: Re-enable
```

---

## Development Approach

### Claude-Judged Testing

For each context layer (0-8):
1. Run Enhance with Layer N
2. Run Enhance with Layer N+1
3. Claude compares suggestion quality
4. Measure: Better suggestions? Processing time?
5. Decide: Include layer in MVP?

### User Feedback Loop

1. Each suggestion has thumbs up/down (dev mode)
2. Feedback stored in SQLite
3. Analyze: Which layers produce better ratings?
4. Iterate prompts based on feedback

### Test Suite

- Unit tests: Agents, parsing, vitals calculation
- Integration tests: Pipeline end-to-end
- E2E tests: Plugin in Obsidian

---

## Implementation Phases

### Phase G1: Foundation (Days 1-2)

- [ ] Fresh project structure
- [ ] SQLite with 5-table schema
- [ ] EventBus with typed events
- [ ] Kernel service registry

### Phase G2: Agents (Days 3-4)

- [ ] Planner agent
- [ ] ContextBuilder (Layers 0-2)
- [ ] Analyst agent (lean prompts)
- [ ] Writer agent (processFrontMatter)

### Phase G3: Pipeline (Day 5)

- [ ] Pipeline orchestration
- [ ] Error handling (abort all)
- [ ] Cancel support
- [ ] Timeout handling (ask user)

### Phase G4: UI (Days 6-7)

- [ ] Tabbed sidebar
- [ ] Vitals tab
- [ ] Suggestions tab (checklist)
- [ ] Activity tab (undo)

### Phase G5: Indexing (Day 8)

- [ ] Hierarchical semantic chunker (from existing)
- [ ] Embedding Web Worker
- [ ] HNSW integration
- [ ] File watcher

### Phase G6: Settings & Polish (Days 9-10)

- [ ] Settings panel
- [ ] Setup wizard
- [ ] Dev mode toggle
- [ ] Status footer modal

---

## Success Criteria

### Must Work

- [ ] Plugin loads < 1 second
- [ ] Enhance button triggers full pipeline
- [ ] Suggestions appear as checklist
- [ ] Apply modifies note correctly
- [ ] Undo reverses changes
- [ ] Cancel aborts pipeline cleanly
- [ ] Offline mode degrades gracefully
- [ ] Index builds in background

### Quality Gates

- [ ] Zero console errors in production
- [ ] Unit test coverage > 80%
- [ ] E2E tests pass
- [ ] Claude judges Layer 0-2 suggestions as useful

---

## What This Unlocks

**After Phase Galaxy:**
- Phase Helios: Harden pipeline, stress test
- Phase Gaia: UI/UX polish
- Future: Proactive enhancements, trust levels, more workflows

---

*Phase Galaxy v3 FINAL: 18 interview rounds, 72 questions, complete specification.*
*Ready for implementation.*
