# Codebase Archaeology Analysis

**Generated**: 2026-01-12  
**Analyst**: Composer  
**Scope**: `.planning/` directory + git history correlation  
**Analysis Depth**: Deep (48-hour commit-by-commit, full planning folder review, cross-referenced patterns)

---

## Executive Summary

- **Current State**: Phase 0 (Foundation Repair) in progress, 0/8 issues resolved. Codebase shows significant architectural evolution from initial prototype to multi-agent system with progressive search, but foundational stability issues remain. Last 48 hours: 124 commits, massive refactoring around SDK migration and infinite loop fixes.

- **Main Issues**: High churn in core files (`chiefOfStaff.ts`, `taskQueue.ts`, `App.tsx`) indicates architectural instability. Emergency stops (UI freeze, infinite loops) correlate with rapid feature development without sufficient testing. Pattern: reactive debugging cycles rather than systematic resolution.

- **Recommended Focus**: Complete Phase 0 foundation repair before any feature work. Critical path: fix action ID mismatch, wire action applier, then optimize embeddings. Technical debt from CODE RED phase (HNSW migration, error boundaries) mostly complete but integration gaps remain.

- **Key Insight**: The codebase underwent a major architectural shift (REST → SDK migration) during Phase 0, indicating that foundational issues were discovered post-implementation. The infinite loop bug fix (`eff6f21`) was a critical breakthrough, but cleanup and optimization remain.

---

## Git History Insights

### Last 48 Hours: Detailed Commit Analysis

**Total Commits**: 124 commits in last 48 hours  
**Total Changes**: +11,827 insertions, -6,977 deletions = +4,850 net lines  
**Files Changed**: 117 files  
**Pattern**: Intensive debugging and refactoring cycle

#### Hour-by-Hour Breakdown (Last 48 Hours)

**2026-01-12 06:54 - Planning Organization**
- **Commit**: `055489456` - "Organized planning folder"
- **Changes**: 29 files, 600 deletions
- **Impact**: Planning folder restructured, archived documents moved
- **Files**: All `.planning/` files reorganized into `__original_plans/`, `interviews/`, `phases/`

**2026-01-12 06:44 - External Consultant Workflow**
- **Commit**: `7bf9e406` - "chore(planning): add external consultant workflow"
- **Changes**: 2 files, 242 insertions
- **Impact**: Added `.planning/consulting/` directory with `CONSULT-PROMPT.md` and `REQUESTS.md`
- **Purpose**: Formalize external AI consultant review process (used for CODE RED review)

**2026-01-12 06:30 - Planning Cleanup**
- **Commit**: `84d3fc5a` - "chore: cleanup old planning docs UPDATE teh roadmap"
- **Changes**: 14 files, 122 insertions, 2,478 deletions
- **Impact**: Removed stale planning files (`phase-1-breakdown.md`, `phase-2-progressive-search.md`, `orchestration/` docs)
- **Files Deleted**: 9 files totaling 2,132 lines of obsolete planning

**2026-01-12 06:26 - Phase Consolidation**
- **Commit**: `f8bc3f67` - "refactor(planning): consolidate Phase 0 and Phase 1 after code audit"
- **Changes**: 18 files, 935 insertions, 63 deletions
- **Impact**: Created unified Phase 0 plan, archived Phase 1 sub-plans, updated ROADMAP.md
- **Key Change**: Phase 1 issues merged into Phase 0, Phase 1 re-scoped

**2026-01-12 00:50 - Phase 0 Cleanup Checkpoint**
- **Commit**: `098bd1c` - "wip: phase-0 cleanup checkpoint"
- **Changes**: 30 files, 460 insertions, 2,385 deletions
- **Impact**: Massive cleanup: removed 2,385 lines, simplified codebase
- **Key Files**:
  - `taskQueue.ts`: -280 lines (simplified)
  - `chiefOfStaff.ts`: -158 lines (consolidated)
  - `App.tsx`: -236 lines (refactored)
  - `appHandlers.ts`: -286 lines (cleaned up)
  - `Omnibar.tsx`: -316 lines (simplified)
  - `useAppEvents.ts`: -224 lines (reduced)
- **Pattern**: Aggressive simplification after debugging cycles

**2026-01-12 00:39 - Reranker Consolidation**
- **Commit**: `f9d9037b` - "refactor(reranker): consolidate to LLMProvider.rerank()"
- **Changes**: 1 file, 56 insertions, 173 deletions
- **Impact**: Moved reranker logic from `ollamaReranker.ts` service to `lmstudio-sdk.ts` provider
- **Rationale**: Consolidate LLM operations under LLMProvider abstraction

**2026-01-11 23:04 - Phase 0 Pause (UI Freeze Fixed)**
- **Commit**: `545d0f0e` - "wip: phase-0 paused - UI freeze fixed, cleanup pending"
- **Changes**: 2 files, 89 insertions, 83 deletions
- **Impact**: Updated `.planning/STATE.md` and `.continue-here.md` with freeze fix status
- **Status**: Infinite loop fixed, cleanup tasks identified

**2026-01-11 23:01 - Infinite Loop Fix (CRITICAL)**
- **Commit**: `eff6f214` - "fix(taskQueue): resolve infinite loop causing UI freeze"
- **Changes**: 23 files, 2,978 insertions, 1,545 deletions
- **Impact**: **MAJOR BREAKTHROUGH** - Fixed infinite loop causing CPU spike and UI freeze
- **Root Cause**: `taskQueue.processNext()` called `queueMicrotask(() => this.processNext())` unconditionally in `finally` block
- **Fix**: Created `scheduleNextIfQueued()` that only schedules when queue has queued tasks
- **Key Files**:
  - `taskQueue.ts`: +358 lines, -56 lines (infinite loop fix, extracted helpers)
  - `lmstudio-sdk.ts`: +674 lines (new SDK provider, replaces REST)
  - `App.tsx`: +337 lines, -76 lines (event handler fixes)
  - `useAppEvents.ts`: +507 lines, -207 lines (queueMicrotask wrappers)
  - `appHandlers.ts`: +189 lines, -8 lines (handler fixes)
  - `kernel.ts`: +128 lines, -44 lines (service initialization fixes)
  - `chiefOfStaff.ts`: +229 lines, -33 lines (routing fixes)
- **Also Fixed**: Removed `openai-compatible.ts` (-616 lines), removed `lmstudio.ts` service (-358 lines)
- **Pattern**: SDK migration + infinite loop fix in single commit (high risk, high reward)

**2026-01-11 22:43 - Phase 0 Pause (Awaiting Logs)**
- **Commit**: `d1be2927` - "wip: phase-0 paused - awaiting freeze logs"
- **Changes**: 2 files, 115 insertions, 111 deletions
- **Impact**: Updated planning docs with debugging status
- **Context**: User testing with instrumented build to capture freeze logs

**2026-01-11 21:26 - Intelligence Migration**
- **Commit**: `bd6831ee` - "refactor(intelligence): migrate to LLMProvider from LMStudioService"
- **Changes**: 4 files, 48 insertions, 85 deletions
- **Impact**: Migrated `actionOrchestrator.ts` and `actionPipeline.ts` from `LMStudioService` to `LLMProvider`
- **Pattern**: Continuing migration from service layer to provider abstraction

**2026-01-11 21:25 - Search Migration**
- **Commit**: `9bb2f668` - "refactor(search): remove legacy LMStudioService from search strategies"
- **Changes**: 2 files, 6 insertions, 20 deletions
- **Impact**: Removed `LMStudioService` usage from `balanced.ts` and `deep.ts` search strategies
- **Pattern**: Completing provider abstraction migration

**2026-01-11 21:07 - Planning Cleanup**
- **Commit**: `9ac12de7` - "chore: cleanup stale planning files"
- **Changes**: 9 files, 2,132 deletions
- **Impact**: Removed obsolete planning documents (`DEBUG-PROMPT-EXTERNAL.md`, `EMERGENCY-STOP.md`, `codebase/` directory)
- **Rationale**: Planning folder consolidation

**2026-01-11 21:01 - SDK Migration Plan**
- **Commit**: `f66addcb` - "docs(phase-0): add 00-03-PLAN for SDK migration"
- **Changes**: 4 files, 190 insertions, 16 deletions
- **Impact**: Created plan for migrating from REST API to native SDKs
- **Rationale**: REST API unreliable for debugging UI freezes, SDKs provide better async handling

**2026-01-11 20:59 - Phase 0 Consolidation**
- **Commit**: `2c6e44e` - "wip(phase-0): consolidate debugging attempts + cleanup planning state"
- **Changes**: 20 files, 827 insertions, 1,611 deletions
- **Impact**: Consolidated debugging attempts, cleaned up planning state
- **Key Files**:
  - `hnswVectorStore.ts`: +185 lines, -431 lines (native cache fixes)
  - `ollamaReranker.ts`: +29 lines, -263 lines (consolidated)
  - `chiefOfStaff.ts`: +31 lines, -210 lines (simplified)
  - `thinkingParser.ts`: +55 lines, -102 lines (improved)
- **Pattern**: Consolidation after multiple debugging attempts

**2026-01-11 20:47 - Phase 0 Pause (SDK Migration Planned)**
- **Commit**: `be425dbc` - "wip: phase-0 paused - UI freeze unresolved, SDK migration planned"
- **Changes**: 2 files, 74 insertions, 137 deletions
- **Impact**: Updated planning docs with SDK migration decision
- **Context**: After 8 rounds of debugging REST API, decision made to migrate to SDKs

**2026-01-11 20:14 - Phase 0 Pause (Architecture Interview)**
- **Commit**: `a4156a34` - "wip: phase-0 paused - structured output + architecture interview complete"
- **Changes**: 5 files, 258 insertions, 58 deletions
- **Impact**: Added input flow interview documents, updated planning state
- **Context**: External architecture review completed

**2026-01-11 19:39 - Phase 0 Pause (ChatAgent Eliminated)**
- **Commit**: `4a5e7288` - "wip: phase-0 paused - ChatAgent eliminated, ready for UAT"
- **Changes**: 1 file, 64 insertions, 59 deletions
- **Impact**: Updated planning docs with ChatAgent elimination status
- **Context**: Plan 01-01 completed, ready for user acceptance testing

**2026-01-11 18:55 - Phase 0 Pause (HNSW Cache Failure)**
- **Commit**: `face696b` - "wip: phase-0 paused - diagnosing HNSW native cache failure"
- **Changes**: 3 files, 256 insertions
- **Impact**: Added HNSW cache failure diagnosis to planning docs
- **Context**: Native cache implementation failing, investigating root cause

**2026-01-11 18:47 - HNSW Batching Fix**
- **Commit**: `f71a19de` - "perf(00-01-fix): batch HNSW metadata loading with timing metrics"
- **Changes**: 1 file, 67 insertions, 36 deletions
- **Impact**: Added batched processing for HNSW metadata loading (1000 docs per batch with yields)
- **Rationale**: Fix 36-second bottleneck in `loadFromDataAsync()`
- **Pattern**: Performance optimization with batching and yielding

**2026-01-11 18:45 - UAT Issues Logged**
- **Commit**: `7cb12e24` - "docs(00-01): log UAT issues - HNSW is real bottleneck"
- **Changes**: 1 file, 74 insertions
- **Impact**: Documented UAT issues: HNSW 36s bottleneck, Quick Actions double-click, UI crashes
- **Context**: User acceptance testing revealed real bottlenecks

**2026-01-11 18:35 - Async Loading Plan Complete**
- **Commit**: `96a41207` - "docs(00-01): complete async loading bottlenecks plan"
- **Changes**: 4 files, 140 insertions, 41 deletions
- **Impact**: Completed Phase 0 Plan 1 summary, updated ROADMAP.md and STATE.md
- **Status**: Plan 00-01 complete, but UAT revealed new issues

**2026-01-11 18:34 - Startup Progress Events**
- **Commit**: `c5a5caf4` - "feat(00-01): add progress events during startup"
- **Changes**: 2 files, 20 insertions, 12 deletions
- **Impact**: Added stage-based startup progress logging (Stage 1-4 with timing)
- **Files**: `chunkStore.ts`, `indexManager.ts`

**2026-01-11 18:33 - IndexManager JSON Yielding**
- **Commit**: `3c25b10f` - "perf(00-01): yield before IndexManager JSON parsing"
- **Changes**: 1 file, 5 insertions
- **Impact**: Added `setTimeout(0)` yield before heavy JSON.parse operations
- **Rationale**: Prevent UI freeze during large index file parsing

**2026-01-11 18:32 - ChunkStore Parallel Loading**
- **Commit**: `a0329254` - "perf(00-01): parallelize ChunkStore file loading"
- **Changes**: 1 file, 40 insertions, 6 deletions
- **Impact**: Changed from sequential `await` to batched `Promise.all()` (50 files per batch)
- **Rationale**: Speed up chunk loading from sequential to parallel

**2026-01-11 18:29 - Foundation Repair Plans**
- **Commit**: `5d0c3f8d` - "docs(phase-0): create foundation repair plans"
- **Changes**: 2 files, 444 insertions
- **Impact**: Created Phase 0 Plan 1 (async loading) and Plan 2 (validation)
- **Context**: Formal planning for foundation repair phase

**2026-01-11 18:25 - HNSW Native Caching**
- **Commit**: `7e9db421` - "feat: add native HNSW caching + Phase 0 foundation repair"
- **Changes**: 6 files, 333 insertions, 33 deletions
- **Impact**: Added native HNSW caching, updated ROADMAP.md and STATE.md
- **Files**: `hnswVectorStore.ts`, `indexManager.ts`, `vectorStore.ts`, `types/index.ts`
- **Pattern**: Performance optimization + planning update

**2026-01-11 12:56 - Minor Debug**
- **Commit**: `ad7ddab9` - "minor debug"
- **Changes**: 3 files, 40 insertions, 16 deletions
- **Impact**: Minor debugging changes to `openai-compatible.ts`, `ollamaReranker.ts`, `types/index.ts`

**2026-01-11 11:56 - Emergency Phase 0 (External Review)**
- **Commit**: `6833e0a` - "wip: emergency phase 0 - paused for external AI review"
- **Changes**: 3 files, 1,034 insertions, 3 deletions
- **Impact**: Added external consultant review prompt (`DEBUG-PROMPT-EXTERNAL.md`), updated planning state
- **Context**: After emergency stop, external AI consultant (Gemini) review initiated
- **Result**: CODE RED assignments (Archie: HNSW, Faye: Error Boundaries)

**2026-01-11 11:20 - EMERGENCY STOP**
- **Commit**: `840b1761` - "wip: EMERGENCY STOP - foundations broken, CPU 100%, UI frozen"
- **Changes**: 2 files, 221 insertions, 49 deletions
- **Impact**: Created `EMERGENCY-STOP.md`, updated `STATE.md` with emergency status
- **Context**: Foundations broken, CPU at 100%, UI frozen
- **Trigger**: Rapid feature development without sufficient testing
- **Result**: CODE RED phase initiated

**2026-01-11 11:12 - Lint Fixes**
- **Commit**: `ace3b84b` - "fix: resolve all lint warnings across codebase"
- **Changes**: 42 files, 3,317 insertions, 2,141 deletions
- **Impact**: Massive lint fix across entire codebase
- **Pattern**: Code quality cleanup before emergency stop
- **Files**: All core files, UI components, services

**2026-01-11 10:35 - Thinking Model Fixes Paused**
- **Commit**: `fb20cdf0` - "wip: thinking model fixes paused - temp adjustment, tag stripping, balanced JSON"
- **Changes**: 1 file, 78 insertions, 102 deletions
- **Impact**: Updated Phase 1 planning with thinking model fixes status
- **Context**: Working on thinking model output parsing

**2026-01-11 10:06 - Git Infrastructure Docs**
- **Commit**: `d8d4b93c` - "docs: add git infrastructure and worktree documentation"
- **Changes**: 1 file, 56 insertions
- **Impact**: Added `.claude/CLAUDE.md` with git infrastructure documentation

**2026-01-11 10:05 - Phase 1 Hotfixes**
- **Commit**: `2fb300ff` - "fix(01-03): post-phase-1 hotfixes"
- **Changes**: 8 files, 115 insertions, 15 deletions
- **Impact**: Post-Phase 1 hotfixes: agent routing, dev mode, boot issues
- **Files**: `package.json`, `build.ts`, `taskQueue.ts`, `main.ts`, `noteVitalsCalculator.ts`, `settings.ts`, `App.tsx`, `QuickActions.tsx`

**2026-01-11 10:03 - Phase 1 Hotfixes Paused**
- **Commit**: `e1043217` - "wip: phase-1 hotfixes paused - agent routing, dev mode, boot issues"
- **Changes**: 4 files, 463 insertions, 17 deletions
- **Impact**: Created `ISSUES.md`, updated planning state with hotfix status
- **Context**: Phase 1 complete but issues discovered, hotfixes needed

**2026-01-11 09:20 - Lint Fixes (Phase 1)**
- **Commit**: `05a50085` - "fix(01-03): resolve lint errors across codebase"
- **Changes**: 11 files, 45 insertions, 20 deletions
- **Impact**: Lint fixes for Phase 1 Plan 3
- **Files**: `biome.json`, `actionPipeline.ts`, `main.ts`, `indexManager.ts`, `App.tsx`, UI components

**2026-01-11 09:14 - Lint Fixes**
- **Commit**: `969c3425` - "fix: resolve lint errors across codebase"
- **Changes**: 42 files, 143 insertions, 128 deletions
- **Impact**: Comprehensive lint fixes across codebase
- **Pattern**: Code quality maintenance

**2026-01-11 09:07 - Quick Actions Structure**
- **Commit**: `fb13b862` - "feat(01-03): implement pinned + contextual Quick Actions structure"
- **Changes**: 2 files, 225 insertions, 103 deletions
- **Impact**: Implemented 3 pinned + 3 contextual Quick Actions model
- **Files**: `App.tsx`, `QuickActions.tsx`
- **Status**: Plan 01-03 complete

**2026-01-11 09:06 - AgenticTaskType Update**
- **Commit**: `8c7b6f7c` - "feat(01-03): update AgenticTaskType to use agent names"
- **Changes**: 5 files, 93 insertions, 67 deletions
- **Impact**: Updated `AgenticTaskType` to use agent names instead of generic types
- **Files**: `types.ts`, `insightGenerator.ts`, `App.tsx`, `QuickActions.tsx`, `appHandlers.ts`
- **Context**: Part of Plan 01-03 (Quick Actions rewiring)

**2026-01-11 09:01 - Connection Agent Plan Complete**
- **Commit**: `a94400e4` - "docs(01-02): complete connection agent rename plan"
- **Changes**: 3 files, 126 insertions, 12 deletions
- **Impact**: Completed Phase 1 Plan 2 summary, updated ROADMAP.md and STATE.md
- **Status**: Plan 01-02 complete

**2026-01-11 08:59 - Connection Agent Routing**
- **Commit**: `37c67822` - "refactor(01-02): update ChiefOfStaff routing for connection agent"
- **Changes**: 6 files, 19 insertions, 19 deletions
- **Impact**: Updated ChiefOfStaff routing to use `connection` instead of `link-finder`
- **Files**: `README.md`, `agentIdentity.ts`, `chiefOfStaff.ts`, `index.ts`, `types.ts`, `workflowAgents.ts`
- **Context**: Part of Plan 01-02 (Connection agent rename)

**2026-01-11 08:57 - LinkFinder → Connection Rename**
- **Commit**: `069c600e` - "refactor(01-02): rename LinkFinderAgent class to ConnectionAgent"
- **Changes**: 5 files, 42 insertions, 37 deletions
- **Impact**: Renamed `LinkFinderAgent` class to `ConnectionAgent`, updated imports
- **Files**: `taskQueue.ts`, `agentIdentity.ts`, `linkFinderAgent.ts` → `connectionAgent.ts`, `index.ts`, `modelSelector.ts`
- **Context**: Part of Plan 01-02 (Connection agent rename)

**2026-01-11 08:54 - Link-Finder Type Rename**
- **Commit**: `29d3b0be` - "refactor(01-02): rename link-finder type to connection"
- **Changes**: 1 file, 10 insertions, 5 deletions
- **Impact**: Renamed `link-finder` type to `connection` in `types.ts`
- **Context**: Part of Plan 01-02 (Connection agent rename)

**2026-01-11 08:52 - Chat as UI Plan Complete**
- **Commit**: `fbf4f662` - "docs(01-01): complete Chat as UI layer plan"
- **Changes**: 3 files, 122 insertions, 14 deletions
- **Impact**: Completed Phase 1 Plan 1 summary, updated ROADMAP.md and STATE.md
- **Status**: Plan 01-01 complete

**2026-01-11 08:50 - Chat UI Role Clarification**
- **Commit**: `8d243fd0` - "feat(01-01): update agentIdentity to clarify Chat's UI role"
- **Changes**: 2 files, 67 insertions, 25 deletions
- **Impact**: Updated `agentIdentity.ts` to clarify Chat's UI role (not an agent)
- **Files**: `agentIdentity.ts`, `chiefOfStaff.ts`
- **Context**: Part of Plan 01-01 (Chat as UI layer)

**2026-01-11 08:49 - UI Request Helper**
- **Commit**: `83f811e0` - "feat(01-01): add isUIRequest helper to ChiefOfStaff routing"
- **Changes**: 1 file, 89 insertions, 2 deletions
- **Impact**: Added `isUIRequest()` helper to ChiefOfStaff for routing UI vs Expert requests
- **Files**: `chiefOfStaff.ts`
- **Context**: Part of Plan 01-01 (Chat as UI layer)

**2026-01-11 08:48 - UI vs Expert Distinction**
- **Commit**: `22651c92` - "feat(01-01): add UI vs Expert agent distinction to type system"
- **Changes**: 1 file, 44 insertions, 4 deletions
- **Impact**: Added `isUI` flag to agent types to distinguish UI agents from Expert agents
- **Files**: `types.ts`
- **Context**: Part of Plan 01-01 (Chat as UI layer)

**2026-01-11 08:45 - Phase 1 Plans Created**
- **Commit**: `932760b5` - "docs(01): create phase plans for Agent Architecture"
- **Changes**: 5 files, 377 insertions, 5 deletions
- **Impact**: Created Phase 1 plans: 01-01 (Chat as UI), 01-02 (Connection rename), 01-03 (Quick Actions)
- **Files**: `ROADMAP.md`, `STATE.md`, `01-01-PLAN.md`, `01-02-PLAN.md`, `01-03-PLAN.md`

**2026-01-11 08:39 - Beta Roadmap Initialized**
- **Commit**: `425700bf` - "docs: initialize Notient Beta roadmap (8 phases)"
- **Changes**: 2 files, 205 insertions
- **Impact**: Created `ROADMAP.md` with 8 phases (00-08)
- **Context**: Formal roadmap creation

**2026-01-11 08:36 - Notient Beta Initialized**
- **Commit**: `9d932bda` - "docs: initialize Notient Beta"
- **Changes**: 2 files, 135 insertions
- **Impact**: Created `PROJECT.md` and `config.json` for Notient Beta
- **Context**: Beta phase formalization

**2026-01-11 06:59 - Codebase Mapping**
- **Commit**: `77fad795` - "docs: map existing codebase"
- **Changes**: 7 files, 1,057 insertions
- **Impact**: Created comprehensive codebase documentation (`ARCHITECTURE.md`, `CONCERNS.md`, `CONVENTIONS.md`, `INTEGRATIONS.md`, `STACK.md`, `STRUCTURE.md`, `TESTING.md`)
- **Context**: Initial codebase archaeology

#### Patterns Identified in Last 48 Hours

1. **Reactive Debugging Cycles**: Multiple "wip: phase-0 paused" commits indicate iterative debugging rather than systematic resolution
2. **SDK Migration**: Major architectural shift from REST API to native SDKs (`lmstudio-sdk.ts` added, `openai-compatible.ts` removed)
3. **Infinite Loop Breakthrough**: Single commit (`eff6f21`) fixed critical bug but also migrated entire LLM provider layer
4. **Planning Consolidation**: Multiple commits consolidating planning documents, removing stale docs
5. **Performance Optimization**: Focus on batching, yielding, and parallelization (HNSW, ChunkStore, IndexManager)
6. **Code Quality**: Multiple lint fix commits, indicating ongoing code quality maintenance

### Turbulence Timeline (Extended)

**Emergency Stops & Debugging Cycles:**

1. **840b176** (2026-01-11 11:20) - `wip: EMERGENCY STOP - foundations broken, CPU 100%, UI frozen`
   - **Preceded by**: Rapid feature development (Phase 1-2 orchestration work)
   - **Triggered**: CODE RED phase (HNSW migration, error boundaries, App.tsx refactor)
   - **Impact**: Complete halt of feature work, focus on foundation repair
   - **Result**: External consultant review, CODE RED assignments

2. **6833e0a** (2026-01-11 11:56) - `wip: emergency phase 0 - paused for external AI review`
   - **Context**: External consultant review (Gemini) identified architectural issues
   - **Result**: CODE RED assignments (Archie: HNSW, Faye: Error Boundaries)
   - **Impact**: Formalized external review process, created consultant workflow

3. **eff6f21** (2026-01-11 23:01) - `fix(taskQueue): resolve infinite loop causing UI freeze`
   - **Critical Fix**: Infinite loop in `taskQueue.processNext()`
   - **Root Cause**: `queueMicrotask(() => this.processNext())` in `finally` block ran unconditionally
   - **Fix**: Created `scheduleNextIfQueued()` that only schedules when queue has queued tasks
   - **Impact**: UI freeze resolved, CPU spike eliminated
   - **Also**: SDK migration in same commit (high risk, high reward)
   - **Followed by**: Multiple "wip: phase-0 paused" commits indicating ongoing instability

4. **Multiple "wip: phase-0 paused" commits**:
   - `545d0f0` (2026-01-11 23:04) - "UI freeze fixed, cleanup pending"
   - `d1be292` (2026-01-11 22:43) - "awaiting freeze logs"
   - `be425db` (2026-01-11 20:47) - "UI freeze unresolved, SDK migration planned"
   - `a4156a3` (2026-01-11 20:14) - "structured output + architecture interview complete"
   - `4a5e728` (2026-01-11 19:39) - "ChatAgent eliminated, ready for UAT"
   - `face696` (2026-01-11 18:55) - "diagnosing HNSW native cache failure"
   - **Pattern**: Fix attempt → pause → await logs/review → next attempt
   - **Indicates**: Reactive debugging rather than systematic resolution

**Pattern Analysis:**
- Emergency stops cluster around UI freeze issues (taskQueue, event handlers)
- Each emergency followed by "paused" commits suggests insufficient root cause analysis
- CODE RED phase (2026-01-11) was architectural reset, not incremental fix
- Infinite loop fix was breakthrough but cleanup remains incomplete
- SDK migration was high-risk change made during debugging cycle

### Hot Files (Instability Indicators)

**Most Modified Files (Last 50 commits):**

| File | Modifications | Reason |
|------|---------------|--------|
| `src/ui/sidebar/App.tsx` | 9 | UI orchestration hub, event handler wiring, CODE RED refactor target |
| `src/core/agents/chiefOfStaff.ts` | 8 | Core routing logic, agent delegation, multiple architectural iterations |
| `src/services/indexManager.ts` | 7 | Index management, HNSW integration, storage path changes |
| `src/core/agent/taskQueue.ts` | 7 | Task execution, infinite loop fix, event emission wiring |
| `src/ui/sidebar/state/appHandlers.ts` | 6 | Event handlers, signal mutations, queueMicrotask fixes |
| `src/ui/sidebar/components/QuickActions.tsx` | 6 | Quick Actions rewiring, agent routing changes |
| `src/services/ollamaReranker.ts` | 6 | Reranker JSON parsing issues, thinking model handling |
| `src/services/hnswVectorStore.ts` | 6 | HNSW migration, native caching, FS.syncfs race fixes |

**Most Modified Files (Last 48 hours):**

| File | Modifications | Net Change | Key Commits |
|------|---------------|------------|-------------|
| `src/ui/sidebar/App.tsx` | 19 | -899 lines | eff6f21 (+337/-76), 098bd1c (-236), 2c6e44e (-15) |
| `src/services/indexManager.ts` | 11 | +360 lines | eff6f21, 098bd1c, c5a5caf, 3c25b10, a032925 |
| `src/main.ts` | 11 | -456 lines | eff6f21 (+11/-43), 098bd1c (-15), multiple refactors |
| `src/ui/sidebar/state/appHandlers.ts` | 10 | +293 lines | eff6f21 (+189/-8), 098bd1c (-286), 2c6e44e (-36) |
| `src/ui/sidebar/components/QuickActions.tsx` | 10 | +227 lines | fb13b86 (+209/-95), 8c7b6f7 (+42/-50), multiple fixes |
| `src/services/hnswVectorStore.ts` | 10 | +435 lines | eff6f21, 2c6e44e (+185/-431), f71a19de (+67/-36), 7e9db421 |
| `src/ui/sidebar/hooks/useAppEvents.ts` | 9 | +283 lines | eff6f21 (+507/-207), 098bd1c (-224), 2c6e44e (+14/-11) |
| `src/core/agent/taskQueue.ts` | 8 | +125 lines | eff6f21 (+358/-56), 098bd1c (-280), 2c6e44e (+35/-11) |
| `src/core/agents/chiefOfStaff.ts` | 8 | -38 lines | eff6f21 (+229/-33), 098bd1c (-158), 2c6e44e (+31/-210) |
| `src/core/kernel.ts` | 5 | +84 lines | eff6f21 (+128/-44), 098bd1c (-89) |

**Insights:**
- UI layer (`App.tsx`) and orchestration (`chiefOfStaff.ts`, `taskQueue.ts`) show highest churn
- Service layer (`indexManager`, `hnswVectorStore`) churn from CODE RED migration and performance fixes
- Event handler churn (`appHandlers.ts`, `useAppEvents.ts`) correlates with UI freeze fixes
- Net negative changes in `App.tsx` (-899 lines) indicate successful refactoring
- `hnswVectorStore.ts` shows high churn (+435 lines) from native caching and batching fixes

### Core File Evolution (Deep Dive)

#### `src/core/agents/chiefOfStaff.ts`

**Evolution Pattern:**
- **Initial**: 707 lines added (2aca37e) - Multi-Agent System (White House Model)
- **Refactor**: 63 lines added (57046fd) - UI architecture consolidation
- **Expansion**: 91 lines added (83f811e) - `isUIRequest` helper, routing logic
- **Cleanup**: 158 lines removed (098bd1c) - Phase 0 cleanup checkpoint
- **Fix**: 229 lines added (eff6f21) - Infinite loop resolution, expanded routing
- **Consolidation**: 210 lines removed (2c6e44e) - Debugging attempts cleanup

**Key Changes:**
- Routing logic evolved from simple delegation to complex intent detection
- UI vs Expert agent distinction added (Plan 01-01)
- Connection agent rename (Plan 01-02) integrated
- Multiple debugging cycles suggest routing logic is fragile
- Net change: -38 lines over last 48 hours (consolidation)

**Current State**: ~500 lines, handles UI routing, expert delegation, context building

**Architectural Decisions:**
- Two-tier routing: UI requests bypass agent system, expert requests route to agents
- Intent detection: `isUIRequest()` helper determines routing path
- Context building: Dynamic context assembly per request
- Event emission: Emits routing decisions for debugging

#### `src/core/kernel.ts`

**Evolution Pattern:**
- **Initial**: Service registry foundation
- **Expansion**: Multiple service registrations (HNSW, ProgressiveSearch, Import Bridge, Reranker)
- **Cleanup**: 89 lines removed (098bd1c) - Phase 0 simplification
- **Fix**: 128 lines added (eff6f21) - Service initialization fixes

**Key Changes:**
- Service registration pattern stabilized
- HNSW integration added during CODE RED
- Progressive search orchestrator integration
- Import bridge service added
- SDK migration: Removed REST-based services, added SDK providers

**Current State**: ~200 lines, core service orchestration hub

**Architectural Decisions:**
- Dependency injection via `kernel.get<T>(ServiceName)`
- Startup orchestration with health checks
- Graceful degradation: Services register even if dependencies unavailable
- Service lifecycle: Initialize → Register → Health Check → Ready

#### `src/core/agent/taskQueue.ts`

**Evolution Pattern:**
- **Initial**: 147 lines added (c5cf69e) - Task queue foundation
- **Expansion**: 414 lines added (eff6f21) - Infinite loop fix, expanded logic
- **Cleanup**: 280 lines removed (098bd1c) - Phase 0 simplification
- **Refactor**: 203 lines added (ace3b84) - Lint fixes, code organization

**Key Changes:**
- Infinite loop in `processNext()` fixed (critical bug)
- Event emission wiring added/removed multiple times
- Action extraction logic evolved
- Service registration fixes (4810494)
- Helper extraction: `runTask()`, `scheduleNextIfQueued()` for complexity reduction

**Current State**: ~400 lines, sequential task execution with event emission

**Critical Bug Fix (eff6f21):**
```typescript
// BEFORE (broken):
finally {
  queueMicrotask(() => this.processNext()); // Always runs, even when queue empty
}

// AFTER (fixed):
finally {
  this.scheduleNextIfQueued(); // Only schedules if queue has queued tasks
}

scheduleNextIfQueued(): void {
  if (this.tasks.some(t => t.status === "queued")) {
    queueMicrotask(() => this.processNext());
  }
}
```

**Architectural Decisions:**
- Sequential execution: One task at a time (predictable, debuggable)
- Event emission: Emits task lifecycle events for UI updates
- Error handling: Tasks fail gracefully, don't crash queue
- Action extraction: Extracts proposed actions from task results

#### `src/ui/sidebar/App.tsx`

**Evolution Pattern:**
- **Initial**: 1300+ lines (CODE RED target)
- **Refactor**: 236 lines removed (098bd1c) - Phase 0 cleanup
- **Expansion**: 337 lines added (eff6f21) - Event handler fixes
- **Consolidation**: 15 lines removed (2c6e44e) - Debugging cleanup

**Key Changes:**
- CODE RED goal: reduce to <500 lines (status unclear from git)
- Event handler wiring evolved (queueMicrotask fixes)
- Quick Actions integration (Plan 01-03)
- Agent Streams wiring
- Net change: -899 lines over last 48 hours (successful refactoring)

**Current State**: Likely still >500 lines, needs verification

**Architectural Decisions:**
- Hooks-based architecture: `useAppEvents`, `useNoteVitals`
- Event-driven UI: Subscribes to EventBus, reacts to events
- Error boundaries: Wraps components to prevent crashes
- State management: Uses signals for reactive updates

#### `src/core/llm/providers/lmstudio-sdk.ts`

**Evolution Pattern:**
- **Created**: 674 lines added (eff6f21) - New SDK provider
- **Refactor**: 56 lines added, 173 lines removed (f9d9037b) - Reranker consolidation

**Key Changes:**
- Replaced REST API (`openai-compatible.ts`) with native SDK (`@lmstudio/sdk`)
- Supports streaming completions
- Supports structured output (JSON schema)
- Handles thinking models (reasoning_content)
- Abort signal support
- Reranker integration (moved from `ollamaReranker.ts`)

**Current State**: ~557 lines, complete LLM provider implementation

**Architectural Decisions:**
- Native SDK over REST: Better async handling, error messages, no HTTP overhead
- Streaming first: All completions stream by default
- Structured output: JSON schema validation built-in
- Thinking model support: Extracts reasoning_content from thinking models

#### `src/services/hnswVectorStore.ts`

**Evolution Pattern:**
- **Initial**: HNSW migration (CODE RED)
- **Expansion**: Native caching added (7e9db421)
- **Refactor**: Batching added (f71a19de)
- **Consolidation**: Cleanup (2c6e44e)

**Key Changes:**
- Native caching: Caches HNSW index in IndexedDB
- Batched loading: Processes 1000 documents per batch with yields
- FS.syncfs race fixes: Prevents multiple sync operations
- Performance: Reduced load time from 36s to <3s (target)

**Current State**: ~866 lines, complete HNSW vector store with native caching

**Architectural Decisions:**
- WASM HNSW: High-performance approximate nearest neighbor search
- Native caching: Persists index to IndexedDB for fast startup
- Batched processing: Prevents UI freeze during large index loads
- Yielding: `setTimeout(0)` between batches to keep UI responsive

### Net Changes in `src/core/` (Last 30 Commits)

**Summary**: +2,552 insertions, -1,864 deletions = +688 net lines

**Major Additions:**
- `src/core/llm/providers/lmstudio-sdk.ts` - 557 lines (new SDK provider)
- `src/core/agents/base.ts` - 192 lines (agent base class expansion)
- `src/core/agents/chiefOfStaff.ts` - 495 lines modified (routing evolution)
- `src/core/agent/taskQueue.ts` - 485 lines modified (execution logic)
- `src/core/agents/contextBuilderAgent.ts` - 235 lines modified (context building)

**Major Removals:**
- `src/core/llm/providers/openai-compatible.ts` - 537 lines deleted (replaced by SDK)
- `src/core/agentic/commandParser.ts` - 46 lines deleted (consolidated)

**Insights:**
- LLM provider abstraction evolved (OpenAI-compatible → LM Studio SDK)
- Agent base class expanded (likely for better type safety)
- Core orchestration files grew significantly (routing complexity)
- Net positive growth indicates feature expansion, not just refactoring

### Net Changes in `src/` (Last 124 Commits)

**Summary**: +11,827 insertions, -6,977 deletions = +4,850 net lines

**Major Additions:**
- `src/core/llm/providers/lmstudio-sdk.ts` - 557 lines (new SDK provider)
- `src/services/hnswVectorStore.ts` - 866 lines (HNSW with native caching)
- `src/services/chunkStore.ts` - 227 lines (parallel loading)
- `src/services/indexManager.ts` - 403 lines (staged initialization)
- `src/ui/sidebar/hooks/useAppEvents.ts` - 547 lines (event hooks)
- `src/ui/sidebar/state/appHandlers.ts` - 579 lines (event handlers)

**Major Removals:**
- `src/core/llm/providers/openai-compatible.ts` - 537 lines deleted (replaced by SDK)
- `src/services/lmstudio.ts` - 358 lines deleted (replaced by SDK)
- `src/services/simpleVectorStore.ts` - 662 lines deleted (replaced by HNSW)
- `src/services/ollamaReranker.ts` - 245 lines deleted (consolidated into SDK)

**Insights:**
- Massive architectural shift: REST → SDK, SimpleVectorStore → HNSW
- UI layer refactored: Hooks extracted, handlers consolidated
- Net positive growth indicates feature expansion alongside refactoring
- Service layer consolidation: Fewer services, more capabilities per service

---

## Planning Document Synthesis

### Decision Timeline (Chronological)

**2026-01-11 06:59 - Codebase Mapping**
- **Decision**: Map existing codebase before Beta phase
- **Impact**: Created comprehensive documentation (`ARCHITECTURE.md`, `CONCERNS.md`, `CONVENTIONS.md`, etc.)
- **Source**: `.planning/codebase/` directory (now archived)

**2026-01-11 08:36 - Notient Beta Initialization**
- **Decision**: Formalize Beta phase with structured planning
- **Impact**: Created `PROJECT.md` and `config.json`
- **Source**: `.planning/PROJECT.md`

**2026-01-11 08:39 - Beta Roadmap Creation**
- **Decision**: 8-phase roadmap (00-08)
- **Impact**: Created `ROADMAP.md` with sequential phases
- **Source**: `.planning/ROADMAP.md`

**2026-01-11 08:45 - Phase 1 Plans Created**
- **Decision**: Three sub-plans for Agent Architecture phase
  - Plan 01-01: Chat as UI layer
  - Plan 01-02: Connection agent rename
  - Plan 01-03: Quick Actions rewiring
- **Impact**: Formalized Phase 1 execution plan
- **Source**: `.planning/phases/01-agent-architecture/01-*-PLAN.md`

**2026-01-11 11:20 - EMERGENCY STOP**
- **Decision**: Halt all feature work, focus on foundation repair
- **Impact**: CODE RED phase initiated, external consultant review
- **Source**: `.planning/EMERGENCY-STOP.md` (now archived)

**2026-01-11 11:56 - CODE RED Architecture Review**
- **Decision**: WASM HNSW only (no Docker sidecar)
- **Decision**: App.tsx refactor to hooks-based split (rejected class-based approach)
- **Decision**: Error boundaries + vector store migration in parallel
- **Impact**: CODE RED assignments (Archie: HNSW, Faye: Error Boundaries)
- **Source**: `.planning/interviews/__past/code-red-architecture-1768122230/decisions.md`

**2026-01-11 18:29 - Foundation Repair Plans**
- **Decision**: 8 critical issues identified, must fix before feature work
- **Impact**: Created Phase 0 Plan 1 (async loading) and Plan 2 (validation)
- **Source**: `.planning/phases/00-foundation-repair/00-01-PLAN.md`, `00-02-PLAN.md`

**2026-01-11 21:01 - SDK Migration Plan**
- **Decision**: Migrate from REST API to native SDKs
- **Rationale**: REST API unreliable for debugging UI freezes, SDKs provide better async handling
- **Impact**: Created Phase 0 Plan 3 (SDK migration)
- **Source**: `.planning/phases/00-foundation-repair/00-03-PLAN.md`

**2026-01-11 23:01 - Infinite Loop Fix**
- **Decision**: Fix infinite loop in `taskQueue.processNext()`
- **Impact**: UI freeze resolved, CPU spike eliminated
- **Also**: SDK migration executed in same commit (high risk)
- **Source**: Commit `eff6f21`, `.planning/phases/00-foundation-repair/_archive/.continue-here.md`

**2026-01-12 06:26 - Phase Consolidation**
- **Decision**: Merge Phase 1 issues into Phase 0, re-scope Phase 1
- **Impact**: Unified Phase 0 plan, Phase 1 re-scoped
- **Source**: `.planning/phases/00-foundation-repair/PLAN.md`, `.planning/phases/01-agent-architecture/STATUS.md`

**2026-01-12 06:44 - External Consultant Workflow**
- **Decision**: Formalize external AI consultant review process
- **Impact**: Created `.planning/consulting/` directory
- **Source**: `.planning/consulting/CONSULT-PROMPT.md`, `REQUESTS.md`

### Phase Status (Detailed)

| Phase | Status | Progress | Notes |
|-------|--------|----------|-------|
| **00: Foundation Repair** | IN PROGRESS | 0/8 issues | Critical path blocker, infinite loop fixed but cleanup pending |
| **01: Agent Architecture** | TBD | 3/3 plans done | Issues merged into Phase 0, re-scope pending |
| **02: Insights Stream** | Blocked | 0% | Blocked by Phase 0 |
| **03: Agent Command Center** | Blocked | 0% | Blocked by Phase 0 |
| **04: Chat Enhancement** | Blocked | 0% | Blocked by Phase 0 |
| **05: Search Enhancement** | Blocked | 0% | Blocked by Phase 0 |
| **06: Reliability Hardening** | Blocked | 0% | Blocked by Phase 0 |
| **07: Settings Refactor** | Blocked | 0% | Blocked by Phase 0 |
| **08: Personal Validation** | Blocked | 0% | Blocked by Phase 0 |

**Phase 0 Issues (from PLAN.md):**
1. [ ] Sequential embeddings (CRITICAL, 2h) - Indexing 8x slower
2. [ ] Action ID mismatch (CRITICAL, 4h) - Quick Actions broken
3. [ ] Reranker JSON parsing (HIGH, 3h) - Silent failures ~10%
4. [ ] FS.syncfs race (LOW, 1h) - Console noise
5. [ ] Dead ChatAgent code (LOW, 30m) - 248 lines unused
6. [ ] action:proposed event not emitted (CRITICAL, 1h) - Pending actions UI broken
7. [ ] Action applier not wired (CRITICAL, 2h) - Apply button does nothing
8. [ ] Capability cards not connected (LOW, 1h) - Always shows "healthy"

**Total Estimated**: ~14.5 hours

**Phase 0 Sub-Plans:**
- **Plan 00-01**: Async Loading Bottlenecks - ✅ COMPLETE (but UAT revealed new issues)
- **Plan 00-02**: Full Validation - ❌ NOT STARTED
- **Plan 00-03**: SDK Migration - ✅ COMPLETE (executed in eff6f21)

**Phase 1 Sub-Plans:**
- **Plan 01-01**: Chat as UI Layer - ✅ COMPLETE
- **Plan 01-02**: Connection Agent Rename - ✅ COMPLETE
- **Plan 01-03**: Quick Actions Rewiring - ✅ COMPLETE

### Original Intent vs. Reality

#### BETA-SPEC.md (2026-01-11) vs. Current Implementation

**What Was Planned:**

**Architecture:**
- ✅ Multi-agent system (ChiefOfStaff orchestrating agents) - **IMPLEMENTED**
- ✅ LLM abstraction (LM Studio reasoning, Ollama embeddings) - **IMPLEMENTED** (SDK migration complete)
- ✅ HNSW vector search - **IMPLEMENTED** (CODE RED complete)
- ✅ Progressive search (INSTANT → EVOLVING → DEEP) - **IMPLEMENTED**
- ✅ Streaming chat with thinking block parsing - **IMPLEMENTED**
- ✅ Trust-level system (low/medium/high risk) - **IMPLEMENTED**
- ✅ Three-tab sidebar (Note Vitals | Agent Streams | Chat) - **IMPLEMENTED**
- ✅ Error boundaries - **IMPLEMENTED** (CODE RED complete)
- ✅ App.tsx refactored (<500 lines) - **UNCLEAR** (needs verification)
- ✅ Action history with time-bucketed storage and undo - **IMPLEMENTED**
- ✅ Per-note intelligence records - **IMPLEMENTED**

**What's Broken (from BETA-SPEC.md):**
- ❌ Insights Stream - Nothing appears, wiring wrong or missing (P0)
- ❌ Quick Actions - 2/6 use wrong API (sendToChat vs triggerAgent) (P1) - **PARTIALLY FIXED** (Plan 01-03 complete, but action ID mismatch breaks functionality)
- ❌ JSON parsing - Classifier/NoteEditor agents fail on bad JSON (P1)
- ❌ Reranker - Returns garbage ("isyes", "documentno") (P1) - **PARTIALLY FIXED** (consolidated into SDK, but JSON parsing still broken)

**What's Missing:**
- ❌ 12-agent system: 9 user-facing + 3 infrastructure (Chat is UI, not agent) - **PARTIAL** (Plan 01-01 done, but ChatAgent still exists as dead code)
- ❌ Quick Actions rewired to call expert agents via ChiefOfStaff - **PARTIAL** (Plan 01-03 done, but action ID mismatch breaks it)
- ❌ Wire agent results to InsightStream - **NOT DONE** (Phase 2 blocked)
- ❌ Wire proactive AI suggestions from IntelligenceRecord - **NOT DONE** (Phase 2 blocked)

#### PRD.md (v4.0) vs. Current Implementation

**What Was Planned:**

**Phase 1.5: Architectural Reset** - ✅ COMPLETE
**Phase 1.6: UI/UX Overhaul** - ✅ COMPLETE
**Phase 1.7: Backend Completion** - ✅ COMPLETE
**Phase 1.8: Architecture Refactor** - ✅ COMPLETE

**Phase 2: Agentic** - ❌ NOT STARTED (blocked by Phase 0)
**Phase 3: Intelligence** - ❌ NOT STARTED (blocked by Phase 0)
**Phase 4: Polish** - ❌ NOT STARTED (blocked by Phase 0)

**Gap**: PRD shows Phase 1 complete, but Phase 0 foundation repair was inserted after Phase 1, indicating architectural debt discovered post-implementation.

### Interview Insights Synthesis

#### Beta Vision Interview (7 rounds, 2026-01-11)

**Key Decisions:**
1. **Chat is UI, not agent** - Avoids 13th agent, simplifies architecture
2. **All 13 agents ship** - No MVP stripping, full feature set
3. **Priority stack**: Reliability → Context → Personal Transformation → Community
4. **Success metric**: CEO's personal trust (use on real vault)
5. **Research vision**: Transform notes into living entities with pulse, intelligence, agency

**Source**: `.planning/interviews/notient-beta-vision-1736617200/decisions.md`

#### CODE RED Architecture Review (2026-01-11)

**Key Decisions:**
1. **WASM HNSW only** - No Docker sidecar, keep it simple
2. **App.tsx refactor** - Hooks-based split (rejected class-based approach)
3. **Error boundaries** - Wrap all UI components to prevent crashes
4. **Parallel execution** - Error boundaries + vector store migration in parallel

**Source**: `.planning/interviews/__past/code-red-architecture-1768122230/decisions.md`

#### Input Flow Interview (3 rounds, 2026-01-11)

**Key Decisions:**
1. **Structured output** - Use JSON schema for agent outputs
2. **Thinking model handling** - Extract reasoning_content from thinking models
3. **Input routing** - ChiefOfStaff routes UI vs Expert requests

**Source**: `.planning/interviews/interview-notient-input-flow-1736635800/`

---

## Gap Analysis

### Implemented vs. Planned

**Successfully Implemented:**
- ✅ Core architecture (kernel, services, events, agents)
- ✅ LLM abstraction layer (SDK migration complete)
- ✅ HNSW vector store (CODE RED complete, native caching added)
- ✅ Progressive search orchestrator
- ✅ Chat service with streaming
- ✅ Trust level system
- ✅ Multi-agent routing (ChiefOfStaff)
- ✅ Action history with undo
- ✅ Per-note intelligence records
- ✅ Error boundaries (CODE RED complete)
- ✅ Event handler performance fixes (queueMicrotask wrappers)

**Partially Implemented:**
- ⚠️ Quick Actions (UI exists, but action ID mismatch breaks functionality)
- ⚠️ Agent architecture (Chat as UI done, but dead ChatAgent code remains)
- ⚠️ Error boundaries (implemented, but integration gaps remain)
- ⚠️ App.tsx refactor (goal <500 lines, status unclear)
- ⚠️ Reranker (consolidated into SDK, but JSON parsing still broken)
- ⚠️ HNSW performance (batching added, but 36s → <3s target not yet achieved)

**Not Implemented (Blocked):**
- ❌ Insights Stream wiring (Phase 2)
- ❌ Agent Command Center wiring (Phase 3)
- ❌ Chat enhancement (Phase 4)
- ❌ Search enhancement (Phase 5)
- ❌ Reliability hardening (Phase 6)
- ❌ Settings refactor (Phase 7)

### Design Drift

**Where Implementation Diverged from Design:**

1. **Chat Agent Elimination**
   - **Planned**: Chat is UI, not agent (Plan 01-01)
   - **Reality**: `chatAgent.ts` still exists as dead code (248 lines, Issue 5)
   - **Drift**: Cleanup deferred, architectural confusion remains
   - **Impact**: Confusion about Chat's role, dead code maintenance burden

2. **Quick Actions Architecture**
   - **Planned**: 3 pinned + 3 contextual, route to expert agents
   - **Reality**: UI implemented (Plan 01-03), but action ID mismatch breaks functionality
   - **Drift**: Feature complete but non-functional due to ID tracking bug
   - **Impact**: Users can't use Quick Actions, core feature broken

3. **App.tsx Refactor**
   - **Planned**: Reduce to <500 lines (CODE RED goal)
   - **Reality**: Status unclear from git history (needs file inspection)
   - **Drift**: Goal may not have been achieved, or achieved then regressed
   - **Impact**: Technical debt, unclear if refactor goal met

4. **Phase Sequencing**
   - **Planned**: Phase 1 → Phase 2 → Phase 3 (sequential)
   - **Reality**: Phase 0 inserted after Phase 1, blocking all subsequent phases
   - **Drift**: Foundation repair discovered as prerequisite after feature work
   - **Impact**: All feature work blocked, indicates architectural debt

5. **Event Emission**
   - **Planned**: Agents emit events, UI subscribes
   - **Reality**: `action:proposed` event not emitted (Issue 6)
   - **Drift**: Event bus pattern incomplete, pending actions UI broken
   - **Impact**: Users can't see pending actions, core feature broken

6. **SDK Migration Timing**
   - **Planned**: SDK migration as separate plan (00-03)
   - **Reality**: SDK migration executed during infinite loop fix (eff6f21)
   - **Drift**: High-risk change made during debugging cycle
   - **Impact**: Increased risk, but also faster resolution

7. **HNSW Performance**
   - **Planned**: <3 second startup target
   - **Reality**: 36 seconds → batching added, but target not yet achieved
   - **Drift**: Performance optimization incomplete
   - **Impact**: Poor UX, users think app is frozen

### Technical Debt Identified

**From ISSUES.md + Git Commit Messages:**

1. **ISSUE-001: IndexManager fails to save large indices**
   - **Severity**: Critical
   - **Component**: IndexManager / JSON serialization
   - **Symptom**: `RangeError: Invalid string length` when serializing >512MB
   - **Impact**: Index saves fail for large vaults (895 notes, 24917 chunks)
   - **Status**: Deferred
   - **Fix**: Chunked JSON writing or split index files

2. **ISSUE-002: IntelligenceDb null reference**
   - **Severity**: Medium
   - **Component**: IntelligenceDb / NoteIntelligenceService
   - **Symptom**: `Cannot read properties of null (reading 'replace')`
   - **Impact**: Silent failures for some notes
   - **Status**: Deferred
   - **Fix**: Add null guards

3. **ISSUE-003: Slow initialization and indexing**
   - **Severity**: Medium
   - **Component**: Startup / SimpleIndexer
   - **Symptom**: Heavy initialization, blocks agent use until index complete
   - **Impact**: Poor UX, users think app is frozen
   - **Status**: Deferred (Phase 0 Issue 1 addresses embeddings, not startup)
   - **Fix**: Progressive loading, background indexing

4. **ISSUE-004: Agent execution doesn't appear in Agent Streams**
   - **Severity**: High
   - **Component**: AgentTaskQueue / AgentStreamsView
   - **Symptom**: Toast notification but no agent card
   - **Impact**: Users can't see agent progress
   - **Status**: Deferred (likely related to Phase 0 Issue 6/7)
   - **Fix**: Wire event emission, ensure events reach UI

5. **ISSUE-005: UI crashes on multiple simultaneous agent triggers**
   - **Severity**: High
   - **Component**: Sidebar / Error handling
   - **Symptom**: UI crashes when launching multiple agents
   - **Impact**: Requires Obsidian restart
   - **Status**: Deferred (may be addressed by queueMicrotask fixes in EVENT_HANDLER_ANALYSIS.md)
   - **Fix**: Verify queueMicrotask fixes, add debouncing if needed

**From Phase 0 PLAN.md:**

6. **Sequential Embeddings** (Issue 1)
   - **Severity**: CRITICAL
   - **Impact**: Indexing 8x slower than necessary
   - **Fix**: Parallelize embedding requests
   - **Status**: Not started
   - **Files**: `src/core/indexer/simpleIndexer.ts`

7. **Action ID Mismatch** (Issue 2)
   - **Severity**: CRITICAL
   - **Impact**: Quick Actions produce "Could not find action" errors
   - **Fix**: Propagate task ID through action pipeline
   - **Status**: Not started
   - **Files**: `src/core/agent/taskQueue.ts`, `src/core/agentic/types.ts`, `src/core/agents/chiefOfStaff.ts`

8. **Reranker JSON Parsing** (Issue 3)
   - **Severity**: HIGH
   - **Impact**: Search reranking silently fails ~10%
   - **Fix**: Improve regex, strip thinking tags
   - **Status**: Not started (NEXT)
   - **Files**: `src/core/llm/providers/lmstudio-sdk.ts`

9. **FS.syncfs Race Condition** (Issue 4)
   - **Severity**: LOW
   - **Impact**: Console noise, potential data corruption
   - **Fix**: Add sync flag, queue requests
   - **Status**: Not started
   - **Files**: `src/services/hnswVectorStore.ts`

10. **Dead ChatAgent Code** (Issue 5)
    - **Severity**: LOW
    - **Impact**: 248 lines unused code, confusion
    - **Fix**: Delete file, remove exports
    - **Status**: Not started
    - **Files**: `src/core/agents/chatAgent.ts`, `src/core/agents/index.ts`

11. **action:proposed Event Not Emitted** (Issue 6)
    - **Severity**: CRITICAL
    - **Impact**: Pending actions UI never populates
    - **Fix**: Emit event after extractActions()
    - **Status**: Not started
    - **Files**: `src/core/agent/taskQueue.ts`

12. **Action Applier Not Wired** (Issue 7)
    - **Severity**: CRITICAL
    - **Impact**: Apply button does nothing
    - **Fix**: Wire event listener in main.ts
    - **Status**: Not started
    - **Files**: `src/main.ts`, `src/core/agentic/actionApplier.ts`

13. **Capability Cards Not Connected** (Issue 8)
    - **Severity**: LOW
    - **Impact**: Always shows "healthy" status
    - **Fix**: Wire HealthMonitor to AgentStreamsView
    - **Status**: Not started
    - **Files**: `src/ui/sidebar/App.tsx`

**From EVENT_HANDLER_ANALYSIS.md:**

14. **Event Handler Performance**
    - **Status**: ✅ FIXED (queueMicrotask wrappers added)
    - **Impact**: UI freeze during LLM streaming (was CRITICAL)
    - **Fix Applied**: All handlers wrapped in queueMicrotask, JSON.stringify optimized
    - **Files**: `src/ui/sidebar/hooks/useAppEvents.ts`, `src/ui/sidebar/state/appHandlers.ts`

**From UAT Issues (00-01-ISSUES.md):**

15. **HNSWVectorStore 36-second bottleneck**
    - **Status**: ⚠️ PARTIALLY FIXED (batching added, but target not achieved)
    - **Impact**: UI frozen during startup
    - **Fix Applied**: Batched processing (1000 docs per batch with yields)
    - **Remaining**: Target <3s not yet achieved

16. **Quick Actions double-click**
    - **Status**: ❌ NOT FIXED
    - **Impact**: Poor UX, first click ignored
    - **Fix Needed**: Investigate event handler wiring

17. **UI crashes after agent triggers**
    - **Status**: ⚠️ PARTIALLY FIXED (infinite loop fixed, but crashes may persist)
    - **Impact**: Whole application crashes
    - **Fix Applied**: Infinite loop fixed, SDK migration
    - **Remaining**: Verify crashes resolved

---

## Recommended Cleanup Sequence

### Priority 1: Complete Phase 0 Foundation Repair (CRITICAL PATH)

**Rationale**: All feature work blocked until foundation is stable. 8 issues identified, 0 resolved. Infinite loop fixed but cleanup pending.

**Execution Order** (from PLAN.md):

1. **Issue 3: Reranker JSON Parsing** (3h) - **NEXT**
   - Quick win, improves search reliability
   - Fix regex, strip thinking tags, add validation
   - **Files**: `src/core/llm/providers/lmstudio-sdk.ts`
   - **Impact**: Search reranking reliability improves from 90% to 100%

2. **Issue 6: action:proposed Event** (1h)
   - Unblocks pending actions UI
   - Emit event after extractActions()
   - **Files**: `src/core/agent/taskQueue.ts`
   - **Impact**: Users can see pending actions

3. **Issue 7: Action Applier Wiring** (2h)
   - Makes Apply button functional
   - Wire event listener in main.ts
   - **Files**: `src/main.ts`, `src/core/agentic/actionApplier.ts`
   - **Impact**: Users can apply agent actions

4. **Issue 2: Action ID Mismatch** (4h)
   - Fixes "action not found" errors
   - Propagate task ID through pipeline
   - **Files**: `src/core/agent/taskQueue.ts`, `src/core/agentic/types.ts`, `src/core/agents/chiefOfStaff.ts`
   - **Impact**: Quick Actions become functional

5. **Issue 1: Sequential Embeddings** (2h)
   - Major indexing speedup (8x improvement)
   - Parallelize embedding requests
   - **Files**: `src/core/indexer/simpleIndexer.ts`
   - **Impact**: Indexing speed improves dramatically

6. **Issue 5: Dead ChatAgent** (30m)
   - Cleanup, removes confusion
   - Delete file, remove exports
   - **Files**: `src/core/agents/chatAgent.ts`, `src/core/agents/index.ts`
   - **Impact**: Codebase clarity, reduced maintenance burden

7. **Issue 4: FS.syncfs Race** (1h)
   - Reduces console noise
   - Add sync flag, queue requests
   - **Files**: `src/services/hnswVectorStore.ts`
   - **Impact**: Console noise reduced, potential data corruption prevented

8. **Issue 8: Capability Cards** (1h)
   - Polish, shows real status
   - Wire HealthMonitor to AgentStreamsView
   - **Files**: `src/ui/sidebar/App.tsx`
   - **Impact**: Users see accurate system health

**Total**: ~14.5 hours

**Post-Fix Cleanup:**
- Remove TRACE logging (identified in `.continue-here.md`)
- Optimize health event emission (only emit on status change)
- Verify no CPU spikes remain
- Test with real vault (895+ notes)

### Priority 2: Verify CODE RED Completion

**Rationale**: CODE RED phase (HNSW, error boundaries, App.tsx refactor) marked complete, but integration gaps may remain.

**Tasks**:
1. Verify App.tsx is <500 lines (if not, complete refactor)
2. Verify error boundaries wrap all UI components
3. Verify HNSW integration is complete (no fallback to SimpleVectorStore)
4. Test large vault performance (895+ notes)
5. Verify HNSW startup time <3s (currently batching added, but target not achieved)

**Estimated**: 2-4 hours

### Priority 3: Resolve Deferred Issues

**Rationale**: ISSUES.md contains 5 deferred issues that impact production readiness.

**Priority Order**:
1. **ISSUE-001: IndexManager large index save** (Critical)
   - Blocks large vaults (895+ notes)
   - Fix: Chunked JSON writing or split index files
   - **Estimated**: 4-6 hours

2. **ISSUE-004: Agent execution not appearing** (High)
   - Core feature broken
   - Likely related to Phase 0 Issue 6/7
   - **Estimated**: 2-3 hours (after Phase 0)

3. **ISSUE-005: UI crashes on multiple agents** (High)
   - May be fixed by queueMicrotask (EVENT_HANDLER_ANALYSIS.md)
   - Verify fix, add debouncing if needed
   - **Estimated**: 1-2 hours

4. **ISSUE-002: IntelligenceDb null reference** (Medium)
   - Silent failures
   - Add null guards
   - **Estimated**: 1 hour

5. **ISSUE-003: Slow initialization** (Medium)
   - UX issue
   - Progressive loading, background indexing
   - **Estimated**: 3-4 hours

**Total**: ~11-16 hours

### Priority 4: Architectural Cleanup

**Rationale**: High churn files indicate architectural instability. Consolidate patterns.

**Tasks**:
1. **Consolidate routing logic** (`chiefOfStaff.ts`)
   - Extract routing rules to separate module
   - Add unit tests for routing decisions
   - **Estimated**: 4-6 hours

2. **Stabilize event emission** (`taskQueue.ts`)
   - Document event emission contract
   - Add event emission tests
   - **Estimated**: 2-3 hours

3. **Verify App.tsx refactor** (if not done)
   - Complete hooks-based split
   - Extract event handlers, state, actions
   - **Estimated**: 4-6 hours

4. **SDK Migration Verification**
   - Verify all REST API usage removed
   - Verify SDK error handling complete
   - **Estimated**: 1-2 hours

**Total**: ~11-17 hours

---

## Contradictions & Ambiguities

### Contradictions

1. **Chat Agent Status**
   - **BETA-SPEC.md**: "Chat is UI, not agent" (decision from interview)
   - **Plan 01-01**: Completed (Chat as UI layer)
   - **Phase 0 Issue 5**: "Dead ChatAgent code" (248 lines unused)
   - **Contradiction**: ChatAgent eliminated in design but code still exists
   - **Resolution**: Delete `chatAgent.ts` (Issue 5 fix)

2. **Phase Sequencing**
   - **PRD.md**: Phase 1 → Phase 2 → Phase 3 (sequential)
   - **ROADMAP.md**: Phase 0 inserted after Phase 1, blocks all phases
   - **Contradiction**: Phase 0 discovered as prerequisite after Phase 1
   - **Resolution**: Phase 0 is correct prerequisite, PRD.md needs update

3. **App.tsx Refactor Status**
   - **CODE RED**: Goal <500 lines
   - **Git History**: Unclear if achieved (needs file inspection)
   - **Contradiction**: Goal stated but verification missing
   - **Resolution**: Verify current line count, complete if needed

4. **SDK Migration Timing**
   - **Plan 00-03**: SDK migration as separate plan
   - **Reality**: SDK migration executed during infinite loop fix (eff6f21)
   - **Contradiction**: High-risk change made during debugging cycle
   - **Resolution**: Verify SDK migration complete, document decision

5. **HNSW Performance Target**
   - **Plan 00-01**: Target <3s startup
   - **Reality**: Batching added, but 36s → <3s target not yet achieved
   - **Contradiction**: Performance optimization incomplete
   - **Resolution**: Continue optimization, verify target achieved

### Ambiguities

1. **Quick Actions Functionality**
   - **Plan 01-03**: Completed (3 pinned + 3 contextual)
   - **Phase 0 Issue 2**: Action ID mismatch breaks functionality
   - **UAT-002**: Quick Actions require double-click
   - **Ambiguity**: Is Quick Actions UI complete but broken, or incomplete?
   - **Clarification Needed**: UI is complete, functionality broken by ID tracking bug + event handler issue

2. **Insights Stream Status**
   - **BETA-SPEC.md**: "BROKEN - wiring wrong or missing" (P0)
   - **ROADMAP.md**: Phase 2 (blocked by Phase 0)
   - **Ambiguity**: Is it broken (needs fix) or not implemented (needs build)?
   - **Clarification Needed**: Likely not implemented, "broken" means non-functional

3. **Event Emission Contract**
   - **EVENT_HANDLER_ANALYSIS.md**: Handlers fixed (queueMicrotask)
   - **Phase 0 Issue 6**: `action:proposed` event not emitted
   - **Ambiguity**: Are all events emitted, or are some missing?
   - **Clarification Needed**: Some events missing (Issue 6), handlers fixed but emission incomplete

4. **Agent Count**
   - **BETA-SPEC.md**: "All 13 agents ship"
   - **Plan 01-01**: "12-agent system (Chat is UI, not agent)"
   - **Ambiguity**: 13 agents or 12 agents + Chat UI?
   - **Clarification Needed**: 12 expert agents + Chat UI = 13 total capabilities, but Chat is not an agent

5. **UI Freeze Resolution**
   - **eff6f21**: Infinite loop fixed
   - **UAT-003**: UI crashes after agent triggers
   - **Ambiguity**: Is UI freeze completely resolved, or do crashes persist?
   - **Clarification Needed**: Infinite loop fixed, but crashes may have other causes

6. **HNSW Performance Status**
   - **Plan 00-01**: Batching added, target <3s
   - **UAT-001**: 36-second bottleneck identified
   - **Ambiguity**: Is batching sufficient, or more optimization needed?
   - **Clarification Needed**: Batching added, but target not yet achieved, more optimization needed

---

## Source References

### Planning Documents

- `.planning/PROJECT.md` - Current project scope and requirements
- `.planning/ROADMAP.md` - Phase breakdown and execution order
- `.planning/STATE.md` - Current position and session summary
- `.planning/ISSUES.md` - Deferred issues (5 issues)
- `.planning/EVENT_HANDLER_ANALYSIS.md` - Event handler performance analysis
- `.planning/__original_plans/BETA-SPEC.md` - Product specification (v0.4.0-beta)
- `.planning/__original_plans/PRD.md` - Product requirements (v4.0)
- `.planning/__original_plans/VISUALS.md` - UI design prompts
- `.planning/__original_plans/CEO.md` - Branch structure
- `.planning/phases/00-foundation-repair/PLAN.md` - Phase 0 execution plan (8 issues)
- `.planning/phases/00-foundation-repair/_archive/.continue-here.md` - Infinite loop fix documentation
- `.planning/phases/00-foundation-repair/_archive/00-01-PLAN.md` - Async loading plan
- `.planning/phases/00-foundation-repair/_archive/00-01-ISSUES.md` - UAT issues
- `.planning/phases/00-foundation-repair/_archive/00-01-SUMMARY.md` - Plan 00-01 summary
- `.planning/phases/00-foundation-repair/_archive/00-02-PLAN.md` - Validation plan
- `.planning/phases/00-foundation-repair/_archive/00-03-PLAN.md` - SDK migration plan
- `.planning/phases/01-agent-architecture/STATUS.md` - Phase 1 status (TBD, re-scope pending)
- `.planning/phases/01-agent-architecture/_archive/01-01-PLAN.md` - Chat as UI plan (completed)
- `.planning/phases/01-agent-architecture/_archive/01-01-SUMMARY.md` - Plan 01-01 summary
- `.planning/phases/01-agent-architecture/_archive/01-02-PLAN.md` - Connection rename plan (completed)
- `.planning/phases/01-agent-architecture/_archive/01-02-SUMMARY.md` - Plan 01-02 summary
- `.planning/phases/01-agent-architecture/_archive/01-03-PLAN.md` - Quick Actions plan (completed)
- `.planning/phases/01-agent-architecture/_archive/01-03-SUMMARY.md` - Plan 01-03 summary
- `.planning/interviews/notient-beta-vision-1736617200/decisions.md` - Beta vision interview decisions
- `.planning/interviews/__past/code-red-architecture-1768122230/decisions.md` - CODE RED architecture decisions
- `.planning/interviews/interview-notient-input-flow-1736635800/` - Input flow interview (3 rounds)
- `.planning/interviews/interview-notient-wiring-ux-1768077411/` - Wiring/UX interview (7 rounds)
- `.planning/consulting/CONSULT-PROMPT.md` - External consultant workflow
- `.planning/consulting/REQUESTS.md` - Consultant requests

### Git History

- **Recent commits**: `git log --oneline -50`
- **Last 48 hours**: `git log --since="48 hours ago" --format="%H|%ai|%s" --numstat`
- **Hot files**: `git log --oneline -50 --name-only | grep -E "^src/" | sort | uniq -c | sort -rn | head -20`
- **Turbulence**: `git log --oneline -50 --grep="fix\|wip\|debug\|freeze\|broken\|emergency" -i`
- **Core evolution**: `git log --oneline --stat --follow -10 -- <file>`
- **Net changes**: `git diff --stat HEAD~30..HEAD -- src/core/`
- **Net changes (48h)**: `git diff --stat HEAD~124..HEAD -- src/`

### Key Commits

- `840b176` - EMERGENCY STOP (foundations broken)
- `6833e0a` - Emergency phase 0 (external review)
- `eff6f21` - Infinite loop fix (taskQueue) + SDK migration (CRITICAL)
- `098bd1c` - Phase 0 cleanup checkpoint
- `2c6e44e` - Phase 0 debugging consolidation
- `f71a19de` - HNSW batching fix
- `7e9db421` - HNSW native caching
- `37c6782` - Connection agent rename (Plan 01-02)
- `83f811e` - Chat as UI (Plan 01-01)
- `fb13b86` - Quick Actions structure (Plan 01-03)
- `a032925` - ChunkStore parallel loading
- `3c25b10` - IndexManager JSON yielding
- `c5a5caf` - Startup progress events

---

## Conclusion

The codebase shows a **mature architecture** (multi-agent system, progressive search, HNSW vector store) but **foundational instability** (8 critical issues in Phase 0). The gap between design and implementation is **moderate** - core features exist but integration bugs prevent functionality.

**Critical Path**: Complete Phase 0 foundation repair (14.5 hours) before any feature work. The emergency stops and debugging cycles indicate **reactive development** - fixing issues as they arise rather than systematic resolution.

**Key Insights from Last 48 Hours:**
1. **Infinite Loop Breakthrough**: Single commit (`eff6f21`) fixed critical bug but also migrated entire LLM provider layer (high risk, high reward)
2. **SDK Migration**: Major architectural shift from REST API to native SDKs, executed during debugging cycle
3. **Reactive Debugging**: Multiple "wip: phase-0 paused" commits indicate iterative debugging rather than systematic resolution
4. **Planning Consolidation**: Multiple commits consolidating planning documents, removing stale docs
5. **Performance Optimization**: Focus on batching, yielding, and parallelization (HNSW, ChunkStore, IndexManager)
6. **Code Quality**: Multiple lint fix commits, indicating ongoing code quality maintenance

**Recommendation**: Focus on **stability over features**. Complete Phase 0, verify CODE RED completion, then proceed with Phase 2 (Insights Stream) once foundation is solid.

**Next Steps:**
1. Fix Reranker JSON parsing (Issue 3) - quick win
2. Wire action:proposed event (Issue 6) - unblocks UI
3. Wire action applier (Issue 7) - makes Apply button work
4. Fix action ID mismatch (Issue 2) - makes Quick Actions functional
5. Parallelize embeddings (Issue 1) - major performance win
6. Cleanup: Remove dead code, optimize events, verify performance

---

## Detailed File Evolution Analysis

### `src/services/indexManager.ts` (11 modifications in 48h)

**Evolution Pattern:**
- **Initial**: Index management with SimpleVectorStore
- **CODE RED**: HNSW integration added
- **Plan 00-01**: Staged initialization with yields and timing
- **Plan 00-01**: Progress events added
- **Plan 00-01**: JSON parsing yields added
- **Net Change**: +360 lines over 48 hours

**Key Commits:**
- `eff6f21`: Service initialization fixes (+128/-44)
- `098bd1c`: Cleanup (-89)
- `c5a5caf`: Progress events (+14/-11)
- `3c25b10`: JSON yielding (+5)
- `a032925`: Parallel loading integration (+2/-2)
- `7e9db421`: Native caching integration (+38/-2)

**Architectural Decisions:**
- Staged initialization: Stage 1-4 with progress logging
- Yielding: `setTimeout(0)` before heavy JSON.parse operations
- Progress events: Emits `index:progress` events for UI feedback
- Native caching: Integrates with HNSW native cache

**Current State**: ~403 lines, complete index management with HNSW integration

### `src/ui/sidebar/state/appHandlers.ts` (10 modifications in 48h)

**Evolution Pattern:**
- **Initial**: Event handlers for UI interactions
- **eff6f21**: QueueMicrotask wrappers added (+189/-8)
- **098bd1c**: Massive cleanup (-286)
- **2c6e44e**: Further cleanup (-36)
- **Net Change**: +293 lines over 48 hours (but net negative from initial state)

**Key Commits:**
- `eff6f21`: QueueMicrotask wrappers, handler fixes
- `098bd1c`: Removed redundant handlers, simplified logic
- `2c6e44e`: Consolidated debugging attempts

**Architectural Decisions:**
- QueueMicrotask wrappers: Prevent UI freeze during LLM streaming
- Signal mutations: Uses signals for reactive updates
- Error handling: Handlers fail gracefully, don't crash UI
- Event emission: Emits UI events for debugging

**Current State**: ~579 lines, complete event handler system with performance optimizations

### `src/ui/sidebar/components/QuickActions.tsx` (10 modifications in 48h)

**Evolution Pattern:**
- **Initial**: Quick Actions UI component
- **Plan 01-03**: Pinned + contextual structure implemented (+209/-95)
- **Plan 01-03**: AgenticTaskType update (+42/-50)
- **Multiple**: Bug fixes and refinements
- **Net Change**: +227 lines over 48 hours

**Key Commits:**
- `fb13b86`: Pinned + contextual structure (+209/-95)
- `8c7b6f7`: AgenticTaskType update (+42/-50)
- `2fb300f`: Post-phase-1 hotfixes (+18/-9)
- `05a5008`: Lint fixes (+3/-2)
- `969c342`: Lint fixes (+3/-2)

**Architectural Decisions:**
- 3 pinned + 3 contextual: Fixed set of pinned actions, dynamic contextual actions
- Agent routing: Routes to expert agents via ChiefOfStaff
- Conditional display: Contextual actions only shown when conditions met
- Event handling: Emits `action:triggered` events

**Current State**: ~330 lines, complete Quick Actions UI but functionality broken by action ID mismatch

**Known Issues:**
- Action ID mismatch (Phase 0 Issue 2): Quick Actions produce "Could not find action" errors
- Double-click required (UAT-002): First click ignored, second click works
- Root cause: Action IDs generated at multiple points, never linked consistently

### `src/services/hnswVectorStore.ts` (10 modifications in 48h)

**Evolution Pattern:**
- **CODE RED**: HNSW migration from SimpleVectorStore
- **7e9db421**: Native caching added
- **f71a19de**: Batched loading added (+67/-36)
- **2c6e44e**: Consolidation (+185/-431)
- **Net Change**: +435 lines over 48 hours

**Key Commits:**
- `eff6f21`: Service integration fixes
- `2c6e44e`: Native cache fixes, consolidation
- `f71a19de`: Batched metadata loading (+67/-36)
- `7e9db421`: Native caching foundation (+179/-12)
- `face696`: Cache failure diagnosis

**Architectural Decisions:**
- WASM HNSW: High-performance approximate nearest neighbor search
- Native caching: Persists index to IndexedDB for fast startup
- Batched processing: 1000 documents per batch with `setTimeout(0)` yields
- FS.syncfs: Prevents multiple sync operations (race condition fix needed)

**Current State**: ~866 lines, complete HNSW vector store with native caching and batching

**Performance:**
- **Before**: 36 seconds to load 22,313 documents
- **After**: Batched loading added, but <3s target not yet achieved
- **Remaining**: More optimization needed to reach target

**Known Issues:**
- FS.syncfs race condition (Phase 0 Issue 4): Multiple sync operations cause console noise
- Performance target not achieved: Batching added, but <3s startup not yet reached

### `src/ui/sidebar/hooks/useAppEvents.ts` (9 modifications in 48h)

**Evolution Pattern:**
- **Initial**: Event hooks for UI components
- **eff6f21**: QueueMicrotask wrappers added (+507/-207)
- **098bd1c**: Cleanup (-224)
- **2c6e44e**: Further cleanup (+14/-11)
- **Net Change**: +283 lines over 48 hours

**Key Commits:**
- `eff6f21`: QueueMicrotask wrappers, event handler fixes
- `098bd1c`: Removed redundant hooks, simplified logic
- `2c6e44e`: Consolidated debugging attempts

**Architectural Decisions:**
- QueueMicrotask wrappers: Prevent UI freeze during LLM streaming
- Event subscription: Subscribes to EventBus, reacts to events
- Signal updates: Uses signals for reactive UI updates
- Error boundaries: Wraps event handlers to prevent crashes

**Current State**: ~547 lines, complete event hook system with performance optimizations

**Performance Impact:**
- **Before**: UI freeze during LLM streaming
- **After**: QueueMicrotask wrappers prevent freeze
- **Status**: ✅ FIXED (EVENT_HANDLER_ANALYSIS.md)

### `src/core/llm/providers/lmstudio-sdk.ts` (New File)

**Evolution Pattern:**
- **Created**: 674 lines added (eff6f21)
- **Refactor**: Reranker consolidation (+56/-173) (f9d9037b)
- **Net Change**: +557 lines

**Key Commits:**
- `eff6f21`: Initial SDK provider implementation (+674)
- `f9d9037b`: Reranker consolidation (+56/-173)

**Architectural Decisions:**
- Native SDK: Uses `@lmstudio/sdk` instead of REST API
- Streaming first: All completions stream by default
- Structured output: JSON schema validation built-in
- Thinking model support: Extracts reasoning_content from thinking models
- Abort signal support: Cancellation support for all operations
- Reranker integration: Moved from `ollamaReranker.ts` service

**Current State**: ~557 lines, complete LLM provider implementation

**Replaces:**
- `src/core/llm/providers/openai-compatible.ts` (-537 lines)
- `src/services/lmstudio.ts` (-358 lines)
- `src/services/ollamaReranker.ts` (-245 lines, reranker logic moved)

**Known Issues:**
- Reranker JSON parsing (Phase 0 Issue 3): Silent failures ~10% due to greedy regex
- Fix needed: Improve regex, strip thinking tags, add validation

## Phase 0 Sub-Plan Analysis

### Plan 00-01: Async Loading Bottlenecks

**Status**: ✅ COMPLETE (but UAT revealed new issues)

**Duration**: 8 minutes
**Completed**: 2026-01-11
**Tasks**: 3
**Files Modified**: 2

**Accomplishments:**
- ChunkStore now loads files in parallel batches of 50 instead of sequential awaits
- IndexManager yields to event loop before heavy JSON.parse operations
- Startup shows Stage 1-4 progress with timing metrics
- Users see console activity instead of frozen screen during initialization

**Task Commits:**
1. **Task 1: Parallelize ChunkStore file loading** - `a032925` (perf)
2. **Task 2: Make IndexManager JSON parsing non-blocking** - `3c25b10` (perf)
3. **Task 3: Add progress events during startup** - `c5a5caf` (feat)

**Decisions Made:**
- **Batch size 50**: Balances throughput (parallel file reads) against file descriptor exhaustion risk
- **setTimeout(0) yields**: Simpler than streaming JSON parser, no new dependencies, achieves goal of UI responsiveness
- **Progress every 250 files**: Provides visibility without console spam

**UAT Issues Discovered:**
- **UAT-001**: HNSWVectorStore loadFromDataAsync takes 36 seconds (real bottleneck)
- **UAT-002**: Quick Actions require double-click to trigger
- **UAT-003**: UI crashes after agent triggers

**Impact**: Plan 00-01 fixed wrong bottleneck. ChunkStore now fast (243ms), but HNSW is real issue (36s).

### Plan 00-02: Full Validation

**Status**: ❌ NOT STARTED

**Purpose**: Validate all foundation fixes end-to-end
**Tasks**: Build and deploy to test vault, human verification, update STATE.md and ROADMAP.md

**Blocked By**: Plan 00-01 UAT issues not yet resolved

### Plan 00-03: SDK Migration

**Status**: ✅ COMPLETE (executed in eff6f21)

**Purpose**: Replace REST API-based LLM providers with native TypeScript SDKs
**Rationale**: REST API unreliable for debugging UI freezes, SDKs provide better async handling

**Tasks:**
1. Install SDK dependencies (`@lmstudio/sdk`, `ollama`)
2. Create LM Studio SDK provider
3. Create Ollama SDK provider (if needed)
4. Wire SDK providers into Kernel
5. Clean up old REST providers

**Execution**: All tasks completed in single commit (`eff6f21`)

**Impact**: 
- Removed 537 lines (`openai-compatible.ts`)
- Removed 358 lines (`lmstudio.ts` service)
- Added 557 lines (`lmstudio-sdk.ts`)
- Consolidated reranker logic into SDK provider

**Known Issues:**
- Reranker JSON parsing still broken (Phase 0 Issue 3)
- Need to verify all REST API usage removed

## Phase 1 Sub-Plan Analysis

### Plan 01-01: Chat as UI Layer

**Status**: ✅ COMPLETE

**Duration**: ~30 minutes
**Completed**: 2026-01-11
**Tasks**: 3
**Files Modified**: 3

**Accomplishments:**
- Added UI vs Expert agent distinction to type system
- Added `isUIRequest()` helper to ChiefOfStaff routing
- Updated agentIdentity to clarify Chat's UI role
- Chat now routes directly to UI, bypasses agent system

**Task Commits:**
1. **Task 1: Add UI vs Expert agent distinction** - `22651c92` (feat)
2. **Task 2: Add isUIRequest helper** - `83f811e0` (feat)
3. **Task 3: Update agentIdentity** - `8d243fd0` (feat)

**Decisions Made:**
- **Two-tier routing**: UI requests bypass agent system, expert requests route to agents
- **Chat is UI**: Chat is thin UI layer, not an agent
- **Intent detection**: `isUIRequest()` determines routing path

**Remaining Work:**
- Delete dead ChatAgent code (Phase 0 Issue 5)
- Verify Chat routing works correctly

### Plan 01-02: Connection Agent Rename

**Status**: ✅ COMPLETE

**Duration**: ~10 minutes
**Completed**: 2026-01-11
**Tasks**: 3
**Files Modified**: 6

**Accomplishments:**
- Renamed `link-finder` type to `connection`
- Renamed `LinkFinderAgent` class to `ConnectionAgent`
- Updated ChiefOfStaff routing for connection agent
- Updated all imports and references

**Task Commits:**
1. **Task 1: Rename link-finder type** - `29d3b0be` (refactor)
2. **Task 2: Rename LinkFinderAgent class** - `069c600e` (refactor)
3. **Task 3: Update ChiefOfStaff routing** - `37c67822` (refactor)

**Decisions Made:**
- **Semantic clarity**: "Connection" better describes agent's purpose than "Link Finder"
- **Consistent naming**: All references updated atomically
- **Backward compatibility**: No breaking changes, internal rename only

**Impact**: Improved semantic clarity, no functional changes

### Plan 01-03: Quick Actions Rewiring

**Status**: ✅ COMPLETE (but functionality broken)

**Duration**: ~20 minutes
**Completed**: 2026-01-11
**Tasks**: 2
**Files Modified**: 5

**Accomplishments:**
- Updated `AgenticTaskType` to use agent names
- Implemented 3 pinned + 3 contextual Quick Actions structure
- Quick Actions now route to expert agents via ChiefOfStaff

**Task Commits:**
1. **Task 1: Update AgenticTaskType** - `8c7b6f7c` (feat)
2. **Task 2: Implement pinned + contextual structure** - `fb13b86` (feat)

**Decisions Made:**
- **3 pinned + 3 contextual**: Fixed set of pinned actions, dynamic contextual actions
- **Agent routing**: Routes to expert agents via ChiefOfStaff
- **Conditional display**: Contextual actions only shown when conditions met

**Known Issues:**
- **Action ID mismatch** (Phase 0 Issue 2): Quick Actions produce "Could not find action" errors
- **Double-click required** (UAT-002): First click ignored, second click works
- **Root cause**: Action IDs generated at multiple points, never linked consistently

**Remaining Work:**
- Fix action ID mismatch (Phase 0 Issue 2)
- Fix double-click issue (UAT-002)
- Verify Quick Actions work end-to-end

## Emergency Stop Analysis

### Emergency Stop Timeline

**2026-01-11 11:20 - EMERGENCY STOP**
- **Commit**: `840b176`
- **Message**: "wip: EMERGENCY STOP - foundations broken, CPU 100%, UI frozen"
- **Trigger**: Rapid feature development without sufficient testing
- **Symptoms**: CPU at 100%, UI frozen, foundations broken
- **Impact**: Complete halt of feature work, focus on foundation repair

**2026-01-11 11:56 - External Review Initiated**
- **Commit**: `6833e0a`
- **Message**: "wip: emergency phase 0 - paused for external AI review"
- **Action**: External consultant review (Gemini) initiated
- **Result**: CODE RED assignments (Archie: HNSW, Faye: Error Boundaries)

**2026-01-11 23:01 - Breakthrough Fix**
- **Commit**: `eff6f21`
- **Message**: "fix(taskQueue): resolve infinite loop causing UI freeze"
- **Fix**: Infinite loop in `taskQueue.processNext()` resolved
- **Also**: SDK migration executed in same commit
- **Impact**: UI freeze resolved, CPU spike eliminated

### Root Cause Analysis

**Infinite Loop Bug:**
- **Location**: `src/core/agent/taskQueue.ts:processNext()`
- **Root Cause**: `queueMicrotask(() => this.processNext())` in `finally` block ran unconditionally
- **Symptom**: CPU spike, UI freeze, infinite loop
- **Fix**: Created `scheduleNextIfQueued()` that only schedules when queue has queued tasks
- **Impact**: UI freeze resolved, CPU spike eliminated

**Code Before (Broken):**
```typescript
async processNext(): Promise<void> {
  try {
    // ... process task ...
  } finally {
    queueMicrotask(() => this.processNext()); // Always runs, even when queue empty
  }
}
```

**Code After (Fixed):**
```typescript
async processNext(): Promise<void> {
  try {
    // ... process task ...
  } finally {
    this.scheduleNextIfQueued(); // Only schedules if queue has queued tasks
  }
}

scheduleNextIfQueued(): void {
  if (this.tasks.some(t => t.status === "queued")) {
    queueMicrotask(() => this.processNext());
  }
}
```

### Emergency Response Pattern

**Pattern Identified:**
1. Emergency stop → External review → CODE RED assignments → Fix attempts → Pause → Next attempt
2. Multiple "wip: phase-0 paused" commits indicate reactive debugging
3. High-risk changes made during debugging cycles (SDK migration in eff6f21)
4. Breakthrough fix followed by cleanup checkpoints

**Lessons Learned:**
- Systematic root cause analysis needed before fixes
- High-risk changes should be separate from bug fixes
- External review valuable for architectural issues
- Cleanup checkpoints important after major fixes

## Performance Optimization Analysis

### HNSW Vector Store Performance

**Initial State:**
- **Load Time**: 36 seconds for 22,313 documents
- **Bottleneck**: Synchronous iteration over all documents
- **Impact**: UI frozen during startup

**Optimization 1: Native Caching**
- **Commit**: `7e9db421`
- **Change**: Added native caching to IndexedDB
- **Impact**: Reduced subsequent loads, but initial load still slow

**Optimization 2: Batched Loading**
- **Commit**: `f71a19de`
- **Change**: Process 1000 documents per batch with `setTimeout(0)` yields
- **Impact**: Prevents UI freeze, but load time still >3s target

**Current State:**
- **Load Time**: Still >3s (target not achieved)
- **Batching**: Added, prevents UI freeze
- **Remaining**: More optimization needed

**Next Steps:**
- Investigate WASM performance bottlenecks
- Consider incremental loading (load on demand)
- Optimize IndexedDB writes

### ChunkStore Performance

**Initial State:**
- **Load Time**: Sequential file reads, slow for large vaults
- **Bottleneck**: Sequential `await` operations

**Optimization: Parallel Loading**
- **Commit**: `a032925`
- **Change**: Batched `Promise.all()` (50 files per batch)
- **Impact**: Load time reduced from seconds to 243ms

**Current State:**
- **Load Time**: 243ms for 542 notes, 29,050 chunks
- **Status**: ✅ OPTIMIZED

### IndexManager Performance

**Initial State:**
- **Load Time**: Heavy JSON.parse operations block UI
- **Bottleneck**: Synchronous JSON parsing

**Optimization 1: JSON Yielding**
- **Commit**: `3c25b10`
- **Change**: `setTimeout(0)` yield before heavy JSON.parse operations
- **Impact**: Prevents UI freeze during parsing

**Optimization 2: Progress Events**
- **Commit**: `c5a5caf`
- **Change**: Stage-based progress logging (Stage 1-4)
- **Impact**: Users see progress instead of frozen screen

**Current State:**
- **Load Time**: Non-blocking, progress visible
- **Status**: ✅ OPTIMIZED

## Code Quality Analysis

### Lint Fix Patterns

**Major Lint Fix Commits:**
1. **ace3b84** (2026-01-11 11:12): "fix: resolve all lint warnings across codebase"
   - **Changes**: 42 files, +3,317/-2,141
   - **Impact**: Comprehensive lint fixes before emergency stop

2. **969c342** (2026-01-11 09:14): "fix: resolve lint errors across codebase"
   - **Changes**: 42 files, +143/-128
   - **Impact**: Ongoing code quality maintenance

3. **05a5008** (2026-01-11 09:20): "fix(01-03): resolve lint errors across codebase"
   - **Changes**: 11 files, +45/-20
   - **Impact**: Phase 1 Plan 3 lint fixes

**Pattern**: Multiple lint fix commits indicate ongoing code quality maintenance

### Code Complexity Reduction

**eff6f21 Commit:**
- **Extracted helpers**: `runTask()`, `scheduleNextIfQueued()` in `taskQueue.ts`
- **Extracted helpers**: `wrapEmbedError()` in `ollama.ts`
- **Rationale**: Reduce cognitive complexity (Biome lint)

**Pattern**: Helper extraction for complexity reduction

### Dead Code Removal

**098bd1c Commit:**
- **Removed**: 2,385 lines across 30 files
- **Key Removals**:
  - `taskQueue.ts`: -280 lines
  - `chiefOfStaff.ts`: -158 lines
  - `App.tsx`: -236 lines
  - `appHandlers.ts`: -286 lines
  - `Omnibar.tsx`: -316 lines
  - `useAppEvents.ts`: -224 lines

**Pattern**: Aggressive simplification after debugging cycles

**Remaining Dead Code:**
- `chatAgent.ts`: 248 lines (Phase 0 Issue 5)
- `commandParser.ts`: 46 lines (already removed in 098bd1c)

---

## Summary of Key Learnings

### Architectural Evolution

**From Prototype to Production:**
1. **Initial State**: Simple REST API-based LLM providers, sequential processing
2. **CODE RED**: HNSW migration, error boundaries, App.tsx refactor
3. **SDK Migration**: REST → Native SDKs for better async handling
4. **Performance Optimization**: Batching, yielding, parallelization
5. **Current State**: Mature architecture with foundational stability issues

**Key Architectural Shifts:**
- **LLM Provider**: REST API → Native SDK (`@lmstudio/sdk`)
- **Vector Store**: SimpleVectorStore → HNSW WASM with native caching
- **Event Handling**: Direct calls → QueueMicrotask wrappers
- **Task Execution**: Synchronous → Sequential with yields
- **UI Architecture**: Monolithic → Hooks-based with error boundaries

### Development Patterns

**Reactive Debugging:**
- Multiple "wip: phase-0 paused" commits indicate iterative debugging
- Emergency stops followed by external reviews
- High-risk changes made during debugging cycles
- Breakthrough fixes followed by cleanup checkpoints

**Code Quality Maintenance:**
- Multiple lint fix commits indicate ongoing maintenance
- Helper extraction for complexity reduction
- Aggressive simplification after debugging cycles
- Dead code removal in cleanup checkpoints

**Performance Optimization:**
- Focus on batching, yielding, and parallelization
- Native caching for fast startup
- Progress events for user feedback
- Target-driven optimization (<3s startup)

### Critical Path Analysis

**Phase 0 Foundation Repair:**
- **Status**: 0/8 issues resolved
- **Blockers**: Action ID mismatch, event emission, action applier wiring
- **Critical Path**: Fix action ID mismatch → Wire events → Wire applier → Optimize embeddings
- **Estimated**: 14.5 hours

**Phase 1 Agent Architecture:**
- **Status**: 3/3 plans complete, but issues merged into Phase 0
- **Accomplishments**: Chat as UI, Connection rename, Quick Actions structure
- **Remaining**: Fix action ID mismatch, remove dead ChatAgent code
- **Re-scope**: Pending after Phase 0 completion

**Future Phases:**
- **Blocked**: All phases 02-08 blocked by Phase 0
- **Dependencies**: Foundation repair must complete before feature work
- **Impact**: All feature work on hold until foundation stable

### Risk Assessment

**High Risk Areas:**
1. **Action ID Mismatch** (CRITICAL): Quick Actions broken, core feature non-functional
2. **Event Emission** (CRITICAL): Pending actions UI broken, users can't see progress
3. **Action Applier** (CRITICAL): Apply button non-functional, users can't apply actions
4. **HNSW Performance** (HIGH): Startup time >3s target, poor UX
5. **Reranker JSON** (HIGH): Silent failures ~10%, search reliability impacted

**Medium Risk Areas:**
1. **Sequential Embeddings** (CRITICAL but low complexity): Indexing 8x slower
2. **Dead Code** (LOW): Maintenance burden, confusion
3. **FS.syncfs Race** (LOW): Console noise, potential data corruption

**Mitigation Strategies:**
- Complete Phase 0 foundation repair before feature work
- Systematic root cause analysis before fixes
- Separate high-risk changes from bug fixes
- External review for architectural issues
- Cleanup checkpoints after major fixes

### Recommendations

**Immediate Actions:**
1. Fix Reranker JSON parsing (Issue 3) - quick win, improves search reliability
2. Wire action:proposed event (Issue 6) - unblocks pending actions UI
3. Wire action applier (Issue 7) - makes Apply button functional
4. Fix action ID mismatch (Issue 2) - makes Quick Actions functional
5. Parallelize embeddings (Issue 1) - major performance win

**Short-term Actions:**
1. Remove dead ChatAgent code (Issue 5) - reduces confusion
2. Fix FS.syncfs race (Issue 4) - reduces console noise
3. Wire capability cards (Issue 8) - shows real system health
4. Verify CODE RED completion - ensure all goals met
5. Test with real vault (895+ notes) - validate performance

**Long-term Actions:**
1. Resolve deferred issues (ISSUES.md) - production readiness
2. Architectural cleanup - consolidate patterns, stabilize event emission
3. Performance optimization - achieve <3s startup target
4. Code quality - reduce complexity, improve maintainability

### Success Metrics

**Phase 0 Completion Criteria:**
- [ ] All 8 issues resolved
- [ ] Quick Actions functional (no action ID mismatch)
- [ ] Pending actions UI populated (event emission working)
- [ ] Apply button functional (action applier wired)
- [ ] Indexing performance improved (8x speedup)
- [ ] Search reranking reliable (100% success rate)
- [ ] Dead code removed (ChatAgent deleted)
- [ ] Console noise reduced (FS.syncfs race fixed)
- [ ] Capability cards show real status (HealthMonitor wired)

**CODE RED Verification:**
- [ ] App.tsx <500 lines (verify current state)
- [ ] Error boundaries wrap all UI components
- [ ] HNSW integration complete (no fallback to SimpleVectorStore)
- [ ] Large vault performance validated (895+ notes)
- [ ] Startup time <3s (HNSW optimization complete)

**Production Readiness:**
- [ ] All deferred issues resolved (ISSUES.md)
- [ ] Architectural cleanup complete
- [ ] Performance targets achieved
- [ ] Code quality maintained
- [ ] User acceptance testing passed

---

*Analysis complete. No code changes made (research only).*  
*Analysis depth: Deep (48-hour commit-by-commit, full planning folder review, cross-referenced patterns)*  
*Total lines: 2,000+ (expanded from 633 lines)*  
*Analysis date: 2026-01-12*
