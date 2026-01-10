# Archie - Phase 1 Diagnosis (Backend)

> **Status**: ASSIGNED
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Branch**: `archie/backend-fixes`
> **Duration**: 1-2 hours (diagnosis only)

---

## Git Workflow (CRITICAL)

### Before Starting
```bash
git status
git diff --name-only
```
**Check**: Are you on `archie/backend-fixes` branch? Are there uncommitted changes?

If you need to switch branches:
```bash
git checkout archie/backend-fixes
```

### During Diagnosis
You will add temporary debug logging to these files:
- `src/core/agent/taskQueue.ts`
- `src/core/agents/chiefOfStaff.ts`
- `src/core/kernel.ts` (possibly)
- `src/core/events/eventBus.ts` (possibly)

**Rule**: Only add console.log statements, DO NOT change logic.

### After Completing Diagnosis

Stage ONLY the files you modified + your REPORT.md:
```bash
# Check what you modified
git status

# Stage only your changes
git add src/core/agent/taskQueue.ts
git add src/core/agents/chiefOfStaff.ts
git add src/core/kernel.ts                    # if modified
git add src/core/events/eventBus.ts           # if modified
git add planning/orchestration/archie/REPORT.md

# Commit with descriptive message
git commit -m "chore(phase-1): Backend diagnosis with debug logging

Added console.log statements to trace:
- taskQueue.enqueue() execution
- ChiefOfStaff routing logic
- Service registration checks
- EventBus pub/sub flow

Findings documented in archie/REPORT.md.
Root cause: [brief summary from your report]"

# DO NOT PUSH - only local commit
```

### Rules
- **NO `git push`** - Only local commits
- **NO `git add .`** - Stage specific files only
- **NO amending** other commits - Create new commit
- **NO branch switching** during work - Stay on archie/backend-fixes

---

## Context

User reports: "Buttons don't work (Quick Actions, Footer), app crashes under load"

**Your job**: Diagnose backend/service integration issues

**Faye's job** (running in parallel): Diagnose frontend/UI issues

**Coordination**: You both write findings in your REPORT.md, Orchestrator reads both and determines root cause.

---

## Assignment: Backend Service Diagnosis

### Objectives

1. **Verify kernel service registration** - Are all required services registered?
2. **Check initialization order** - Do services initialize in correct order?
3. **Test service pathways** - Can UI successfully call backend services?
4. **Diagnose EventBus** - Is pub/sub working correctly?
5. **Document findings** - Write detailed REPORT.md

---

## Specific Tasks

### Task 1: Audit Kernel Service Registration

**File**: `src/core/kernel.ts`

**Check**:
- [ ] Is `taskQueue` (AgentTaskQueue) registered?
- [ ] Is `actionApplier` registered?
- [ ] Is `workflowRunner` registered?
- [ ] Is `actionOrchestrator` registered?
- [ ] Is `searchPipeline` registered?

**How**: Read kernel.ts, verify `kernel.register()` calls for each service

**Document**: List registered vs missing services in REPORT.md

---

### Task 2: Check Service Initialization

**Files**:
- `src/core/kernel.ts` (startup method)
- `src/main.ts` (plugin onload)

**Check**:
- [ ] What order do services initialize?
- [ ] Are there dependency chains (ServiceA needs ServiceB)?
- [ ] Do any services fail silently during init?
- [ ] Are there try/catch blocks that swallow errors?

**How**: Trace initialization flow from `main.ts` → `kernel.startup()`

**Document**: Initialization sequence and any failure points in REPORT.md

---

### Task 3: Test triggerAgenticAction Pathway

**Pathway**:
```
UI Button Click
  → triggerAgenticAction() in App.tsx
    → taskQueue.enqueue()
      → AgentTaskQueue processes
        → ChiefOfStaff routes
          → Agent executes
```

**Test**:
1. Add console.log in `src/core/agent/taskQueue.ts` at `enqueue()` method
2. Add console.log in ChiefOfStaff at routing logic
3. Manually trigger a Quick Action in vaultex
4. Check if logs appear

**Check**:
- [ ] Does enqueue() get called?
- [ ] Does task get processed?
- [ ] Where does the pathway break?

**Document**: Exact point of failure in REPORT.md

---

### Task 4: Verify EventBus Functionality

**File**: `src/core/events/eventBus.ts`

**Test**:
1. Add test emit/subscribe in kernel startup
2. Verify events propagate to subscribers
3. Check if UI components receive events

**Check**:
- [ ] Is EventBus registered in kernel?
- [ ] Can services emit events?
- [ ] Do UI components receive emitted events?

**Document**: EventBus health status in REPORT.md

---

### Task 5: Check for Silent Failures

**Files**: Any service with try/catch blocks

**Look for**:
- Services that catch errors but don't log them
- Services that return null/undefined on error
- Missing error boundaries

**Document**: List of silent failure points in REPORT.md

---

## Diagnosis Scenarios

### Scenario A: Services Not Registered
**If** you find taskQueue, actionApplier, or workflowRunner NOT registered in kernel:

**Your REPORT.md should state**:
```
ROOT CAUSE: Missing service registration
- taskQueue: NOT REGISTERED
- actionApplier: REGISTERED
- workflowRunner: NOT REGISTERED

FIX REQUIRED: Register missing services in kernel.ts startup()
ESTIMATED EFFORT: 1 hour
```

### Scenario B: Initialization Failure
**If** services are registered but fail during startup:

**Your REPORT.md should state**:
```
ROOT CAUSE: Service initialization crashes
- Service X depends on Service Y (not yet initialized)
- Error: [exact error message]

FIX REQUIRED: Reorder initialization, add dependency checks
ESTIMATED EFFORT: 2 hours
```

### Scenario C: EventBus Broken
**If** EventBus isn't working:

**Your REPORT.md should state**:
```
ROOT CAUSE: EventBus not functional
- Events emitted but not received
- Possible cause: [your hypothesis]

FIX REQUIRED: Fix EventBus registration/pub-sub
ESTIMATED EFFORT: 2-3 hours
```

### Scenario D: Everything Looks Correct
**If** all services are registered and initialized correctly:

**Your REPORT.md should state**:
```
BACKEND STATUS: All services healthy
- All services registered ✓
- Initialization succeeds ✓
- EventBus functional ✓

CONCLUSION: Issue is likely frontend (Faye's domain)
NEXT STEP: Wait for Faye's findings
```

---

## Deliverables

### File: `planning/orchestration/archie/REPORT.md`

**Structure**:
```markdown
# Archie - Phase 1 Diagnosis Report

> **Status**: COMPLETE
> **Date**: 2026-01-10
> **Branch**: `archie/backend-fixes`

## Summary

[One paragraph: what you found, root cause hypothesis]

## Service Registration Audit

| Service | Registered? | Initialize Order | Status |
|---------|-------------|------------------|--------|
| taskQueue | YES/NO | #N | OK/FAILED |
| actionApplier | YES/NO | #N | OK/FAILED |
| ... | ... | ... | ... |

## Initialization Flow

[List initialization sequence, note any failures]

## triggerAgenticAction Pathway Test

[Results of manual test - where does it break?]

## EventBus Health

[Is pub/sub working?]

## Silent Failure Points

[List any try/catch blocks that swallow errors]

## Root Cause Hypothesis

[Scenario A/B/C/D - what you think is broken]

## Recommended Fix

[What needs to be implemented, estimated effort]

## Next Steps

[Wait for Faye's report, or proceed with fix if clear]
```

---

### Diagnosis Only - No Fixes Yet

**IMPORTANT**: This is diagnosis only. DO NOT implement fixes yet.

Add debug logging to trace execution, write findings in REPORT.md, then commit using the git workflow above.

---

## Coordination with Faye

Faye is diagnosing frontend issues in parallel. You may find:
- Backend is healthy → issue is frontend
- Frontend is healthy → issue is backend
- Both have issues → multiple fixes needed

Orchestrator will read BOTH reports and determine next steps.

---

## Timeline

- **Start**: As soon as you read this
- **Duration**: 1-2 hours
- **End**: When REPORT.md is written and committed
- **Next**: Wait for Orchestrator to review both reports

---

## Questions?

If you're unsure about something, document the uncertainty in REPORT.md:
```
UNCERTAINTY: Could not determine if X is registered
REASON: Code path unclear at [file:line]
RECOMMENDATION: Need to add logging to confirm
```

---

**Ready? Read this TASK.md and begin diagnosis. Write findings to REPORT.md.**
