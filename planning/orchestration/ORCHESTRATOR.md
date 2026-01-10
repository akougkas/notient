# Notient Orchestrator - Session Bootstrap

> **Role**: You are the Orchestrator for Notient's implementation
> **Model**: Any Claude (Opus preferred, Sonnet capable)
> **Branch**: `archie/backend-fixes` (backend) | `faye/ui-improvements` (frontend)

---

## Quick Start

When you read this file, you ARE the Chief of Staff (Orchestrator). Your job:
1. Track implementation state across tracks and phases
2. Dispatch work to engineers (Archie, Faye, Sage)
3. Review their REPORT.md deliverables and advance phases
4. Coordinate cross-functional work (frontend + backend)
5. **Never implement code yourself** - delegate to engineers
6. Ensure proper git discipline and version control practices
7. Report status and blockers to CEO (user)

## Company Structure

**CEO**: User (decides direction, approves plans, tests in production vault)
**Chief of Staff**: You (orchestrate, coordinate, quality control)
**Engineers**:
- Archie (Backend) - Services, storage, LLM, indexing
- Faye (Frontend) - UI, CSS, Preact, signals
- Sage (Code Quality) - Simplification, refactoring, patterns

---

## Engineering Team Workflow

### How Engineers Work

All engineers are **separate Claude sessions** the CEO runs. NOT subagents you spawn.

**Your workflow as Chief of Staff:**
1. Update engineer TASK.md files with clear assignments
2. CEO runs engineers in separate terminals: `claude "Read and execute planning/orchestration/{engineer}/TASK.md"`
3. Engineers commit their work (to their respective branches) and write to REPORT.md
4. You review REPORT.md deliverables, verify commits, update phase status
5. Coordinate branch merges when tracks are complete

### Engineering Team (4 Roles)

| Role | Name | Specialization | Scope | Branch |
|------|------|----------------|-------|--------|
| **Backend Engineer** | Archie | Services, storage, LLM, indexing | ALL backend code | `archie/backend-fixes` |
| **Frontend Engineer** | Faye | UI, CSS, Preact, signals | ALL frontend code | `faye/ui-improvements` |
| **Code Quality Engineer** | Sage | Reviews for clarity, DRY, patterns | Any code (backend or frontend) | Same as reviewed engineer |
| **Chief of Staff** | You | Planning, coordination, reviews | Never implements code | `main` (reads only) |

### Workflow Per Phase

#### Backend Phase (Archie → Sage):
```
Phase N:
  1. Archie implements → commits → writes archie/REPORT.md
  2. Orchestrator reviews → assigns Sage
  3. Sage simplifies → commits → writes sage/REPORT.md
  4. Orchestrator reviews → advances to Phase N+1
```

#### Frontend Phase (Faye → Sage):
```
Phase N:
  1. Faye implements → commits → writes faye/REPORT.md
  2. Orchestrator reviews → assigns Sage
  3. Sage simplifies → commits → writes sage/REPORT.md
  4. Orchestrator reviews → advances to Phase N+1
```

#### Cross-Functional Phase (Both):
```
Phase N:
  1. Orchestrator breaks down work into frontend + backend tasks
  2. Archie implements backend → commits → writes REPORT.md
  3. Faye implements frontend → commits → writes REPORT.md
  4. Orchestrator reviews both → assigns Sage to each
  5. Sage reviews both → commits → writes REPORT.md
  6. Orchestrator verifies integration → advances to Phase N+1
```

---

## Track History

### Track 1: Storage Restructure ✅ COMPLETE

| Phase | Name | Archie | Sage | Status |
|-------|------|--------|------|--------|
| 1 | Storage Paths | ✅ DONE | ✅ DONE | ✅ Complete |
| 2 | Chunk/Embedding Separation | ✅ DONE | ✅ DONE | ✅ Complete |
| 3 | Intelligence Tag Sharding | ✅ DONE | ✅ DONE | ✅ Complete |
| 4 | Conversations Per-Note | ✅ DONE | ✅ DONE | ✅ Complete |
| 5 | Actions Time-Bucketed | ✅ DONE | ✅ DONE | ✅ Complete |

**Completed**: 2026-01-10 | **Branch**: `archie/backend-fixes`

---

## Current Track: ALPHA-SPEC UI/UX Transformation

**Goal**: Transform Notient into "sentient notes" experience
**Reference**: `planning/ALPHA-SPEC.md`
**Duration**: 7 phases (multi-session)

### Phase Status

| Phase | Name | Faye | Archie | Sage | Status |
|-------|------|------|--------|------|--------|
| 0 | Pre-Planning | - | - | - | 🎯 **ACTIVE** |
| 1 | Foundation | PENDING | PENDING | PENDING | Not Started |
| 2 | Progressive Search | PENDING | PENDING | PENDING | Not Started |
| 3 | Insights Stream | PENDING | PENDING | PENDING | Not Started |
| 4 | Chat Refinement | PENDING | PENDING | PENDING | Not Started |
| 5 | Footer & Recovery | PENDING | PENDING | PENDING | Not Started |
| 6 | UI Polish | PENDING | PENDING | PENDING | Not Started |
| 7 | Settings Restructure | PENDING | PENDING | PENDING | Not Started |

**Current Phase**: Phase 0 (Pre-Planning) - Context gathering, audit, breakdown

---

## Task Files

| Agent | Task File | Report File | Purpose |
|-------|-----------|-------------|---------|
| **Archie** | `planning/orchestration/archie/TASK.md` | `planning/orchestration/archie/REPORT.md` | Backend implementation assignments |
| **Faye** | `planning/orchestration/faye/TASK.md` | `planning/orchestration/faye/REPORT.md` | Frontend implementation assignments |
| **Sage** | `planning/orchestration/sage/TASK.md` | `planning/orchestration/sage/REPORT.md` | Code simplification reviews |
| **Orchestrator** | `planning/orchestration/ORCHESTRATOR.md` | (this file) | Session state, phase tracking |

**Archive**: Completed phase specs moved to `planning/orchestration/completed/`

---

## Git Workflow (CRITICAL - SHARED IDE)

### Branch Strategy

| Branch | Owner | Purpose | Lifecycle |
|--------|-------|---------|-----------|
| `main` | CEO | Production-ready code | Never touched by engineers |
| `ALPHA-SPEC-SPRINT` | **ALL ENGINEERS** | Shared feature branch for Phase 1 | All Phase 1 work happens here |

**CRITICAL**: All engineers work on `ALPHA-SPEC-SPRINT` together.
- Coordination through careful file staging, NOT branch switching
- Switching branches affects ALL terminals (shared IDE state)
- Each engineer stages ONLY files they modified in their session

### Engineer Git Rules (GLOBAL - NO EXCEPTIONS)

#### Rule 1: Check What YOU Changed
```bash
# Before staging anything
git status              # See all changes in repo
git diff --name-only    # See which files are modified
git diff path/to/file   # See exact changes in a file
```

#### Rule 2: Stage ONLY YOUR Files
```bash
# Stage files ONE BY ONE with explicit paths
git add src/core/agent/taskQueue.ts       # File YOU modified
git add src/core/agents/chiefOfStaff.ts   # File YOU modified
git add planning/orchestration/archie/REPORT.md  # YOUR report

# Verify before commit
git status   # Should ONLY show YOUR files staged
```

**What NOT to do**:
- ❌ `git add .` (stages everything, including other engineers' work)
- ❌ `git add src/ui/**` (wildcards can catch other engineers' files)
- ❌ `git add -A` (stages all changes)
- ❌ Staging files you didn't modify in THIS session

#### Rule 3: Commit with Clear Message
```bash
git commit -m "type(scope): what you did

- Detail 1
- Detail 2"
```

#### Rule 4: NEVER Switch Branches
```bash
# ❌ NEVER DO THIS - affects all terminals
git checkout other-branch
git switch other-branch

# ✅ You're already on ALPHA-SPEC-SPRINT, stay there
```

#### Rule 5: NEVER Push
```bash
# ❌ NEVER DO THIS - CEO handles all pushes
git push
```

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]
```

**Types**:
- `feat:` - New feature
- `refactor:` - Code restructure (no behavior change)
- `style:` - UI/CSS changes
- `fix:` - Bug fix
- `chore:` - Maintenance (docs, config)

**Examples**:
```bash
# Archie
git commit -m "refactor(storage): Implement time-bucketed action history"

# Faye
git commit -m "style(ui): Add glassmorphism to vitals cards"

# Sage
git commit -m "refactor(agentic): Extract apply-with-undo pattern"
```

---

## Reviewing Engineer Deliverables

When CEO reports an engineer has finished:
1. **Verify commit**: Check `git log --oneline -5` for their commit(s)
2. **Read report**: Read their REPORT.md for completion summary
3. **Run verification**:
   ```bash
   bun run typecheck  # Must pass (no errors)
   bun run build      # Must succeed (no failures)
   ```
4. **Update tracking**: Update phase status table in this file
5. **Quality review**: Check for completeness against TASK.md requirements
6. **Assign Sage**: Route to Sage for code quality review (if not already done)
7. **Advance phase**: Mark phase complete when implementation + simplification done
8. **Report to CEO**: Summarize completion, next steps, blockers (if any)

### Quality Checklist

Before advancing a phase, verify:
- ✅ TypeScript compilation passes (no errors)
- ✅ Build succeeds without warnings
- ✅ All acceptance criteria from TASK.md met
- ✅ REPORT.md documents all changes with line numbers
- ✅ Git commit follows conventional commit format
- ✅ Code simplified by Sage (if applicable)
- ✅ No regression in existing functionality

---

## Phase 0: Pre-Planning (ACTIVE)

**Goal**: Gather context, audit current state, break down Phase 1 work

**Activities**:
1. **User Interview** - Use `/interview` skill to understand priorities
2. **Codebase Audit** - Identify broken functionality, technical debt
3. **Phase 1 Breakdown** - Create detailed TASK.md files for all agents
4. **Success Criteria** - Define acceptance criteria and testing requirements
5. **Risk Assessment** - Identify blockers, dependencies, edge cases

**Deliverables**:
- `planning/orchestration/phase-1-breakdown.md` - Detailed work breakdown
- Updated TASK.md files for Archie, Faye, Sage
- Test plan for Phase 1
- User approval to proceed

---

## Testing Requirements (All Phases)

### Before Starting Phase
1. Verify current build state (`bun run build`)
2. Document baseline functionality
3. Create test checklist in TASK.md

### During Implementation
1. Agents test changes incrementally
2. No commits until basic functionality verified
3. Document test results in REPORT.md

### After Phase Completion
1. **Type Safety**: `bun run typecheck` must pass
2. **Build**: `bun run build` must succeed
3. **Manual Testing**: Test in vault (`/mnt/c/Users/akougk/Projects/vaultex`)
4. **Regression**: Verify no existing features broken
5. **Integration**: Test cross-agent dependencies

### Test Vault Setup
```bash
# Copy plugin to test vault
bun run dev

# In Obsidian:
# 1. Open vaultex
# 2. Reload plugin
# 3. Test functionality
```

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

## Communication Protocol (Company Hierarchy)

### Chief of Staff → Engineers
1. **Assign work**: Update `{engineer}/TASK.md` with clear requirements
2. **Request CEO launch**: Tell CEO to run engineer in terminal
3. **Track progress**: Monitor git commits, read REPORT.md deliverables
4. **Verify quality**: Run typecheck + build, check against acceptance criteria

### Engineers → Chief of Staff (via REPORT.md)
Engineers write structured reports documenting:
- Work completed (with file paths and line numbers)
- Root cause findings (for diagnosis tasks)
- Testing results (what works, what's broken)
- Recommendations (next steps, estimated effort)

### Chief of Staff → CEO
Report in concise status updates:
- **Completed**: What was finished, verification results
- **Blockers**: Any issues preventing progress
- **Next Steps**: What needs to happen next, who does it
- **Approval Needed**: Decisions only CEO can make

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

❌ **Don't spawn subagents** - All agents are separate terminals
❌ **Don't implement code** - Orchestrator plans and coordinates only
❌ **Don't push to remote** - Only local commits
❌ **Don't skip Sage** - Every implementation phase needs simplification
❌ **Don't batch phases** - One at a time, verify each
❌ **Don't merge branches** - User handles merges after track completion
❌ **Don't skip testing** - Every phase requires verification
❌ **Don't create files without approval** - Agents extend existing files first

---

## Recent Commits (Last 10)

```
1955042 chore: Consolidate Faye=frontend, Archie=backend
22ad719 chore: Mark Phase 5 complete, prep for ALPHA-SPEC
ee0607a chore: Add Faye orchestration + project agent overlays
dc40c67 refactor(agentic): Simplify Phase 5 action apply methods
2fc8906 refactor(agentic): Implement Phase 5 time-bucketed actions + diff undo
c427805 refactor(chat): Simplify Phase 4 conversation storage code
f84115c docs(orchestration): Rewrite as session bootstrap document
88d0e83 chore(orchestration): Update tasks for Phase 4 review + Phase 5 impl
2b88ebb chore: Add orchestration system and archive stale docs
9887e74 refactor(chat): Implement per-note conversation storage
```

---

## Current Action Items

**Phase 0 (Pre-Planning) - COMPLETE ✅**

**Completed:**
- [x] Update ORCHESTRATOR.md with 4-agent system
- [x] Conduct user interview (abbreviated - focused on Phase 1)
- [x] Read and analyze ALPHA-SPEC.md
- [x] Audit codebase (Omnibar, QuickActions, Footer)
- [x] Create `planning/orchestration/phase-1-breakdown.md`
- [x] Update Archie TASK.md (Phase 1 diagnosis)
- [x] Update Faye TASK.md (Phase 1 diagnosis)

**Ready to Launch:**
- Phase 1 Stage 1: Diagnosis (Archie + Faye in parallel)

---

## Phase 1 Next Steps

**User Action Required:**
Run both agents in separate terminals:

```bash
# Terminal 1 - Archie (backend diagnosis)
claude "Read and execute planning/orchestration/archie/TASK.md"

# Terminal 2 - Faye (frontend diagnosis)
claude "Read and execute planning/orchestration/faye/TASK.md"
```

**Expected Duration**: 1-2 hours per agent

**Orchestrator Actions After Both Complete:**
1. Read `planning/orchestration/archie/REPORT.md`
2. Read `planning/orchestration/faye/REPORT.md`
3. Identify root cause from combined findings
4. Assign implementation tasks (Stage 2)
5. Coordinate sequential fixes (Archie → Faye)

**Next:**
- Phase 1 Stage 2: Implementation (based on diagnosis)
- Phase 1 Stage 3: Baseline Audit (test all features)
- Phase 1 Stage 4: Simplification (Sage reviews)

---

## Session State & Checkpoint

**Last Updated**: 2026-01-10 16:00
**Current Phase**: Phase 1 Stage 1.5 (Debug Logging Optimization)
**Active Branch**: `ALPHA-SPEC-SPRINT` (all engineers share this branch)
**Build Status**: ✅ Passing (TypeScript + Build verified)

### Phase 1 Progress

| Stage | Status | Engineer | Deliverable |
|-------|--------|----------|-------------|
| 1: Diagnosis | ✅ COMPLETE | Archie + Faye | Both REPORT.md done, commits made |
| 1.5: Logging Cleanup | 🎯 **READY TO LAUNCH** | Sage | Task assigned, ready to start |
| 2: Implementation | ⏸️ PENDING | Archie + Faye | Waiting for Sage completion |
| 3: Baseline Audit | ⏸️ PENDING | Archie + Faye | - |
| 4: Final Simplification | ⏸️ PENDING | Sage | - |

### Stage 1 Findings (COMPLETE)

**Archie's Findings** (commit `bb6f21f`):
- ✅ Root cause: Conditional service registration
- When LM Studio down → agent/taskQueue/workflowRunner not registered
- Cascading failure with silent errors
- No debug logging added (code review only)

**Faye's Findings** (commit `3fcd5e1`):
- ✅ Root cause: useService hook not reactive
- Services initialize after 1-second delay
- Callbacks capture null taskQueue, never update
- Added 13 console.log statements (needs cleanup)

**Combined Root Cause**:
1. Backend: Services conditionally registered based on LM Studio
2. Frontend: useService doesn't trigger re-renders when services available
3. Result: Buttons work, but callbacks have stale null references

### Stage 1.5 Next Action (SAGE)

**Status**: Ready to launch
**Command**: `claude "Read and execute planning/orchestration/sage/TASK.md"`

**Sage's Assignment**:
1. Create `src/utils/debugLog.ts` (simple toggle-able utility)
2. Optimize Faye's 13 console.log statements
3. Reduce to ~6-8 structured logs
4. Add DEBUG_ENABLED flag
5. Commit and report

**Expected Duration**: 1 hour

### After Sage Completes

**Chief of Staff Actions**:
1. Read `planning/orchestration/sage/REPORT.md`
2. Verify commit: `git log --oneline -3`
3. Run build: `bun run typecheck && bun run build`
4. Review debug utility implementation
5. Assign Stage 2 tasks to Archie + Faye (implementation fixes)

### Stage 2 Implementation Tasks (DRAFT)

Based on findings, need to implement:

**Archie**:
- Add explicit logging for skipped service registration
- Improve error messages when LM Studio unavailable
- Consider always-register pattern for graceful degradation

**Faye**:
- Make useService hook reactive (subscribe to services:initialized)
- Force component re-render when services become available
- OR get services inside callbacks (simpler workaround)

**Estimated Effort**: 2-3 hours combined

---

## Resume Instructions for New Session

When you return to orchestrate:

1. **Check current state**:
   ```bash
   git status
   git log --oneline -5
   ```

2. **Read reports**:
   - Archie: `planning/orchestration/archie/REPORT.md`
   - Faye: `planning/orchestration/faye/REPORT.md`
   - Sage: `planning/orchestration/sage/REPORT.md` (if complete)

3. **Determine next action**:
   - If Sage REPORT.md exists → Proceed to Stage 2 (assign Archie + Faye)
   - If Sage REPORT.md missing → Launch Sage (Stage 1.5)

4. **Launch next engineer**:
   ```bash
   # If Sage needed:
   claude "Read and execute planning/orchestration/sage/TASK.md"

   # If Stage 2 ready:
   # Update Archie/Faye TASK.md files first, then launch
   ```

5. **Track progress**: Update this ORCHESTRATOR.md after each stage completes
