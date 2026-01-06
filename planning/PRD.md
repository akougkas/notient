# Notient - Product Requirements Document

> **Vision:** "Notient replaces Smart Connections as #1 Obsidian AI plugin"

## Executive Summary

Notient is a free, open-source Obsidian community plugin that provides AI-powered vault management using local LLMs only. It combines **chat-first semantic search**, **intelligent note processing**, **vault health monitoring**, and an **agentic UI** that performs vault operations within trust levels with universal undo.

**Core Differentiators vs Smart Connections v4:**
1. **Intelligence** - LLM-based search reranking + dynamic vault context (not just vectors)
2. **UI/UX** - Dual-panel sidebar (search + chat) + command-center dashboard
3. **Human-centered** - Trust levels for agent autonomy, user always in steering wheel
4. **Privacy** - Local-only, period. Zero cloud. Zero data leaves machine.
5. **Speed** - Hybrid embeddings (note-level + section-level) + LRU caching

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

### Primary Interaction: DUAL-PANEL SIDEBAR

```
┌─────────────────────────────────┐
│ 🔍 Semantic Search              │  ← Top panel: always visible
│ [Search your vault...]          │
│                                 │
│ Results with LLM reranking:     │
│ • Note A (92% - matched query)  │
│ • Note B (87% - similar topic)  │
├─────────────────────────────────┤
│ 💬 Chat with Notient            │  ← Bottom panel: always visible
│                                 │
│ User: What do I know about X?   │
│ AI: Based on 5 notes, you...    │
│     [Note A] [Note B] [Note C]  │
│                                 │
│ [Ask a follow-up question...]   │
└─────────────────────────────────┘
```

**Search Panel (top):**
- Semantic search with LLM reranking
- Results show title, score, preview, reasoning
- Click to open, drag to link

**Chat Panel (bottom):**
- Conversational Q&A about vault
- RAG pipeline: search → context → LM response
- Citations link to source notes

### Dashboard: COMMAND CENTER

The dashboard is the control surface for vault-wide operations:

1. **Vault Vitals**
   - Health score (0-100) with sub-metrics
   - Note freshness, connectivity, coverage gaps
   - PARA distribution visualization

2. **Agent Actions**
   - Available workflows (process inbox, batch classify, find duplicates)
   - Action history with undo capability
   - Pending suggestions for review

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

### Phase 1.5: ARCHITECTURAL RESET (Current)
- [ ] Remove all debug telemetry code
- [ ] Fix dual note ID generation bug
- [ ] Implement LMStudioService (actual reasoning calls)
- [ ] Hybrid embedding storage (note + sections)
- [ ] Dynamic vault context builder
- [ ] Dual-panel sidebar UI
- [ ] LLM-based search reranking
- [ ] Basic chat interface

### Phase 2: Intelligence
- [ ] Multi-pass note processing (classify → enrich → link)
- [ ] Suggested tags and links with preview
- [ ] Inbox triage workflow
- [ ] Full Vault Vitals dashboard

### Phase 3: Agentic
- [ ] Trust-level agent actions
- [ ] Batch processing with review UI
- [ ] Action history + undo in dashboard
- [ ] Workflow automation (opt-in rules)

### Phase 4: Polish
- [ ] Smart Connections migration wizard
- [ ] Advanced visualizations (knowledge graph)
- [ ] Performance optimization
- [ ] Community release packaging

---

## LM Studio Integration (NEW)

### Phased Rollout

**Phase 1.5: Search Orchestrator**
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

---

*Last updated: 2026-01-06*
*Author: Anthony Kougkas*
*Version: 2.0 (Architectural Reset)*
