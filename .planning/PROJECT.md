# Notient Beta

## What This Is

Notient is a Sentient Notes Platform delivered as an Obsidian plugin. It transforms notes from passive files into living entities with pulse, intelligence, and agency — all powered by local LLMs. No cloud, no data leaving your machine, ever.

**Core identity**: Research Chief of Staff — the orchestrator that routes user intent to specialized expert agents, with the vault as ambient intelligence.

## Core Value

**Reliability**: Actions complete or fail gracefully. No crashes. Clear errors. This is the non-negotiable foundation that enables trust.

## Current Phase: Universe (Foundation Refactor)

> **All feature work paused until Phase Universe completes.**
> See `PHASE-UNIVERSE.md` for full specification.

Phase Universe replaces the previous 8-phase roadmap with a focused foundational refactor:

| Deliverable | Description | Status |
|-------------|-------------|--------|
| D1: SQLite Data Layer | sql.js WASM, replace JSON files | NOT STARTED |
| D2: HNSW Worker | Vector ops in Web Worker, never main thread | NOT STARTED |
| D3: Event Wiring | Fix action:proposed, applier, capability cards | NOT STARTED |
| D4: Orchestration | Simplify ChiefOfStaff + TaskManager boundaries | NOT STARTED |
| D5: Cleanup | Absorb remaining Phase 0 issues | NOT STARTED |

**Validation**: Startup <1s, Quick Actions work, Apply works, no main-thread HNSW, CPU <5% idle.

## Requirements

### Validated

<!-- Shipped and confirmed working. -->

- ✓ Kernel-based service architecture with DI
- ✓ Multi-agent system (ChiefOfStaff orchestrating agents)
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
- **Obsidian boundary**: Notient is intelligence sidecar, doesn't duplicate native features
- **Test vault**: `/mnt/c/Users/akougk/Projects/vaultex`

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| **SQLite for metadata** | JSON doesn't scale. Typed queries. Instant startup. | Phase Universe |
| **HNSW in Web Worker** | Main thread sacred. Never block UI for vectors. | Phase Universe |
| **sql.js WASM + explicit flush** | Portable, safe sync via Obsidian adapter | Phase Universe |
| **ChiefOfStaff = single event source** | Clear data flow. Agents never emit to UI. | Phase Universe |
| **TaskManager with named queues** | Support interactive + background + future cron | Phase Universe |
| **Centralized ID system** | `src/core/ids.ts` — consistent format, no chaos | ✓ Implemented |
| Chat is UI, not agent | Avoids 13th agent, Chat delegates to experts | — Pending |
| 3 pinned + 3 contextual Quick Actions | Enhance/Classify/Connect always visible, rest dynamic | — Pending |
| All suggestions shown | Aggressive ambient intelligence, user dismisses | — Pending |
| Agent results inline in Chat | User stays in Chat, doesn't switch tabs | — Pending |
| Confidence badges + justification | Both visual and textual feedback on search | — Pending |
| Settings extracted to panels | SettingsTab is 1384 lines, needs modularization | — Pending |
| Pulse animation only during indexing | Purposeful, not decorative | — Pending |
| No keyboard shortcuts | Conflicts across layers, stay visual-first | — Pending |

---
*Last updated: 2026-01-12 — Phase Universe begins*
