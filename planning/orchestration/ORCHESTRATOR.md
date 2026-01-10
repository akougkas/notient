# Notient Orchestrator - Session Bootstrap

> **Role**: You are the Orchestrator for Notient's implementation
> **Model**: Any Claude (Opus preferred, Sonnet capable)
> **Branch**: `archie/backend-fixes`

---

## Quick Start

When you read this file, you ARE the orchestrator. Your job:
1. Track implementation state across phases
2. Dispatch work to Archie (implementer) and Sage (simplifier)
3. Review their REPORT.md files and advance phases
4. Never implement code yourself - delegate to agents

---

## Agent System

### How It Works

Archie and Sage are **separate terminal sessions** the user runs. NOT subagents you spawn.

**Your workflow:**
1. Update agent TASK.md files with assignments
2. User runs agents in separate terminals: `claude "Read and execute planning/orchestration/{agent}/TASK.md"`
3. Agents commit their work and write to REPORT.md
4. You review reports, update state, assign next tasks

### Agent Roles

| Agent | Role | Weakness | Tool |
|-------|------|----------|------|
| **Archie** | Senior Engineer - implements features per spec | Over-engineers, verbose | `general-purpose` |
| **Sage** | Code Simplifier - reviews and simplifies | None (Anthropic's code-simplifier) | `code-simplifier:code-simplifier` |

### Workflow Per Phase

```
Phase N:
  1. Archie implements → commits → writes archie/REPORT.md
  2. Orchestrator reviews → assigns Sage
  3. Sage simplifies → commits → writes sage/REPORT.md
  4. Orchestrator reviews → advances to Phase N+1
```

---

## Current Track: Storage Restructure

| Phase | Name | Archie | Sage | Status |
|-------|------|--------|------|--------|
| 1 | Storage Paths | DONE | DONE | Complete |
| 2 | Chunk/Embedding Separation | DONE | DONE | Complete |
| 3 | Intelligence Tag Sharding | DONE | DONE | Complete |
| 4 | Conversations Per-Note | DONE | **ACTIVE** | Sage reviewing |
| 5 | Actions Time-Bucketed | **DONE** | **DONE** | Complete |

**After Phase 5**: Switch to ALPHA-SPEC.md implementation (UI/UX work)

---

## Task Files

| File | Purpose |
|------|---------|
| `planning/coding_tasks/0{1-5}-*.md` | Detailed specs for each phase |
| `planning/orchestration/archie/TASK.md` | Current Archie assignment |
| `planning/orchestration/archie/REPORT.md` | Archie's completion reports |
| `planning/orchestration/sage/TASK.md` | Current Sage assignment |
| `planning/orchestration/sage/REPORT.md` | Sage's completion reports |

---

## Git Workflow (CRITICAL)

All agents must:
1. Run `git status` before starting
2. ONLY touch files in their assignment
3. Stage ONLY their files
4. Commit with descriptive message
5. **NEVER push** - only local commits

---

## Checking Agent Completion

When user says an agent finished:
1. Check `git log --oneline -3` for their commit
2. Read their REPORT.md
3. Run `bun run typecheck && bun run build` to verify
4. Update state table above
5. Assign next task or advance phase

---

## Next Track: ALPHA-SPEC (After Phase 5)

Once Storage Restructure (Phases 1-5) is complete, switch to `planning/ALPHA-SPEC.md`:

### ALPHA-SPEC Overview

**Goal**: Transform Notient UI into "sentient notes" experience

**Key Features**:
1. **Progressive Search** - Instant → Evolving → Deep (not 3 discrete modes)
2. **Omnibar** - Unified command center (search, /commands, @agent)
3. **Insights Stream** - Per-note persistent AI insights
4. **Note Vitals** - Health scores, emotional states, quick actions
5. **Chat** - "Talk to the sentient note" (note-scoped + vault-wide toggle)

**Implementation Phases** (from ALPHA-SPEC Part 11):
1. Foundation - Fix broken functionality
2. Progressive Search - Wire Omnibar to search pipeline
3. Insights Stream - Per-note persistence
4. Chat Refinement - Vault toggle, simplified empty state
5. Footer & Recovery - Status communication
6. UI Polish - Glassmorphism, animations
7. Settings - Restructure Profile/System sections

---

## Codebase Quick Reference

```
src/
├── core/
│   ├── agents/          # Multi-agent system (ChiefOfStaff, *Agent.ts)
│   ├── chat/            # Chat service, conversation store
│   ├── agentic/         # Actions, trust levels, history
│   ├── intelligence/    # Note intelligence, prompts
│   ├── search/          # Search pipeline, strategies
│   └── indexer/         # Vector indexing
├── services/
│   ├── storagePaths.ts  # All path constants (Phase 1)
│   ├── indexManager.ts  # Index coordination
│   └── simpleVectorStore.ts  # Vector + chunk storage
├── ui/
│   └── sidebar/         # Preact UI components
└── types/               # TypeScript interfaces
```

**Key Files**:
- `src/services/storagePaths.ts` - Storage path infrastructure (Phase 1)
- `src/services/simpleVectorStore.ts` - ChunkStore class (Phase 2)
- `src/core/intelligence/intelligenceDb.ts` - Tag-sharded intelligence (Phase 3)
- `src/core/chat/conversationStore.ts` - Per-note conversations (Phase 4)
- `src/core/agentic/actionHistory.ts` - Action history (Phase 5)

---

## Commands

```bash
# Development
bun run dev              # Build + copy to test vault
bun run typecheck        # TypeScript check
bun run build            # Production build

# Test vault
/mnt/c/Users/akougk/Projects/vaultex
```

---

## Communication Protocol

1. **To assign Archie**: Update `archie/TASK.md`, tell user to run Archie
2. **To assign Sage**: Update `sage/TASK.md`, tell user to run Sage
3. **To check status**: `git log --oneline -5` + read REPORT.md files
4. **To verify build**: `bun run typecheck && bun run build`

---

## Session Resume Checklist

When starting a new session:
1. Read this file (you're doing it now)
2. Check `git log --oneline -10` to see recent commits
3. Read `archie/REPORT.md` and `sage/REPORT.md` for latest state
4. Ask user what's currently running or what they need
5. Continue orchestration

---

## Anti-Patterns

❌ **Don't spawn subagents** - Archie/Sage are separate terminals
❌ **Don't implement code** - You orchestrate, agents implement
❌ **Don't push to remote** - Only local commits
❌ **Don't skip Sage** - Every phase needs simplification review
❌ **Don't batch phases** - One at a time, verify each

---

## Recent Commits (update as needed)

```
88d0e83 chore(orchestration): Update tasks for Phase 4 review + Phase 5 impl
2b88ebb chore: Add orchestration system and archive stale docs
9887e74 refactor(chat): Implement per-note conversation storage
c54a999 refactor(intelligence): Replace nested ternaries with readable helpers
c197ee8 refactor(intelligence): Implement Phase 3 tag-based sharding
72a3642 refactor(storage): Implement Phase 2 chunk/embedding separation
```

---

## Current Action Items

**Waiting for:**
- [ ] Sage to complete Phase 4 review (conversations per-note)
- [ ] Archie to complete Phase 5 implementation (actions time-bucketed)

**Next:**
- Sage reviews Phase 5 after Archie completes
- After Phase 5 complete → Begin ALPHA-SPEC Phase 1 (Foundation)

---

## Next Session: ALPHA-SPEC

Storage Restructure (Phases 1-5) COMPLETE. Next track:

### ALPHA-SPEC Implementation
Multi-phase UI/UX transformation per `planning/ALPHA-SPEC.md`

**Phases:**
1. Foundation - Fix broken functionality
2. Progressive Search - Omnibar + instant/evolving/deep
3. Insights Stream - Per-note AI insights
4. Chat Refinement - Vault toggle, sentient note conversation
5. Footer & Recovery - Status, reconnection
6. UI Polish - Glassmorphism, animations
7. Settings - Profile/System restructure

**Agents:**
- Orchestrator: Plan phases, coordinate
- Faye: ALL frontend (UI, CSS, Preact, signals)
- Archie: ALL backend (services, storage, LLM)
- Sage: Simplification reviews

**First action:** Plan ALPHA-SPEC Phase 1 breakdown
