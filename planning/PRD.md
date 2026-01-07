# Notient - Product Requirements Document

> **Vision:** "Notient replaces Smart Connections as #1 Obsidian AI plugin"

## Executive Summary

**Notient = Note + Sentient — Sentient Notes for the thinking human.**

Notient is a free, open-source Obsidian community plugin that transforms notes from passive files into living entities with health, dynamics, and agency. Using local LLMs only, it provides **note-centric AI intelligence**, **vault health monitoring**, and **agentic operations** within trust levels.

**The Sentient Notes Philosophy:**
- Every note has a pulse: health score, freshness, connectivity
- Every note has context: PARA type, related notes, suggested actions
- Every note can speak: through the Agents chat, notes become conversational
- The user steers; Notient amplifies

**Core Differentiators vs Smart Connections v4:**
1. **Note-Centric** - Dashboard focused on current note, not just vault-wide chat
2. **Intelligence** - LLM-based search reranking + dynamic vault context (not just vectors)
3. **UI/UX** - Tabbed sidebar (Note Dashboard + Agents) with omnibar search
4. **Human-centered** - Trust levels for agent autonomy, user always in steering wheel
5. **Privacy** - Local-only, period. Zero cloud. Zero data leaves machine.
6. **Speed** - Hybrid embeddings (note-level + section-level) + LRU caching

---

## Target User

- Obsidian power users with large vaults (500+ notes)
- Privacy-conscious knowledge workers
- Users following PARA method or similar organizational systems
- People who want AI assistance without cloud dependencies

---

## Core Principles

1. **Local-only** - Ollama + LM Studio only. No cloud APIs. Ever.
2. **Human-in-steering-wheel** - Trust levels for autonomy, universal undo, user commands agents
3. **Theme-aware** - Respects user's Obsidian theme and aesthetic
4. **Simplicity over complexity** - Fewer abstractions, clean code, no debug cruft

---

## Technical Architecture

### Stack
- **Language:** TypeScript (strict mode)
- **Build:** Bun + esbuild
- **LLM (Reasoning):** LM Studio (OpenAI-compatible API) - search orchestration, classification, chat
- **LLM (Embeddings):** Ollama (local or remote on LAN)
- **Vector Store:** Custom brute-force cosine similarity (pure JS, zero dependencies)
- **UI Framework:** Obsidian API + native components

### Data Storage
```
.obsidian/plugins/notient/
├── data.json                    # Plugin settings
├── index-{modelKey}.json        # Hybrid embeddings (note-level + section-level)
├── state-{modelKey}.json        # Index state (per model)
├── conversations.json           # Per-task chat history (Phase 1.7)
├── cache/                       # Search result cache
└── locks/                       # Multi-window safety
```

### Embedding Strategy: HYBRID
- **Note-level embeddings:** Whole-note vectors for broad semantic matching
- **Section-level embeddings:** Heading-aware chunks for precise retrieval
- **Both stored per note:** Enables flexible retrieval strategies
- **Updates:** Debounced, incremental (content-hash change detection)

### Search Strategy: LLM-RERANKED
1. Vector search returns top-50 candidates (fast, <100ms)
2. LM Studio reranks by query relevance (smart, adds ~500ms)
3. Final results with reasoning/citations displayed

### Vault Awareness: DYNAMIC CONTEXT
- Context built **on-demand per query** (not static scan)
- Includes: relevant folders, active tags, recent notes, link graph fragment
- Injected into LM Studio prompts for vault-aware responses

---

## User Experience

### Primary Interaction: TABBED SIDEBAR

The sidebar has two tabs: **Note** (default) and **Agents**. This separates note-specific context from conversational AI interactions.

#### Tab 1: Note Dashboard (Default)

```
┌─────────────────────────────────┐
│ [Note] [Agents]              ☰ │  ← Minimal tab bar
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ NOTE VITALS                 │ │  ← Compact metric cards
│ │ ┌──────┐ ┌──────┐ ┌──────┐  │ │
│ │ │Health│ │Links │ │Fresh │  │ │  ← Glanceable, clickable
│ │ │ 87%  │ │  12  │ │  3d  │  │ │
│ │ └──────┘ └──────┘ └──────┘  │ │
│ │                             │ │
│ │ PARA: Project • #dev #api   │ │  ← Classification + tags
│ │ ────────────────────────────│ │
│ │ ⚡ Quick Actions:           │ │  ← One-click AI actions
│ │ [Enrich] [Link] [Classify]  │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ 🔍 Search your vault...         │  ← THE OMNIBAR
├─────────────────────────────────┤
│                                 │
│ Results with AI reasoning       │  ← Clean, scannable results
│ • Note A - "matches because..." │
│ • Note B - "similar topic..."   │
│                                 │
└─────────────────────────────────┘
```

**Note Vitals Dashboard:**
- Health score (connectivity, freshness, completeness)
- Link count (backlinks + outlinks)
- Staleness indicator (days since modified)
- PARA classification with confidence
- Tags from frontmatter
- Quick actions based on note state

**The Omnibar Experience:**
- Single input, infinite possibilities
- Natural language: "notes about API design"
- Commands: "/find duplicates" or "/enrich"
- Tag filters: "#project" or "folder:archive"
- Notient decides: heuristic vs semantic vs agent
- Results stream in with AI explanations

#### Tab 2: Agent Streams (Vault-Global Activity)

```
┌─────────────────────────────────┐
│ [Note] [Agents]              ☰ │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ AGENT DASHBOARD             │ │  ← Three capability cards
│ │ ┌───────┐┌───────┐┌───────┐ │ │
│ │ │Search ││Context││ Chat  │ │ │  ← Health + pulsing when active
│ │ │  ●    ││  ●    ││  ●    │ │ │
│ │ └───────┘└───────┘└───────┘ │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ ACTIVITY STREAM                 │  ← Vault-global task feed
│                                 │
│ ┌─────────────────────────────┐ │
│ │ 🔗 Context Builder          │ │  ← Task card (clickable)
│ │ "API Design Notes"          │ │
│ │ ████████░░ 80%    2m ago    │ │  ← Progress + timestamp
│ │                         [✕] │ │  ← Cancel button
│ └─────────────────────────────┘ │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ 💬 Chat Assistant           │ │
│ │ "Project Roadmap"           │ │
│ │ ✓ Completed        5m ago   │ │
│ └─────────────────────────────┘ │
│                                 │
│ Click any task to view details  │
│ and chat with the agent         │
└─────────────────────────────────┘
```

**Agent Dashboard:**
- Three capability cards: Semantic Search, Context Builder, Chat Assistant
- Combined status: service health (dot color) + pulsing indicator when processing
- Last activity timestamp per agent

**Activity Stream (Vault-Global):**
- Shows all agent tasks across the vault (many-to-many: agents ↔ notes)
- Task cards with: note title, agent type, status, progress bar, timestamp
- Running/queued tasks show cancel button
- **Click any card → opens TaskModal popup**

**TaskModal (Popup on Click):**
- Note preview section
- RAG sources (citations used for context)
- Task results when complete
- **Chat section** with message bubbles (Enter sends, Shift+Enter newline)
- Streaming with cancel button (discard partial on cancel)
- Citations as clickable `[[Note Name]]` links

### Secondary View: COMMAND DASHBOARD

Accessible via ribbon icon or command palette. Vault-wide operations:

1. **Vault Vitals**
   - Aggregate health score with breakdown
   - PARA distribution visualization
   - Orphan notes, stale notes, coverage gaps

2. **Agent Actions**
   - Available workflows (process inbox, batch classify)
   - Action history with undo capability
   - Pending suggestions for batch review

3. **Index Management**
   - Sync status, model info, rebuild controls
   - Export/import for portability

---

## Agent Autonomy Model

### Trust Levels

| Risk Level | Actions | Behavior |
|------------|---------|----------|
| **Low** | Add tags, update frontmatter | Auto-apply, log to activity |
| **Medium** | Move notes, create links | Show confirmation, one-click approve |
| **High** | Merge notes, archive, delete | Warning dialog, require explicit confirm |

### Undo Philosophy
- Every agent action is reversible within Obsidian's capabilities
- Dashboard shows action history with undo buttons
- No over-engineering: use Obsidian's native undo where possible

### Workflow Types
- **Current note:** Process this note (classify, enrich, suggest links)
- **Folder batch:** Process all notes in folder (like Python's `process_folder`)
- **Vault-wide:** Full vault operations (like Python's `process_vault`)

---

## Features

### Phase 1.5: ARCHITECTURAL RESET ✅ COMPLETE
- [x] Remove all debug telemetry code
- [x] Fix dual note ID generation bug
- [x] Implement LMStudioService (actual reasoning calls)
- [x] Hybrid embedding storage (note + sections)
- [x] Dynamic vault context builder
- [x] Basic dual-panel sidebar UI
- [x] LLM-based search reranking
- [x] Basic chat interface

### Phase 1.6: UI/UX OVERHAUL ✅ COMPLETE
- [x] Design system with BEM naming (`nv2-*` prefix)
- [x] Brand colors and typography tokens (CSS variables)
- [x] String humanization (no dev jargon)
- [x] Tabbed sidebar (Note + Agents tabs)
- [x] Note Vitals dashboard component (health, links, freshness, tags)
- [x] Omnibar search experience (debounced, with results)
- [x] Agent chat with streaming UI (via sendQuery)
- [x] Quick actions based on note state (Enrich, Link, Move)
- [x] Insight Stream with dynamic suggestions
- [x] Agent Dashboard (service status cards)
- [x] Activity Log (generated from chat history)
- [x] Footer with service health status

### Phase 1.7: BACKEND COMPLETION (Current)

**Scope:** Hybrid approach - foundation now, defer bulk operations to Phase 2.

- [ ] **Search Settings with Presets**
  - [ ] Preset dropdown: Quick / Balanced / Thorough / Custom
  - [ ] Custom mode reveals: top-K slider, reranking toggle, min score
  - [ ] Wire presets to SearchPipeline
- [ ] **Agent Task System** (Core new architecture)
  - [ ] `AgentTask` type with status, progress, per-task chat history
  - [ ] `AgentTaskQueue` service (sequential, one at a time)
  - [ ] Activity stream with full task cards (not just activity log)
  - [ ] Quick Actions fire tasks → appear in stream
  - [ ] Cancel button (always cancelable)
- [ ] **TaskModal Popup**
  - [ ] Note preview section
  - [ ] RAG sources (citations)
  - [ ] Task results display
  - [ ] Chat section with message bubbles
  - [ ] Enter sends, Shift+Enter newline
  - [ ] Streaming with cursor, cancel discards partial
  - [ ] Citations as `[[Note Name]]` links (prompt LLM to use format)
- [ ] **Agent Dashboard Status**
  - [ ] Three capability cards: Semantic Search, Context Builder, Chat Assistant
  - [ ] Combined status: health dot + pulsing when processing
  - [ ] Last activity timestamp per agent
- [ ] **Index Progress in Footer**
  - [ ] Non-blocking progress bar during indexing
  - [ ] Note count: "X notes indexed"
  - [ ] Last sync timestamp

**Deferred to Phase 2:**
- Bulk omnibar commands (`/enrich all in Projects/`)
- Complex queue management (priority, retry)
- Conversation persistence across sessions
- Multi-agent orchestration on single note

### Phase 2: AGENTIC
- [ ] Trust-level agent actions (low/medium/high risk)
- [ ] Bulk omnibar commands (`/enrich all in folder/`)
- [ ] Batch processing with review UI
- [ ] Action history + undo in dashboard
- [ ] Workflow automation (opt-in rules)
- [ ] Conversation persistence across sessions

### Phase 3: INTELLIGENCE
- [ ] Multi-pass note processing (classify → enrich → link)
- [ ] Suggested tags and links with preview
- [ ] Inbox triage workflow
- [ ] Full Vault Vitals dashboard
- [ ] Note health scoring algorithm
- [ ] Background classification

### Phase 4: POLISH
- [ ] Smart Connections migration wizard
- [ ] Advanced visualizations (knowledge graph)
- [ ] Performance optimization
- [ ] Community release packaging

---

## LM Studio Integration

### Core Capabilities

**Streaming Responses (✅ Implemented)**
- All chat responses stream token-by-token via `chatStream()`
- AbortController support for cancellation
- Graceful handling of connection drops mid-stream

**Reranking Pipeline (✅ Implemented)**
- Vector search returns top-50 candidates
- LM Studio reranks by semantic relevance
- Returns reasoning for each result
- Fallback to vector scores if LLM unavailable

**Classification Engine (Phase 2)**
- PARA type detection with confidence scores
- Tag suggestions based on content analysis
- Related note discovery via semantic similarity
- Batch classification for inbox processing

### Phased Rollout

**Phase 1.5: Search Orchestrator ✅**
- Rerank vector search results by query relevance
- Synthesize search results into coherent answers
- Extract key insights from multiple notes

**Phase 2: Background Classifier**
- Process inbox notes silently
- Suggest tags, folders, related notes
- User reviews suggestions in batch

**Phase 3: Interactive Assistant**
- Full chat interface with conversation history
- Ask questions about vault, get summaries
- Compare notes, find contradictions

### Prompt Architecture
- System prompt with vault context (dynamic)
- RAG query format with retrieved chunks
- Structured output parsing for classifications
- Configurable prompt templates in settings

---

## Configuration & Settings

### Exposed Configuration (Current State)

**Service Settings (✅ Implemented):**
- Ollama URL (local/network toggle)
- LM Studio URL (local/network toggle)
- Embedding model selection with dimension display
- Reasoning model selection
- Connection timeout values (in HealthMonitor)

**Indexing Settings (✅ Implemented):**
- Chunk size slider (32-8192)
- Excluded folders list
- Index management (sync, rebuild, trim, export/import)

**PARA Settings (✅ Implemented):**
- Folder mapping for each PARA type
- Multiple folders per type support

### Needed Configuration (Phase 1.7)

**Search Settings (Preset-Based):**
- Preset selector: Quick / Balanced / Thorough / Custom
  - Quick: 5 results, no reranking, 0.5 min score
  - Balanced: 10 results, reranking enabled, 0.3 min score (default)
  - Thorough: 25 results, reranking enabled, 0.2 min score
- Custom mode reveals individual sliders

**Chat Settings:**
- Max conversation history for LLM context: 10 messages (sliding window)
- Activity retention: session-only (clears on restart)
- Clear conversation button in TaskModal

**Agent Settings (Phase 2):**
- Trust level defaults (low/medium/high)
- Auto-apply for low-risk actions toggle
- Confirmation dialog preferences

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Vector search (top-50) | < 100ms |
| LLM reranking | < 1000ms |
| Full search (cached) | < 100ms |
| Full search (uncached) | < 1500ms |
| Indexing speed | 50 notes/second |
| Memory footprint | < 300MB |
| Startup time | < 2 seconds |

---

## Success Metrics

1. **Community:** 1,000 GitHub stars within 6 months
2. **Adoption:** 10,000 downloads from Obsidian community plugins
3. **Ranking:** Top 5 in Obsidian plugin directory (AI category)
4. **Engagement:** Active GitHub Discussions community

---

## Non-Goals (Explicitly Out of Scope)

- Cloud API support (OpenAI, Claude, etc.) - LOCAL ONLY
- CLI companion tool - plugin handles everything
- Mobile support (Obsidian mobile) - desktop first
- Real-time collaboration features
- Sync across devices (vault sync is Obsidian's job)
- Over-engineered undo system beyond Obsidian capabilities

---

## Competitive Analysis

| Feature | Notient | Smart Connections v4 | Copilot |
|---------|---------|---------------------|---------|
| Local-only | ✅ Required | ✅ Optional | ⚠️ Cloud-first |
| LLM reranking | ✅ Core feature | ❌ | ⚠️ Cloud |
| Vault context | ✅ Dynamic per-query | ❌ Static | ❌ |
| Dual-panel UI | ✅ Search + Chat | ⚠️ Chat only | ⚠️ Chat only |
| Agent trust levels | ✅ Low/Med/High | ❌ | ❌ |
| PARA-aware | ✅ Built-in | ❌ | ❌ |
| Price | Free | Free | Freemium |

---

## Open Questions (Resolved)

1. ~~Chunking strategy~~ → **Hybrid: note-level + section-level**
2. ~~LM Studio role~~ → **Phased: orchestrator → classifier → chat**
3. ~~Vault context~~ → **Dynamic builder per query**
4. ~~Search ranking~~ → **LLM reranking of vector top-50**
5. ~~Agent autonomy~~ → **Trust levels + batch review + undo**
6. ~~Debug telemetry~~ → **Remove completely, console-only logging**
7. ~~Agent Streams scope~~ → **Vault-global activity stream, chat in popup modal**
8. ~~Search settings UX~~ → **Presets (Quick/Balanced/Thorough) + Custom**
9. ~~Task concurrency~~ → **Sequential, one at a time**
10. ~~Activity retention~~ → **Session-only, clears on restart**
11. ~~Phase order~~ → **Agentic (Phase 2) before Intelligence (Phase 3)**

---

*Last updated: 2026-01-06*
*Author: Anthony Kougkas*
*Version: 2.3 (Phase 1.7 Architecture Refined)*
