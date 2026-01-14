# Project State

## Current Position

**Phase**: Universe — Foundation Refactor + Obsidian Integration
**Status**: ACTIVE
**Plan**: `PHASE-UNIVERSE.md`
**Architecture**: `SWARM-ARCHITECTURE.md`
**Updated**: 2026-01-14 (Swarm Architecture Decision)

## Phase Universe Progress

### Infrastructure Layer (D1-D5)

| Deliverable | Status | Est. |
|-------------|--------|------|
| D1: SQLite Data Layer | ✅ COMPLETE | 8h |
| D2: HNSW Worker Isolation | ✅ COMPLETE | 8h |
| D3: Event Wiring Completion | 🔄 IN PROGRESS | 4h |
| D4: Swarm Architecture | 🔄 REDESIGNED | 12h |
| D5: Cleanup + embed.worker | 📋 READY | 6h |
| D10: SQLite Full Migration | 📋 READY | 8h |
| D11: Skills Architecture | ✅ COMPLETE | 6h |

### Integration Layer (D6-D9)

| Deliverable | Status | Est. |
|-------------|--------|------|
| D6: Frontmatter Intelligence Bridge | ✅ COMPLETE | 4h |
| D7: Vitals from MetadataCache | ✅ COMPLETE | 3h |
| D8: Editor Decorations | ⏸️ DEFERRED | 8h |
| D9: Context Menu Integration | ✅ COMPLETE | 3h |

**Total**: ~58 hours (~3.5 weeks at 4h/day)

## D4: Swarm Architecture (Current Focus)

**Status**: REDESIGNED (2026-01-14)

The 4-agent swarm replaces the previous "ChiefOfStaff consolidation" plan:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR (Brain)                              │
│  • Receives ALL requests (UI, Chat, Editor Decorations)                 │
│  • Makes action plans using reasoning model                             │
│  • Delegates to specialized agents                                       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────────────┐
        ▼                           ▼                                   ▼
┌───────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│    NoteEditor     │     │   ContextBuilder    │     │       Worker        │
│ • Edit/Create     │     │ • Search vault      │     │ • Execute workflows │
│ • Canvas/Bases    │     │ • Find related      │     │ • Classify, Enhance │
│ • Self-verify     │     │ • User behavior     │     │ • Atomize, Connect  │
│ Uses: Skills      │     │ Uses: Search        │     │ Uses: Prompts       │
└───────────────────┘     └─────────────────────┘     └─────────────────────┘
```

### Implementation Phases

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Refactor ChiefOfStaff → Orchestrator (brain only) | NOT STARTED |
| Phase 2 | Create WorkerAgent (unified workflow executor) | NOT STARTED |
| Phase 3 | Enhance NoteEditor (self-verification) | NOT STARTED |
| Phase 4 | Enhance ContextBuilder (behavior/trend tracking) | NOT STARTED |
| Phase 5 | ChatService integration (hybrid mode) | NOT STARTED |

### Files to Modify

| Action | File |
|--------|------|
| REFACTOR | `src/core/agents/chiefOfStaff.ts` → Orchestrator |
| CREATE | `src/core/agents/workerAgent.ts` |
| ENHANCE | `src/core/agents/noteEditorAgent.ts` |
| ENHANCE | `src/core/agents/contextBuilderAgent.ts` |
| MODIFY | `src/core/chat/chatService.ts` |
| DELETE | `src/core/agents/classifierAgent.ts` |
| DELETE | `src/core/agents/connectionAgent.ts` |
| DELETE | `src/core/agents/workflowAgents.ts` |

## The Core Insights

> **"The Note is the Unit"** (2026-01-12)
>
> Intelligence must surface IN the note (frontmatter, decorations), not just the sidebar.
> The sidebar is for commands and history. The note is the canvas.

> **"4-Agent Swarm"** (2026-01-14)
>
> The current 13+ agent system has accidental complexity. Each "agent" does the same thing:
> build prompt → call LLM → parse output. The complexity isn't in the PROBLEM, it's in the 
> IMPLEMENTATION. 4 specialized agents with clear responsibilities is simpler and scalable.

## Validation Criteria

### Performance
- [ ] Startup <1s to UI shell
- [ ] Note context load <500ms

### Core Functionality
- [ ] Quick Actions work end-to-end
- [ ] Apply button applies actions
- [ ] Search reranking works

### Architecture (Updated)
- [x] No main-thread HNSW ✅
- [ ] All data in SQLite (heavy) + Frontmatter (light)
- [ ] 4-Agent Swarm operational
  - [ ] Orchestrator receives all requests
  - [ ] NoteEditor with self-verification
  - [ ] ContextBuilder with behavior tracking
  - [ ] Worker executes all workflows
- [ ] ChatService can trigger Orchestrator
- [ ] CPU <5% at idle

### Integration
- [x] `notient-health` in frontmatter ✅
- [x] Right-click context menus work ✅
- [x] Vitals use metadataCache ✅

## Next Action

```bash
# D4 Phase 1: Refactor Orchestrator
# Start with src/core/agents/chiefOfStaff.ts
# Remove direct agent instantiation
# Add action planning with LLM reasoning
# Delegate via clean interface
```

## Previous Work (Archived)

- Old 8-phase roadmap → `.planning/_archive/pre-universe/ROADMAP.md`
- Phase 0 tracking → `.planning/_archive/pre-universe/STATE.md`
- ID System implemented → `docs/ID-SYSTEM.md`
- Obsidian docs committed → `docs/obsidian/`

---
*Last updated: 2026-01-14 — Swarm Architecture Decision*
