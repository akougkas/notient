# Notient - Project Context

> AI-powered vault management for Obsidian using local LLMs only.

## Quick Reference

```bash
# Development
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:reset        # Soft reset (clear settings, keep index)
bun run dev:hard-reset   # Hard reset (wipe everything)

# Production
bun run build            # Typecheck + production build (minified)
bun run build:dev        # Development build (with sourcemaps)
bun run build:analyze    # Bundle analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

## ⚠️ Current State: Post-Audit Implementation

**Date:** 2026-01-09

A comprehensive 6-agent audit was conducted. The sidebar Preact migration is **incomplete** with critical bugs blocking functionality.

### Critical Bugs (Must Fix First)

| Bug | File | Line | Impact |
|-----|------|------|--------|
| Static `isReady` read | `src/ui/sidebar/App.tsx` | 91 | Sidebar stuck on "Initializing services..." |
| Service key mismatch | `src/core/intelligence/noteIntelligence.ts` | 503 | `findRelated()` always returns [] |
| Await on sync method | `src/core/agent/profileManager.ts` | 129 | Runtime type error |
| ChatHistory truncation | `src/ui/modals/TaskModal.ts` | 296 | Conversation history loss |

### Audit Summary

| Area | Critical | High | Medium | Total |
|------|----------|------|--------|-------|
| Sidebar & Preact | 2 | 2 | 3 | 7 |
| Kernel & Services | 2 | 3 | 2 | 7 |
| Settings & Index | 2 | 5 | 8 | 17 |
| Search & Omnibar | 2 | 2 | 5 | 13 |
| Intelligence & Actions | 3 | 4 | 8 | 18 |
| Chat & Agent | 3 | 4 | 7 | 17 |
| **TOTAL** | **14** | **20** | **33** | **79** |

**Full audit reports:** `.claude/audit/`

---

## Architecture Overview

### New UI Structure (Sidebar v2.0)

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (locked)                                                │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Notient                    [📝 Note] [🤖 Agents] [💬 Chat] │ │
│  └───────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  CONTENT (view-specific, locked layout per view)                │
│  • Note Vitals: Identity → Vitals → Quick Actions → Insights    │
│  • Agent Streams: Active → Pending Review → Recent Activity     │
│  • Chat: Context → Messages → Input                             │
├─────────────────────────────────────────────────────────────────┤
│  FOOTER (locked - 3 status zones)                               │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ [Providers]      │      [Index]       │     [Agents]      │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Spec:** `.claude/specs/sidebar-v2-architecture.md`

### Source Structure

```
src/
├── main.ts                    # Plugin entry point
├── adapters/
│   └── obsidianFacade.ts      # Obsidian API wrapper
├── core/                      # FROZEN - Core logic layer
│   ├── kernel.ts              # Service registry & orchestration
│   ├── constants.ts           # View types, defaults
│   ├── events/eventBus.ts     # Typed pub/sub
│   ├── llm/                   # LLM abstraction layer
│   ├── agent/                 # Notient agent module
│   ├── chat/                  # Chat module
│   ├── agentic/               # Autonomous operations
│   ├── context/               # RAG context building
│   ├── search/pipeline.ts     # LLM-reranked search
│   ├── indexer/               # Embedding indexer
│   ├── intelligence/          # Intelligence 2.0
│   ├── para/detector.ts       # PARA classification
│   └── vitals/simpleVitals.ts # Vault health metrics
├── services/                  # FROZEN - Service implementations
│   ├── simpleVectorStore.ts   # Brute-force cosine similarity
│   ├── indexManager.ts        # Coordinates vector + state
│   ├── lmstudio.ts            # LM Studio service
│   ├── ollama.ts              # Ollama embeddings
│   ├── healthMonitor.ts       # Service health tracking
│   ├── insightGenerator.ts    # Generate note insights
│   ├── noteVitalsCalculator.ts # Calculate note vitals
│   └── storagePaths.ts        # Data file paths
├── ui/                        # UI Layer (Active Development)
│   ├── sidebar/               # Preact sidebar (IN PROGRESS)
│   │   ├── SidebarView.tsx    # ItemView wrapper
│   │   ├── App.tsx            # Root Preact component
│   │   ├── context/
│   │   │   └── KernelContext.tsx
│   │   ├── hooks/
│   │   │   └── useNoteVitals.ts
│   │   └── components/
│   │       ├── NoteCard.tsx
│   │       ├── QuickActions.tsx
│   │       └── InsightStream.tsx
│   ├── dashboard/
│   │   └── DashboardView.ts   # Imperative (kept simple)
│   ├── modals/
│   │   ├── TaskModal.ts       # Chat modal
│   │   └── SetupWizard.ts     # First-run setup
│   ├── settings/
│   │   ├── SettingsTab.ts
│   │   └── panels/
│   │       └── IndexManagementPanel.ts
│   └── styles/                # CSS modules
│       ├── index.css
│       ├── tokens.css
│       ├── base.css
│       └── components/        # Per-component CSS
└── types/
    ├── settings.ts
    ├── events.ts
    ├── profile.ts
    └── vitals.ts
```

---

## Implementation Status

### ✅ Fully Complete (Core Layer - FROZEN)

- Kernel & service orchestration
- Agent loop + task queue + streaming
- Trust levels + action history (undo)
- LLM abstraction layer (providers)
- Search pipeline (3 modes: quick/balanced/thorough)
- Chat sessions + conversation store
- TieredSemanticChunker (3-tier: note/section/block)
- NoteIntelligenceService (summaries, entities, tags, health)
- WorkflowRunner (queue, progress, review queue, error tracking)
- Intelligence 2.0 ActionOrchestrator + ActionPipeline
- Setup wizard + settings

### 🔄 In Progress (UI Layer - Active Development)

**Sidebar v2.0 Preact Migration:**

| Component | Status | Notes |
|-----------|--------|-------|
| SidebarView.tsx | ⚠️ Broken | Services init event not subscribed |
| App.tsx | ⚠️ Broken | Static `isReady` read |
| KernelContext.tsx | ✅ Complete | Hooks defined |
| useNoteVitals.ts | ✅ Complete | Signals working |
| NoteCard.tsx | ✅ Complete | Renders note identity |
| QuickActions.tsx | ⚠️ Partial | Missing full action set |
| InsightStream.tsx | ⚠️ Partial | Missing agent events |
| Header.tsx | ❌ Missing | Need tabs |
| Footer.tsx | ❌ Missing | Need 3 status zones |
| AgentStreamsView.tsx | ❌ Missing | Entire view |
| ChatView.tsx | ❌ Missing | Entire view |

### ⏳ Blocked (Waiting on Sidebar)

- Dashboard redesign (deferred to external web app)
- Identity system Settings UI

---

## Implementation Phases

### Phase 1: Fix Critical Bugs ← CURRENT
1. Add `services:initialized` event subscription to `App.tsx`
2. Fix service key mismatch in `noteIntelligence.ts`
3. Fix async/await in `profileManager.ts`
4. Fix chatHistory truncation in `TaskModal.ts`

### Phase 2: Lock Header & Footer
1. Create `Header.tsx` with TabBar (3 tabs)
2. Create `Footer.tsx` with 3 status zones
3. Wire up event subscriptions for status updates

### Phase 3: Complete Note Vitals View
1. Restore `NoteIdentity` section
2. Create `VitalsCards` component (4 metrics)
3. Restore full `QuickActions` (6+ actions)
4. Enhance `InsightStream` with priorities

### Phase 4: Build Agent Streams View
1. Create `ActiveAgents` component
2. Create `PendingReview` component
3. Create `RecentActivity` component
4. Wire up workflow/action events

### Phase 5: Integrate Chat View
1. Create `ContextBar` component
2. Integrate existing Chat UI from TaskModal
3. Connect to ChatSession/ConversationStore

---

## Key Specs & Documents

| Document | Location | Purpose |
|----------|----------|---------|
| Sidebar v2.0 Architecture | `.claude/specs/sidebar-v2-architecture.md` | **NEW** - Three-view tabbed sidebar spec |
| Audit Master TODO | `.claude/audit/MASTER-TODO.md` | Prioritized fix list from 6-agent audit |
| Sidebar Audit | `.claude/audit/sidebar-preact-findings.md` | 7 issues in Preact migration |
| Kernel Audit | `.claude/audit/kernel-services-findings.md` | 7 issues in initialization |
| Settings Audit | `.claude/audit/settings-index-findings.md` | 17 issues in settings/index |
| Search Audit | `.claude/audit/search-omnibar-findings.md` | 13 issues in search |
| Intelligence Audit | `.claude/audit/intelligence-actions-findings.md` | 18 issues in actions |
| Chat Audit | `.claude/audit/chat-agent-findings.md` | 17 issues in chat/agent |
| Original Plan | `~/.claude/plans/shimmering-scribbling-canyon.md` | 4-phase Preact migration plan |

---

## Data Files

Stored in `.obsidian/plugins/notient/`:

```
data.json                      # Plugin settings
idx_*_{modelKey}_Xd.json       # Vector index (new format)
state-{modelKey}.json          # Index state per model
intelligence-{modelKey}.json   # Note intelligence data
conversations.json             # Chat history
action-history.json            # Applied actions for undo
profile.json                   # User profile (identity system)
cache/                         # Search result cache
locks/                         # Multi-window safety
```

---

## Key Flows

### 1. Fresh Install
Setup Wizard → Service connection → Model selection → Index creation → Search

### 2. Note Vitals View
Open note → useNoteVitals hook → Calculate metrics → Render NoteCard + Vitals + Actions + Insights

### 3. Agent Streams View
User clicks Agents tab → Show active agents → Show pending review → Show recent activity → Apply/Dismiss/Undo

### 4. Chat View
User clicks Chat tab → Context set to current note → Send message → Stream response → Apply actions

### 5. Footer Status Updates
EventBus subscriptions → Update provider status → Update index status → Update agent counts

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun
- **Build:** esbuild (see `scripts/build.ts`)
- **Lint:** Biome
- **UI Framework:** Preact + @preact/signals
- **LLM (Reasoning):** LM Studio (OpenAI-compatible)
- **LLM (Embeddings):** Ollama
- **Vector Store:** Custom brute-force cosine similarity (zero deps)

---

## Development Notes

### Sidebar Design Principles

1. **Locked Layout, Dynamic Content** - Structure never changes, only content
2. **No Layout Tricks** - No expanding/collapsing based on context
3. **Three Views** - Note Vitals | Agent Streams | Chat
4. **Sentient Note** - Note Vitals gives notes a living embodiment
5. **Footer Status Bar** - Always shows Providers | Index | Agents

### Event Subscriptions for Sidebar

```typescript
// Footer subscriptions
"services:initialized"     // Update isReady
"health:lmstudio"          // Update provider status
"health:ollama"            // Update provider status
"index:progress"           // Update index progress bar
"index:complete"           // Update note count

// Agent status subscriptions
"workflow:started"         // Increment running count
"workflow:progress"        // Update progress
"workflow:complete"        // Move to recent activity
"action:proposed"          // Add to pending review
"action:applied"           // Remove from pending
"action:undone"            // Update recent activity

// Note vitals subscriptions
"active-leaf-change"       // Load new note
"file:modified"            // Refresh if current note
"intelligence:updated"     // Update insights
```

### Core Principles

1. **Local-only** - No cloud APIs ever
2. **Human-in-steering-wheel** - Trust levels, universal undo
3. **Theme-aware** - Respects Obsidian themes
4. **Simplicity** - Clean abstractions, no debug cruft
5. **Sentient Note** - Notes have identity, vitals, and a living presence

---

## Build Health

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | PASS | `bun run typecheck` |
| ESBuild | PASS | 290KB minified |
| Biome Lint | WARN | Complexity warnings (expected) |

### Known Lint Warnings

- `agentLoop.ts:77` - `executeStreaming()` complexity 44 (max 15)
- `agentLoop.ts:298` - `parseActionPlan()` complexity 24 (max 15)
- `profileManager.ts:179` - `validate()` complexity 27 (max 15)
- `actionPipeline.ts:298` - `extractJson()` complexity 45 (max 15)

---

## Version

- **Current:** 0.2.0-alpha
- **Min Obsidian:** 1.4.0
