# Codebase Archaeology Analysis

**Generated**: 2026-01-12
**Agent**: Claude (Opus 4.5)
**Scope**: `.planning/` documents + git history (50 commits)

---

## Executive Summary

1. **Critical UI freeze bug is fixed** — Infinite loop in `taskQueue.processNext()` resolved (commit eff6f21)
2. **8 infrastructure issues remain** — Documented in Phase 0 PLAN.md, estimated ~14.5 hours
3. **Design is sound, implementation is incomplete** — White House Model architecture is correct; wiring is broken
4. **Hot files indicate instability centers** — App.tsx, chiefOfStaff.ts, taskQueue.ts need stabilization
5. **Recommended cleanup sequence** — Fix action pipeline first (it unblocks everything), then embeddings, then UI polish

---

## Git History Insights

### Turbulence Timeline

The commit history reveals a debugging spiral from 2026-01-10 to 2026-01-12:

```
840b176  EMERGENCY STOP - foundations broken, CPU 100%, UI frozen
6833e0a  wip: emergency phase 0 - paused for external AI review
ad7ddab  minor debug
7e9db42  feat: add native HNSW caching + Phase 0 foundation repair
face696  wip: phase-0 paused - diagnosing HNSW native cache failure
4a5e728  wip: phase-0 paused - ChatAgent eliminated, ready for UAT
a4156a3  wip: phase-0 paused - structured output + architecture interview complete
be425db  wip: phase-0 paused - UI freeze unresolved, SDK migration planned
2c6e44e  wip(phase-0): consolidate debugging attempts + cleanup planning state
d1be292  wip: phase-0 paused - awaiting freeze logs
eff6f21  fix(taskQueue): resolve infinite loop causing UI freeze  ← ROOT CAUSE FIXED
545d0f0  wip: phase-0 paused - UI freeze fixed, cleanup pending
098bd1c  wip: phase-0 cleanup checkpoint
```

**Pattern**: 11 WIP/emergency commits before finding the actual bug. Initial debugging targeted wrong bottlenecks (ChunkStore, HNSW caching) when the real issue was an infinite loop in taskQueue.

### Hot Files (Instability Indicators)

Files modified most frequently in last 50 commits:

| File | Changes | Concern |
|------|---------|---------|
| `src/ui/sidebar/App.tsx` | 9 | UI state management churn |
| `src/core/agents/chiefOfStaff.ts` | 8 | Agent routing logic unstable |
| `src/services/indexManager.ts` | 7 | Index loading experimentation |
| `src/core/agent/taskQueue.ts` | 7 | Queue logic rewritten multiple times |
| `src/ui/sidebar/state/appHandlers.ts` | 6 | Event handling changes |
| `src/services/hnswVectorStore.ts` | 6 | Vector store caching attempts |
| `src/main.ts` | 6 | Startup wiring changes |

**Insight**: The top 4 files represent the core execution path: UI → Agent orchestration → Task queue → Indexing. This entire pipeline was unstable.

### Core File Evolution

**chiefOfStaff.ts** — Massive churn, direction unclear:
```
2aca37e  feat: Multi-Agent System            +707 lines (initial)
eff6f21  fix: infinite loop                  +229/-33  (debugging bloat)
2c6e44e  wip: consolidate debugging          +31/-210  (strip debugging)
098bd1c  wip: cleanup checkpoint             +4/-158   (minimal state)
```

**taskQueue.ts** — Similar pattern:
```
c5cf69e  refactor: Replace NotientAgent      +134 lines
ace3b84  fix: lint warnings                  +203/-131
eff6f21  fix: infinite loop                  +358/-56  (debugging)
098bd1c  wip: cleanup checkpoint             +21/-280  (stripped)
```

**Observation**: Both files went through add-debug-strip cycles. Current state is minimal but needs verification that functionality wasn't lost during cleanup.

### Net Changes (Last 30 Commits)

```
src/core/  →  +2552/-1864 lines (net +688)
```

Major additions:
- `lmstudio-sdk.ts` (+557 lines) — SDK migration attempt
- `actionHistory.ts` (+273 lines) — Action undo system

Major deletions:
- `openai-compatible.ts` (-537 lines) — REST API approach abandoned

---

## Planning Document Synthesis

### Decision Timeline

| Date | Source | Decision |
|------|--------|----------|
| 2026-01-10 | interview-notient-wiring-ux | Quick Actions → triggerAgent(), Progressive search flow defined |
| 2026-01-11 | notient-beta-vision decisions | Priority stack: Reliability → Context → Personal → Community |
| 2026-01-11 | BETA-SPEC.md | All 13 agents ship, Chat is UI not agent, White House Model |
| 2026-01-11 | Phase 0 created | EMERGENCY STOP declared, foundation repair prioritized |
| 2026-01-12 | PLAN.md consolidated | 8 critical issues identified from code audit |

### Phase Status

| Phase | Status | Notes |
|-------|--------|-------|
| **0. Foundation Repair** | IN PROGRESS | 8 issues, ~14.5h estimated |
| 1. Agent Architecture | TBD | Re-scoped, depends on Phase 0 |
| 2. Insights Stream | Blocked | Depends on Phase 0 |
| 3. Agent Command Center | Blocked | Depends on Phase 0 |
| 4. Chat Enhancement | Blocked | Depends on Phase 0 |
| 5. Search Enhancement | Blocked | Depends on Phase 0 |
| 6. Reliability Hardening | Blocked | Depends on Phase 0 |
| 7. Settings Refactor | Blocked | Depends on Phase 0 |
| 8. Personal Validation | Blocked | Depends on all phases |

### Original Intent vs. Reality

**BETA-SPEC Vision**:
- 13 agents (later clarified to 12: Chat is UI)
- Progressive search (INSTANT → EVOLVING → DEEP)
- Insights Stream with proactive suggestions
- Trust levels (low/medium/high) with undo
- Quick Actions triggering agents via ChiefOfStaff

**Current Reality** (from code audit):
- Agents exist but action pipeline is broken
- Progressive search implemented but reranker parsing fails
- Insights Stream "BROKEN" — wiring wrong or missing
- Trust levels implemented but action applier not wired
- Quick Actions produce "Could not find action" errors

---

## Gap Analysis

### Implemented vs. Planned

| Feature | BETA-SPEC | Current State |
|---------|-----------|---------------|
| White House agent model | ✓ Designed | ✓ Implemented (ChiefOfStaff exists) |
| Progressive search | ✓ Designed | ⚠️ Partial (reranker JSON parsing fails) |
| Streaming chat | ✓ Designed | ✓ Working |
| Insights Stream | ✓ Designed | ✗ Broken (nothing appears) |
| Quick Actions | ✓ Designed | ⚠️ Broken (action ID mismatch) |
| Trust levels | ✓ Designed | ⚠️ Exists but not wired |
| Action undo | ✓ Designed | ⚠️ Exists but Apply button broken |
| HNSW vector store | ✓ Designed | ✓ Working (after CODE RED fixes) |

### Design Drift

**Where implementation diverged from design:**

1. **Action ID chaos** — Three different ID systems:
   - TaskQueue: `task.id = "12e561b8-..."`
   - Agent output: `ProposedAction { }` (no ID)
   - ActionApplier: `record.id = "action-1768200138745-xyz"`
   - UI lookup: uses yet another ID → NOT FOUND

2. **Event emission gaps** — `action:proposed` event never emitted, so pending actions UI stays empty

3. **ChatAgent ambiguity** — 248 lines of dead code; Chat flows through ChatService, but ChatAgent class still exists

4. **Reranker bypass** — `<think>` tags from reasoning models break JSON extraction, causing silent search failures

### Technical Debt Identified

From ISSUES.md + git commit messages:

| Issue | Severity | Source |
|-------|----------|--------|
| IndexManager fails on large indices (>512MB) | Critical | ISSUES.md ISSUE-001 |
| IntelligenceDb null reference | Medium | ISSUES.md ISSUE-002 |
| Slow initialization (36s HNSW load) | Medium | ISSUES.md ISSUE-003 |
| Agents don't appear in Agent Streams | High | ISSUES.md ISSUE-004 |
| UI crashes on multiple agent triggers | High | ISSUES.md ISSUE-005 |
| Sequential embeddings (8x slower) | Critical | Phase 0 PLAN Issue 1 |
| FS.syncfs race condition | Low | Phase 0 PLAN Issue 4 |

---

## Recommended Cleanup Sequence

### Priority 1: Fix Action Pipeline (Unblocks Everything)

**Why first**: Quick Actions → Agent Streams → Apply button is the core user flow. Until this works, nothing is testable.

**Files**:
- `src/core/agent/taskQueue.ts` — emit `action:proposed` event
- `src/core/agentic/types.ts` — add `sourceTaskId` to ProposedAction
- `src/main.ts` — wire `action:apply-requested` to ActionApplier

**Validation**: Click "Classify" → Pending action appears → Apply → Note updated

### Priority 2: Fix Reranker JSON Parsing

**Why second**: Search is core functionality. Silent failures degrade user experience.

**Files**:
- `src/core/llm/providers/lmstudio-sdk.ts` — strip `<think>` tags before JSON extraction

**Validation**: Search query → Reranked results → No console warnings

### Priority 3: Parallelize Embeddings

**Why third**: Indexing speed affects perceived quality. 8x improvement possible.

**Files**:
- `src/core/indexer/simpleIndexer.ts` — batch embedding requests

**Validation**: Indexing 895 notes in <2 minutes

### Priority 4: Clean Dead Code

**Why fourth**: Reduces confusion, prevents future bugs.

**Files**:
- DELETE `src/core/agents/chatAgent.ts`
- Remove from `src/core/agents/index.ts`

### Priority 5: Wire Capability Cards

**Why fifth**: Polish, not critical path.

**Files**:
- `src/ui/sidebar/App.tsx` — pass HealthMonitor data to AgentStreamsView

---

## Contradictions & Ambiguities

### Contradictions Found

1. **PRD says 13 agents, BETA-SPEC says 12** — Resolution: Chat is UI, not agent (12 is correct)

2. **Phase numbering inconsistency** — Original plans had Phase 3 as "Insights Stream", current ROADMAP has different ordering

3. **Agent count varies** — Code has more agent types than spec lists (e.g., ContextBuilderAgent, ClassifierAgent)

### Ambiguities

1. **What exactly broke the action pipeline?** — Multiple commits touched it; unclear which introduced the bug

2. **Should ChatAgent class be deleted or repurposed?** — Currently dead code, but was it intentionally deprecated or accidentally orphaned?

3. **Reranker fallback behavior** — When JSON parsing fails, does it silently use vector scores or return empty results?

---

## Source References

| Topic | File | Relevant Section |
|-------|------|------------------|
| Priority stack | `.planning/interviews/notient-beta-vision-1736617200/decisions.md` | Lines 56-68 |
| Current issues | `.planning/phases/00-foundation-repair/PLAN.md` | Lines 18-185 |
| White House Model | `.planning/__original_plans/BETA-SPEC.md` | Lines 49-80 |
| Event handler analysis | `.planning/EVENT_HANDLER_ANALYSIS.md` | Lines 1-116 |
| UAT failures | `.planning/phases/00-foundation-repair/_archive/00-01-ISSUES.md` | Lines 9-65 |
| Git turbulence | `git log --oneline -50` | Commits 840b176 through 0554894 |

---

## Appendix: Git Commands Used

```bash
# Recent commits
git log --oneline -50

# Hot files
git log --oneline -50 --name-only | grep -E "^src/" | sort | uniq -c | sort -rn | head -25

# Turbulence markers
git log --oneline -50 --grep="fix\|wip\|debug\|freeze\|broken\|emergency"

# File evolution
git log --oneline --stat --follow -12 -- <file>

# Net changes
git diff --stat HEAD~30..HEAD -- src/core/
```

---

*Analysis complete. Ready for cleanup execution.*
