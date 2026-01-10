# Faye - Phase 1 Diagnosis (Frontend)

> **Status**: ASSIGNED
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Branch**: `ALPHA-SPEC-SPRINT` (shared with all engineers)
> **Duration**: 1-2 hours (diagnosis only)

---

## Git Workflow (CRITICAL - SHARED IDE)

### Rule 1: You're Already on the Right Branch
```bash
# Check current state
git status
git branch   # Should show: * ALPHA-SPEC-SPRINT
```

**NEVER switch branches** - you're already on `ALPHA-SPEC-SPRINT`.
Archie and Sage are working on this same branch. Switching affects ALL terminals.

### Rule 2: Check What YOU Changed (Before Staging)
```bash
git diff --name-only    # See which files are modified
git diff src/ui/sidebar/App.tsx   # See your exact changes
```

### Rule 3: During Diagnosis
You will add temporary debug logging to these files:
- `src/ui/sidebar/components/QuickActions.tsx`
- `src/ui/sidebar/App.tsx`
- `src/ui/sidebar/context/KernelContext.tsx`

**Rule**: Only add console.log statements, DO NOT change logic.

### Rule 4: Stage ONLY YOUR Files (ONE BY ONE)

```bash
# Check what changed (includes YOUR changes + possibly others')
git status

# Stage ONLY files YOU modified in THIS session
git add src/ui/sidebar/components/QuickActions.tsx
git add src/ui/sidebar/App.tsx
git add src/ui/sidebar/context/KernelContext.tsx   # ONLY if you modified it
git add planning/orchestration/faye/REPORT.md

# Verify ONLY your files are staged
git status   # Staged files should match what YOU edited
```

**CRITICAL - What NOT to do**:
- ❌ `git add .` - Stages EVERYTHING (including Archie's work)
- ❌ `git add src/ui/**` - Wildcards catch unrelated files
- ❌ `git add -A` - Stages all changes in repo
- ❌ Staging files you didn't touch in this session
- ❌ Staging orchestration files (ORCHESTRATOR.md, phase-1-breakdown.md)

### Rule 5: Commit with Clear Message

```bash
git commit -m "chore(phase-1): Frontend diagnosis with debug logging

Added console.log statements to trace:
- QuickActions button click handlers
- triggerAgenticAction callback execution
- useService hook return values
- Modal click handlers (Footer)

Findings documented in faye/REPORT.md.
Root cause: [brief summary from your report]"
```

### Rule 6: NEVER Push

```bash
# ❌ NEVER DO THIS - CEO handles all pushes
git push
```

---

### Git Rules Summary
1. ✅ You're on `ALPHA-SPEC-SPRINT` (shared branch)
2. ✅ Stage files ONE BY ONE with explicit paths
3. ✅ Verify with `git status` before commit
4. ❌ NEVER use `git add .` or wildcards
5. ❌ NEVER switch branches (`git checkout`)
6. ❌ NEVER push (`git push`)
7. ❌ NEVER stage orchestration files (unless you're Chief of Staff)

---

## Context

User reports: "Buttons don't work (Quick Actions, Footer), app crashes under load"

**Your job**: Diagnose frontend/UI issues (event handlers, signals, component wiring)

**Archie's job** (running in parallel): Diagnose backend/service integration issues

**Coordination**: You both write findings in your REPORT.md, Chief of Staff reads both and determines root cause.

---

## Assignment: Frontend UI Diagnosis

### Objectives

1. **Test button click handlers** - Do onClick events fire?
2. **Verify signal reactivity** - Are signals updating components?
3. **Check service availability** - Is `useService()` returning null?
4. **Inspect browser console** - What errors appear when buttons clicked?
5. **Document findings** - Write detailed REPORT.md

---

## Specific Tasks

### Task 1: Add Debug Logging to Click Handlers

**Files**:
- `src/ui/sidebar/components/QuickActions.tsx`
- `src/ui/sidebar/App.tsx`

**Add console.log statements**:

1. In `QuickActions.tsx`, line 51-53 (ActionButton handleClick):
   ```typescript
   const handleClick = useCallback(() => {
     console.log('[QuickActions] Button clicked:', action.id);
     action.onClick();
     console.log('[QuickActions] onClick called successfully');
   }, [action.onClick]);
   ```

2. In `App.tsx`, line 471-496 (`triggerAgenticAction`):
   ```typescript
   const triggerAgenticAction = useCallback((prompt, taskType) => {
     console.log('[triggerAgenticAction] Called with:', { prompt, taskType });
     console.log('[triggerAgenticAction] taskQueue:', taskQueue);
     console.log('[triggerAgenticAction] noteVitals:', noteVitals.value);

     if (taskQueue && noteVitals.value) {
       // existing code...
     } else {
       console.error('[triggerAgenticAction] FAILED - missing:', {
         hasTaskQueue: !!taskQueue,
         hasNoteVitals: !!noteVitals.value
       });
     }
   }, [taskQueue, noteVitals]);
   ```

3. In `App.tsx`, lines 726-743 (modal click handlers):
   ```typescript
   const openModelSelector = useCallback(() => {
     console.log('[openModelSelector] Called');
     new ModelSelectorModal(app, kernel, currentModel).open();
   }, [app, kernel]);

   const openIndexDashboard = useCallback(() => {
     console.log('[openIndexDashboard] Called');
     new IndexDashboardModal(app, kernel, indexStatus.value).open();
   }, [app, kernel]);
   ```

**Test**:
- Build plugin: `bun run dev`
- Open vaultex in Obsidian
- Open DevTools (Ctrl+Shift+I)
- Click Quick Actions, Footer buttons
- Check console output

**Document**: Console logs and any errors in REPORT.md

---

### Task 2: Verify Signal Reactivity

**Signals to check**:
- `activeAgents.value` - Updates when task enqueued?
- `chatMessages.value` - Updates when message sent?
- `searchResults.value` - Updates when search executes?
- `noteVitals.value` - Updates when note changes?

**Test**:
1. Add console.log in signal setters
2. Trigger actions that should update signals
3. Check if components re-render

**Check**:
- [ ] Are signals imported from correct file (`src/ui/sidebar/state.ts`)?
- [ ] Are signal values accessed with `.value`?
- [ ] Are signals being set correctly (`.value = newValue`)?

**Document**: Which signals work vs broken in REPORT.md

---

### Task 3: Check useService Hook

**File**: `src/ui/sidebar/context/KernelContext.tsx`

**Verify**:
1. Is `useService()` hook correctly implemented?
2. Does it return null when service not registered?
3. Add logging to see what it returns:

```typescript
export function useService<T>(serviceName: string): T | null {
  const kernel = useKernel();
  const service = kernel.getService<T>(serviceName);
  console.log('[useService]', serviceName, '→', service);
  return service;
}
```

**Test**:
- Build and check console
- See if taskQueue, actionApplier, etc. return null

**Document**: Which services are null in REPORT.md

---

### Task 4: Inspect Callback Dependencies

**Files**: `src/ui/sidebar/App.tsx`

**Check useCallback dependencies** (common Preact bug):

1. Line 471 (`triggerAgenticAction`):
   - Dependencies: `[taskQueue, noteVitals]`
   - Are these stable or changing on every render?

2. Line 712 (`createNoteQuickActions`):
   - Dependencies: `[noteVitals.value?.title, triggerAgenticAction, prefillChatAndSwitch]`
   - Is this causing unnecessary re-creates?

**Look for**:
- Missing dependencies (ESLint warnings)
- Stale closures (callback references old values)
- Over-specified dependencies (causes re-renders)

**Document**: Callback binding issues in REPORT.md

---

### Task 5: Browser Console Error Inspection

**Test in vaultex**:
1. Open Obsidian DevTools
2. Clear console
3. Click Quick Actions buttons one by one
4. Click Footer zones
5. Try Omnibar search
6. Try Omnibar command (`/enhance`)

**Capture**:
- Screenshots of errors (if any)
- Full error stack traces
- Network tab (if relevant - API calls failing?)

**Document**: All console errors verbatim in REPORT.md

---

## Diagnosis Scenarios

### Scenario A: Click Handlers Not Firing
**If** console logs don't appear when buttons clicked:

**Your REPORT.md should state**:
```
ROOT CAUSE: Event handlers not bound
- onClick props not reaching DOM elements
- Possible cause: JSX syntax error, Preact version mismatch

FIX REQUIRED: Fix event binding in components
ESTIMATED EFFORT: 2 hours
```

### Scenario B: Handlers Fire, Services Null
**If** logs appear but taskQueue/services are null:

**Your REPORT.md should state**:
```
ROOT CAUSE: Services not available in UI
- useService() returns null for taskQueue, actionApplier
- Backend issue (Archie's domain)

CONCLUSION: Wait for Archie's backend diagnosis
NEXT STEP: Add graceful UI degradation
```

### Scenario C: Signals Not Reactive
**If** signals don't trigger re-renders:

**Your REPORT.md should state**:
```
ROOT CAUSE: Signal reactivity broken
- activeAgents.value updates but UI doesn't re-render
- Possible cause: Component not subscribed, wrong import

FIX REQUIRED: Fix signal subscriptions in components
ESTIMATED EFFORT: 2-3 hours
```

### Scenario D: Everything Looks Correct
**If** handlers fire, services exist, signals reactive:

**Your REPORT.md should state**:
```
FRONTEND STATUS: All UI healthy
- Click handlers firing ✓
- Services available ✓
- Signals reactive ✓

CONCLUSION: Issue is likely backend (Archie's domain)
NEXT STEP: Wait for Archie's findings
```

---

## Deliverables

### File: `planning/orchestration/faye/REPORT.md`

**Structure**:
```markdown
# Faye - Phase 1 Diagnosis Report

> **Status**: COMPLETE
> **Date**: 2026-01-10
> **Branch**: ALPHA-SPEC-SPRINT

## Summary

[One paragraph: what you found, root cause hypothesis]

## Click Handler Test Results

| Component | Button/Action | Console Log? | Error? |
|-----------|---------------|--------------|--------|
| QuickActions | Find | YES/NO | [error] |
| QuickActions | Link | YES/NO | [error] |
| QuickActions | Enrich | YES/NO | [error] |
| Footer | Providers | YES/NO | [error] |
| Footer | Index | YES/NO | [error] |
| Omnibar | Search | YES/NO | [error] |
| Omnibar | /enhance | YES/NO | [error] |

## Signal Reactivity

[Which signals update correctly, which don't]

## useService Results

| Service | Available? | Type |
|---------|------------|------|
| taskQueue | YES/NO | AgentTaskQueue / null |
| actionApplier | YES/NO | ActionApplier / null |
| workflowRunner | YES/NO | WorkflowRunner / null |

## Callback Dependencies

[Any issues with useCallback dependencies?]

## Console Errors

```
[Paste full error messages here]
```

## Root Cause Hypothesis

[Scenario A/B/C/D - what you think is broken]

## Recommended Fix

[What needs to be implemented, estimated effort]

## Next Steps

[Wait for Archie's report, or proceed with fix if clear]
```

---

### Diagnosis Only - No Fixes Yet

**IMPORTANT**: This is diagnosis only. DO NOT implement fixes yet.

The console.log statements are temporary for diagnosis. Add debug logging to trace execution, write findings in REPORT.md, then commit using the git workflow above.

After diagnosis, Chief of Staff will tell you whether to remove logs or proceed with fixes.

---

## Coordination with Archie

Archie is diagnosing backend services in parallel. Combined findings will reveal:
- Frontend issue only → you fix
- Backend issue only → Archie fixes
- Both broken → both fix (sequential: Archie first)

Chief of Staff will read BOTH reports and determine next steps.

---

## Timeline

- **Start**: As soon as you read this
- **Duration**: 1-2 hours
- **End**: When REPORT.md is written and committed
- **Next**: Wait for Chief of Staff to review both reports

---

## Questions?

If you're unsure about something, document the uncertainty in REPORT.md:
```
UNCERTAINTY: Can't tell if signal is reactive
REASON: Component doesn't visibly change when signal updates
RECOMMENDATION: Add visual indicator to test
```

---

**Ready? Read this TASK.md and begin diagnosis. Write findings to REPORT.md.**
