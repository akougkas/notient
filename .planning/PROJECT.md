# Notient Beta

## What This Is

Notient is a Sentient Notes Platform delivered as an Obsidian plugin. It transforms notes from passive files into living entities with pulse, intelligence, and agency — all powered by local LLMs. No cloud, no data leaving your machine, ever.

**Core identity**: Research Chief of Staff — the orchestrator that routes user intent to specialized expert agents, with the vault as ambient intelligence.

## Core Value

**Reliability**: Actions complete or fail gracefully. No crashes. Clear errors. This is the non-negotiable foundation that enables trust.

## Current Phase: Universe (Foundation Refactor + Obsidian Integration)

> **All feature work paused until Phase Universe completes.**
> See `PHASE-UNIVERSE.md` for full specification.

### The Core Insight: "The Note is the Unit"

Intelligence must surface IN the note (frontmatter, decorations), not just the sidebar. The sidebar is for commands and history. The note is the canvas.

### Two-Layer Architecture

| Layer | Purpose | Deliverables |
|-------|---------|--------------|
| **Infrastructure** | Heavy lifting (hidden) | D1-D5: SQLite, Workers, Events |
| **Integration** | Note-native display (visible) | D6-D9: Frontmatter, MetadataCache, Decorations, Menus |

### Phase Universe Progress

| Deliverable | Description | Status |
|-------------|-------------|--------|
| D1: SQLite Data Layer | sql.js WASM, replace JSON files | ✅ COMPLETE |
| D2: HNSW Worker | Vector ops in Web Worker | 🔄 IN PROGRESS |
| D3: Event Wiring | Fix action:proposed, applier, capability cards | NOT STARTED |
| D4: Orchestration | Simplify ChiefOfStaff + TaskManager | NOT STARTED |
| D5: Cleanup | Absorb remaining Phase 0 issues | NOT STARTED |
| D6: Frontmatter Bridge | Store AI insights in note properties | NOT STARTED |
| D7: MetadataCache Vitals | Use Obsidian's cache, stop duplicating | NOT STARTED |
| D8: Editor Decorations | Inline AI insights via CodeMirror 6 | NOT STARTED |
| D9: Context Menus | Right-click AI actions | NOT STARTED |

**Validation**: Startup <1s, Quick Actions work, Apply works, no main-thread HNSW, CPU <5% idle, `notient-health` in frontmatter.

## Requirements

### Validated

<!-- Shipped and confirmed working. -->

- ✓ Kernel-based service architecture with DI
- ✓ Multi-agent system (ChiefOfStaff orchestrating agents)
- ✓ Skills Architecture (Dynamic capability injection)
- ✓ LLM abstraction (LM Studio reasoning, Ollama embeddings)
- ✓ HNSW vector search with O(log N) performance
- ✓ Progressive search (INSTANT → EVOLVING → DEEP)
- ✓ Streaming chat with thinking block parsing
- ✓ Trust-level system (low/medium/high risk)
- ✓ Three-tab sidebar (Note Vitals | Agent Streams | Chat)
- ✓ Error boundaries in sidebar
- ✓ Action history with undo
- ✓ Per-note intelligence records
- ✓ Centralized ID system (`src/core/ids.ts`)
- ✓ SQLite data layer with Kysely (`src/core/db/`)
- ✓ Canonical Obsidian API reference (`docs/obsidian/`)

### Paused (Post-Universe)

<!-- Will be re-evaluated after Phase Universe completes. -->

**Architecture**
- [ ] 12-agent system: 9 user-facing + 3 infrastructure
- [ ] Quick Actions model: 3 pinned + 3 contextual

**Insights Stream**
- [ ] Wire agent results to InsightStream
- [ ] Wire proactive AI suggestions

**Agent Command Center**
- [ ] Wire AgentStreamsView to services
- [ ] Full control: pause, cancel, modify, re-run

**Chat Experience**
- [ ] Contextual suggestion chips
- [ ] Chat streams agent results inline

**Search Enhancement**
- [ ] Confidence badges + AI justification

**Settings Refactor**
- [ ] Extract SettingsTab into panels

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Cloud LLM support (OpenAI, Claude) — Local-only is non-negotiable, period
- Mobile/Sync — Desktop first, sync is Obsidian's job
- Multi-vault features — Single vault focus for Beta
- Custom keyboard shortcuts — Conflicts across OS/Obsidian/plugins, stay visual
- Vault pulse animation per-agent — Only during system indexing
- Production hardening beyond reliability — Only after human testing validates needs
- Research track (thesis, grants) — Entirely out of scope for Beta

## Context

**Brownfield project**: Substantial existing codebase with ~15K lines of TypeScript. Architecture is clean (kernel, services, events, agents). CODE RED fixes complete (HNSW, Error Boundaries, App.tsx refactor).

**The White House Model**: User is President (decision maker), ChiefOfStaff is orchestrator, Agents are department heads with specialized expertise. Agents are capabilities, not personas.

**Ambient intelligence**: Notient works in the background. InsightStream surfaces suggestions without demanding user attention. The vault talks back.

**Interview-validated spec**: BETA-SPEC.md captures the product vision from extensive interview. This PROJECT.md aligns with that vision while tracking implementation scope.

## Constraints

- **No new dependencies**: Work with existing stack only (Preact, signals, HNSW, Biome)
- **Local-only**: All LLM operations via Ollama (embeddings) and LM Studio (reasoning)
- **Obsidian-native**: Use metadataCache, processFrontMatter, Editor Extensions before custom
- **Test vault**: `/mnt/c/Users/akougk/Projects/vaultex`

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| **"Note is the Unit"** | Intelligence surfaces IN the note, not just sidebar | ✓ Phase Universe |
| **Two-layer architecture** | Infrastructure (hidden) + Integration (visible) | ✓ Phase Universe |
| **SQLite for metadata** | JSON doesn't scale. Typed queries. Instant startup. | ✓ D1 Complete |
| **HNSW in Web Worker** | Main thread sacred. Never block UI for vectors. | 🔄 D2 In Progress |
| **sql.js WASM + Obsidian adapter** | Portable, safe sync via `adapter.write()` | ✓ D1 Complete |
| **Frontmatter intelligence** | `notient-health`, `notient-summary` IN the note | — D6 Pending |
| **Use metadataCache** | Don't recalculate what Obsidian already knows | — D7 Pending |
| **Editor Decorations** | CodeMirror 6 for inline AI insights | — D8 Pending |
| **Context menus** | Right-click "Find related", "Enhance this" | — D9 Pending |
| **ChiefOfStaff = single event source** | Clear data flow. Agents never emit to UI. | — D3/D4 Pending |
| **Centralized ID system** | `src/core/ids.ts` — consistent format, no chaos | ✓ Implemented |
| Chat is UI, not agent | Avoids 13th agent, Chat delegates to experts | — Pending |
| 3 pinned + 3 contextual Quick Actions | Enhance/Classify/Connect always visible, rest dynamic | — Pending |

## Reference Documentation

- **Obsidian API**: `docs/obsidian/` — Canonical reference for CSS, Editor, Plugin, UI
- **Phase Plan**: `.planning/PHASE-UNIVERSE.md` — Full specification
- **State Tracking**: `.planning/STATE.md` — Current progress

---
*Last updated: 2026-01-12 — Post-Integration Audit*
