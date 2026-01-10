# ALPHA-SPEC Phase 1: Foundation - Work Breakdown

> **Status**: Planning Complete
> **Created**: 2026-01-10
> **Orchestrator**: Root session

---

## Executive Summary

**Goal**: Fix broken functionality and establish baseline for ALPHA-SPEC implementation

**User Priority**: Button clicks not working across UI (Quick Actions, Footer, Omnibar commands)

**Approach**: "Function first, form later" - Fix wiring and integration, enhance UI in later phases

**Scope**: Full baseline audit of all features, joint Archie + Faye debugging

---

## Problem Analysis

### Symptoms (User Report)
1. Quick Actions buttons don't trigger workflows
2. Footer zone interactions fail (Model selector, Index dashboard)
3. App crashes under load
4. Buttons may be correctly implemented but not wired to backend pipelines

### Code Audit Findings

#### ✅ What's Correct
- **Omnibar component** (`src/ui/sidebar/components/Omnibar.tsx`):
  - Search execution via SearchPipeline (lines 118-143)
  - Command parsing and execution (lines 146-219)
  - Event handlers properly bound

- **QuickActions component** (`src/ui/sidebar/components/QuickActions.tsx`):
  - ActionButton has onClick handler (line 59)
  - Factory function creates actions with callbacks (lines 87-164)

- **App.tsx integration**:
  - QuickActions receives `triggerAgenticAction` callback (line 715)
  - `triggerAgenticAction` enqueues tasks via taskQueue (lines 471-496)
  - Footer callbacks open modals (lines 726-750)

#### ⚠️ Potential Issues
1. **Service availability**: `taskQueue` from `useService()` may be null/undefined (line 61)
2. **Kernel initialization**: Services may crash during startup
3. **Event propagation**: EventBus or signal reactivity issues
4. **Missing error handling**: Silent failures when services unavailable
5. **Race conditions**: UI rendering before services ready

---

## Phase 1 Breakdown

### Step 1: Joint Diagnosis (Archie + Faye)
**Duration**: 1-2 hours
**Goal**: Identify root cause (service registration, event bus, or UI wiring)

**Archie's Responsibilities**:
1. Verify kernel service registration in `src/core/kernel.ts`:
   - Is `taskQueue` registered?
   - Is `actionApplier` registered?
   - Is `workflowRunner` registered?
   - Is `actionOrchestrator` registered?
2. Check service initialization order and dependencies
3. Add defensive error handling and logging to kernel service getter
4. Test `triggerAgenticAction` pathway manually
5. Verify EventBus is functioning (pub/sub working)
6. Document findings in `planning/orchestration/archie/REPORT.md`

**Faye's Responsibilities**:
1. Add console logging to button click handlers:
   - QuickActions onClick (line 59 in QuickActions.tsx)
   - SystemDashboard callbacks (lines 741-750 in App.tsx)
2. Verify signals are reactive (activeAgents, chatMessages, etc.)
3. Check if `useService()` hook returns null when buttons clicked
4. Test Omnibar search manually and check results callback
5. Inspect browser DevTools for React/Preact errors
6. Document findings in `planning/orchestration/faye/REPORT.md`

**Coordination**:
- Both work in parallel for 30-60 min
- Share findings in respective REPORT.md files
- Orchestrator reviews both reports and determines next step

---

### Step 2: Fix Root Cause (Sequential: Archie → Faye)
**Duration**: 2-4 hours
**Goal**: Implement fix based on diagnosis findings

#### Scenario A: Service Registration Issue
**If**: Archie finds services not registered or initialization failing

**Archie implements**:
1. Register missing services in kernel.ts
2. Fix initialization order dependencies
3. Add service health checks
4. Add fallback/error states for missing services
5. Commit: `fix(kernel): Register missing services and add health checks`

**Faye implements** (after Archie commits):
1. Add UI error states when services unavailable
2. Disable buttons gracefully when services not ready
3. Show user-friendly errors instead of silent failures
4. Commit: `fix(ui): Add graceful degradation for missing services`

#### Scenario B: Event Bus/Signal Issue
**If**: Faye finds signals not reactive or EventBus broken

**Archie implements** (if EventBus issue):
1. Fix EventBus registration or pub/sub mechanism
2. Add EventBus health check
3. Commit: `fix(events): Restore EventBus functionality`

**Faye implements**:
1. Fix signal reactivity issues in components
2. Ensure useService hook properly subscribes to changes
3. Add debugging aids (signal state inspector)
4. Commit: `fix(ui): Restore signal reactivity in components`

#### Scenario C: Callback Binding Issue
**If**: Callbacks are lost/unbound during render

**Faye implements**:
1. Fix useCallback dependencies
2. Ensure callbacks persist across re-renders
3. Add memoization where needed
4. Commit: `fix(ui): Fix callback binding in Quick Actions`

---

### Step 3: Baseline Audit (Archie + Faye)
**Duration**: 2-3 hours
**Goal**: Systematically test all features, document what works/breaks

**Test Checklist** (both agents verify):

#### Omnibar
- [ ] Type query → press Enter → search executes
- [ ] Results appear in dropdown
- [ ] Click result → note opens
- [ ] Type `/enhance` → command suggestions appear
- [ ] Execute `/enhance` command → workflow triggers
- [ ] Search preset cycling works (Quick/Balanced/Deep button)

#### Quick Actions
- [ ] "Find" button → agent task enqueues
- [ ] "Link" button → agent task enqueues
- [ ] "Enrich" button → agent task enqueues
- [ ] "Tags" button → agent task enqueues
- [ ] "Summary" button → chat prefills
- [ ] "Tasks" button → chat prefills

#### Footer/SystemDashboard
- [ ] Click Providers → Model selector modal opens
- [ ] Click Index → Index dashboard modal opens
- [ ] Click Settings → Settings tab opens
- [ ] Status indicators reflect true service state

#### Chat
- [ ] Type message → press Enter → message sends
- [ ] LLM response streams properly
- [ ] Thinking blocks parse correctly
- [ ] Vault-wide toggle works (if implemented)

#### Agent Streams View
- [ ] Active agents appear when tasks enqueue
- [ ] Progress updates display
- [ ] Completed tasks move to Recent Activity
- [ ] View Results button works

#### Crashes Under Load
- [ ] Index large vault (>500 notes) without crash
- [ ] Run multiple agents concurrently without crash
- [ ] Switch notes rapidly without crash
- [ ] Reload plugin without data loss

**Deliverable**: Joint test report in `planning/orchestration/phase-1-test-results.md`

---

### Step 4: Simplification (Sage)
**Duration**: 1-2 hours
**Goal**: Review fixes for code quality, DRY, patterns

**Sage's Responsibilities**:
1. Review Archie's kernel/service fixes
2. Review Faye's UI error handling
3. Extract common patterns
4. Simplify error handling logic
5. Ensure defensive coding practices
6. Commit: `refactor(phase-1): Simplify error handling and service checks`
7. Write `planning/orchestration/sage/REPORT.md`

---

## Success Criteria

### Phase 1 Complete When:
1. ✅ All Quick Action buttons trigger workflows
2. ✅ Omnibar search returns results
3. ✅ Omnibar commands execute
4. ✅ Footer interactions work (modals open)
5. ✅ Chat sends messages and receives responses
6. ✅ Agent Streams view shows active tasks
7. ✅ No crashes when indexing large vaults
8. ✅ No crashes when switching notes rapidly
9. ✅ TypeScript compilation passes
10. ✅ Build succeeds without warnings

### Testing Requirements
- [ ] Manual testing in vaultex (`/mnt/c/Users/akougk/Projects/vaultex`)
- [ ] User approves functionality before proceeding to Phase 2
- [ ] All baseline features work as documented

---

## Orchestration Flow

### Stage 1: Diagnosis (Parallel)
```bash
# Terminal 1 (Archie)
claude "Read and execute planning/orchestration/archie/TASK.md"

# Terminal 2 (Faye)
claude "Read and execute planning/orchestration/faye/TASK.md"

# Both run for 30-60 min, write REPORT.md
```

**Orchestrator Actions**:
1. Wait for both reports
2. Read both REPORT.md files
3. Identify root cause from combined findings
4. Determine which scenario (A, B, or C) applies
5. Update TASK.md files with implementation assignments

---

### Stage 2: Implementation (Sequential)
```bash
# Terminal 1 (Archie first for backend fixes)
claude "Read and execute planning/orchestration/archie/TASK.md"

# Wait for Archie commit, then...

# Terminal 2 (Faye for UI fixes)
claude "Read and execute planning/orchestration/faye/TASK.md"
```

**Orchestrator Actions**:
1. Verify Archie's commit (`git log --oneline -3`)
2. Read Archie's REPORT.md
3. Run `bun run typecheck` and `bun run build`
4. Assign Faye's implementation task
5. Verify Faye's commit
6. Run build verification again

---

### Stage 3: Baseline Audit (Parallel)
```bash
# Both agents test systematically
# Share findings in joint document
```

**Orchestrator Actions**:
1. Review test results document
2. Identify any remaining issues
3. Create follow-up tasks if needed

---

### Stage 4: Simplification (Sage)
```bash
# Terminal 3 (Sage)
claude "Read and execute planning/orchestration/sage/TASK.md"
```

**Orchestrator Actions**:
1. Verify Sage's commit
2. Read Sage's REPORT.md
3. Run final build verification
4. Mark Phase 1 COMPLETE
5. Begin Phase 2 planning

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Root cause is architectural (requires refactor) | Medium | High | Timebox diagnosis to 2 hours, escalate if unsolved |
| Multiple independent issues (not systemic) | Medium | Medium | Fix highest-impact issue first, iterate |
| User vault too large for testing | Low | Low | Test with smaller vault first |
| Agents duplicate work during parallel diagnosis | Low | Low | Clear division of responsibilities in TASK.md |

---

## Next Steps After Phase 1

### If All Tests Pass:
→ Proceed to **Phase 2: Progressive Search** (ALPHA-SPEC)
- Wire Omnibar to instant → evolving → deep flow
- Add shimmer effect for AI evaluation
- Route deep results to Insights Stream

### If Critical Issues Remain:
→ Create **Phase 1.5: Stability** (1-2 days)
- Address crashes under load
- Fix race conditions
- Add comprehensive error boundaries
- **THEN** proceed to Phase 2

---

## Files to Monitor

### Archie's Focus:
- `src/core/kernel.ts` - Service registration
- `src/core/events/eventBus.ts` - Event system
- `src/core/agent/taskQueue.ts` - Task queueing
- `src/core/agentic/actionApplier.ts` - Action execution
- `src/core/agentic/workflowRunner.ts` - Workflow execution

### Faye's Focus:
- `src/ui/sidebar/App.tsx` - Main integration
- `src/ui/sidebar/components/QuickActions.tsx` - Button handlers
- `src/ui/sidebar/components/Omnibar.tsx` - Search/command input
- `src/ui/sidebar/components/SystemDashboard.tsx` - Footer
- `src/ui/sidebar/context/KernelContext.tsx` - useService hook

### Sage's Focus:
- All files modified by Archie and Faye
- Look for duplication, complexity, missing abstractions

---

## Communication Protocol

### Archie → Orchestrator:
"I've completed Phase 1 diagnosis/implementation. Findings in archie/REPORT.md. Committed as [commit hash]."

### Faye → Orchestrator:
"I've completed Phase 1 diagnosis/implementation. Findings in faye/REPORT.md. Committed as [commit hash]."

### Sage → Orchestrator:
"I've simplified Phase 1 code. Changes in sage/REPORT.md. Committed as [commit hash]."

### Orchestrator → User:
"Phase 1 [stage] complete. Ready for testing in vaultex. Please verify: [checklist]."

---

## Estimated Timeline

| Stage | Duration | Agents | Deliverable |
|-------|----------|--------|-------------|
| Diagnosis | 1-2 hours | Archie + Faye (parallel) | Joint diagnosis reports |
| Implementation | 2-4 hours | Archie → Faye (sequential) | Bug fixes committed |
| Baseline Audit | 2-3 hours | Archie + Faye (parallel) | Test results document |
| Simplification | 1-2 hours | Sage | Code cleanup committed |
| **Total** | **6-11 hours** | **3 agents** | **Baseline functionality restored** |

**User Involvement**: 30 min for vaultex testing and approval

---

*Phase 1 breakdown complete. Ready to assign tasks to agents.*
