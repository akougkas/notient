# Notient Beta

## What This Is

Notient is a Sentient Notes Platform delivered as an Obsidian plugin. It transforms notes from passive files into living entities with pulse, intelligence, and agency — all powered by local LLMs. No cloud, no data leaving your machine, ever.

**Core identity**: Research Chief of Staff — the orchestrator that routes user intent to specialized expert agents, with the vault as ambient intelligence.

## Core Value

**Reliability**: Actions complete or fail gracefully. No crashes. Clear errors. This is the non-negotiable foundation that enables trust.

## Requirements

### Validated

<!-- Shipped and confirmed working. Inferred from existing codebase. -->

- ✓ Kernel-based service architecture with DI — existing
- ✓ Multi-agent system (ChiefOfStaff orchestrating agents) — existing
- ✓ LLM abstraction (LM Studio reasoning, Ollama embeddings) — existing
- ✓ HNSW vector search with O(log N) performance — existing (CODE RED complete)
- ✓ Progressive search (INSTANT → EVOLVING → DEEP) — existing
- ✓ Streaming chat with thinking block parsing — existing
- ✓ Trust-level system (low/medium/high risk) — existing
- ✓ Three-tab sidebar (Note Vitals | Agent Streams | Chat) — existing
- ✓ Error boundaries in sidebar — existing (CODE RED complete)
- ✓ App.tsx refactored (<500 lines) — existing (CODE RED complete)
- ✓ Action history with time-bucketed storage and undo — existing
- ✓ Per-note intelligence records (health, entities, suggestions) — existing

### Active

<!-- Current scope. Building toward these for Beta. -->

**Architecture**
- [ ] 12-agent system: 9 user-facing + 3 infrastructure (Chat is UI, not agent)
- [ ] Chat as thin UI layer that delegates to expert agents when needed
- [ ] Quick Actions rewired to call expert agents via ChiefOfStaff
- [ ] Quick Actions model: 3 pinned (Enhance, Classify, Connect) + 3 contextual
- [ ] LinkFinder deprecated → Connection agent handles semantic links

**Insights Stream**
- [ ] Wire agent results to InsightStream (1-liner + expand)
- [ ] Wire proactive AI suggestions from IntelligenceRecord
- [ ] All suggestions shown (user can dismiss), not filtered by confidence

**Agent Command Center (Agent Streams View)**
- [ ] Wire AgentStreamsView to ActionHistory service
- [ ] Wire to AgentTaskQueue for active agents
- [ ] Wire to TrustLevelManager for pending review
- [ ] Full control: pause, cancel, modify, re-run

**Chat Experience**
- [ ] Contextual suggestion chips (based on note type/state)
- [ ] Pre-built prompts with metadata arguments
- [ ] Chat streams agent results inline (no tab switching)

**Search Enhancement**
- [ ] Confidence badges (High/Medium/Low) on results
- [ ] AI justification text on hover/expand

**Reliability Hardening**
- [ ] JSON parsing robustness for agent outputs
- [ ] Timeout handling with user feedback
- [ ] Input/output validation for LLM calls
- [ ] Agent failure handling for autonomous actions

**Settings Refactor**
- [ ] Extract SettingsTab into panel components

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
| Chat is UI, not agent | Avoids 13th agent, Chat delegates to experts | — Pending |
| 3 pinned + 3 contextual Quick Actions | Enhance/Classify/Connect always visible, rest dynamic | — Pending |
| All suggestions shown | Aggressive ambient intelligence, user dismisses | — Pending |
| Agent results inline in Chat | User stays in Chat, doesn't switch tabs | — Pending |
| Confidence badges + justification | Both visual and textual feedback on search | — Pending |
| Settings extracted to panels | SettingsTab is 1384 lines, needs modularization | — Pending |
| Pulse animation only during indexing | Purposeful, not decorative | — Pending |
| No keyboard shortcuts | Conflicts across layers, stay visual-first | — Pending |

---
*Last updated: 2025-01-11 after initialization*
