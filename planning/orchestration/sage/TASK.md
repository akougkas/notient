# Sage - Phase 1 Stage 1.5: Clean Up Debug Logging

> **Status**: COMPLETE
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Agent**: `code-simplifier:code-simplifier`
> **Branch**: `ALPHA-SPEC-SPRINT` (shared with all engineers)
> **Duration**: 1 hour

---

## Assignment

Faye added debug logging to diagnose bugs. Clean it up and create a simple, toggle-able logging utility we can use everywhere.

**What you'll do:**
1. Optimize Faye's 13 console.log statements (3 files)
2. Create simple `src/utils/debugLog.ts` helper
3. Replace scattered logs with the helper
4. Add toggle to disable in production
5. Document the pattern for future use

**Keep it simple** - this is basic software infrastructure, not rocket science.

---

## Git Workflow (CRITICAL - SHARED IDE)

```bash
# You're already on ALPHA-SPEC-SPRINT - don't switch branches
git status
git branch   # Should show: * ALPHA-SPEC-SPRINT

# After you're done, stage ONLY files YOU modified
git add src/ui/sidebar/App.tsx
git add src/ui/sidebar/components/QuickActions.tsx
git add src/ui/sidebar/context/KernelContext.tsx
git add src/utils/debugLog.ts                    # New file you create
git add planning/orchestration/sage/REPORT.md

# Commit
git commit -m "refactor(phase-1): Add simple debug logging utility

- Created debugLog helper with toggle
- Cleaned up Faye's 13 console.log statements
- Reduced log volume, added structure
- Toggle: DEBUG_ENABLED flag

Code review by Sage (code-simplifier)."

# NO PUSH
```

**Rules:**
- ❌ NEVER use `git add .`
- ❌ NEVER switch branches
- ❌ NEVER push

---

## Files to Optimize

Faye added debug logging to these 3 files:

1. **src/ui/sidebar/App.tsx** (10 logs added)
   - Lines 473-526: `triggerAgenticAction` callback (5 logs)
   - Lines 735-743: Modal click handlers (2 logs)

2. **src/ui/sidebar/components/QuickActions.tsx** (2 logs added)
   - Lines 51-55: ActionButton click handler

3. **src/ui/sidebar/context/KernelContext.tsx** (1 log added)
   - Lines 71-76: useService hook

**Total**: ~13 console.log statements

---

## What to Create

### File: `src/utils/debugLog.ts`

Create a simple debug logging utility:

```typescript
/**
 * Simple debug logging utility
 * Set DEBUG_ENABLED = true to see logs, false to disable
 */
const DEBUG_ENABLED = false; // Toggle point

export function debugLog(component: string, message: string, data?: any) {
  if (!DEBUG_ENABLED) return;

  if (data !== undefined) {
    console.log(`[${component}] ${message}`, data);
  } else {
    console.log(`[${component}] ${message}`);
  }
}

export function debugError(component: string, message: string, data?: any) {
  if (!DEBUG_ENABLED) return;

  if (data !== undefined) {
    console.error(`[${component}] ${message}`, data);
  } else {
    console.error(`[${component}] ${message}`);
  }
}
```

That's it. Simple, clean, works.

---

## How to Optimize Each File

### 1. App.tsx (triggerAgenticAction)

**Before** (5 verbose logs):
```typescript
console.log('[triggerAgenticAction] Called with:', { prompt, taskType });
console.log('[triggerAgenticAction] taskQueue:', taskQueue);
console.log('[triggerAgenticAction] noteVitals:', noteVitals.value);
// ... code ...
console.error('[triggerAgenticAction] FAILED - missing:', {
  hasTaskQueue: !!taskQueue,
  hasNoteVitals: !!noteVitals.value
});
```

**After** (2 structured logs):
```typescript
import { debugLog, debugError } from "../../../utils/debugLog";

debugLog('triggerAgenticAction', 'called', { prompt, taskType, hasTaskQueue: !!taskQueue, hasNoteVitals: !!noteVitals.value });
// ... code ...
if (!taskQueue || !noteVitals.value) {
  debugError('triggerAgenticAction', 'services unavailable', { hasTaskQueue: !!taskQueue, hasNoteVitals: !!noteVitals.value });
}
```

### 2. QuickActions.tsx (ActionButton)

**Before** (2 logs):
```typescript
console.log('[QuickActions] Button clicked:', action.id);
action.onClick();
console.log('[QuickActions] onClick called successfully');
```

**After** (1 log):
```typescript
import { debugLog } from "../../../utils/debugLog";

debugLog('QuickActions', `${action.id} clicked`);
action.onClick();
```

### 3. KernelContext.tsx (useService)

**Before** (1 log):
```typescript
const service = kernel.getService<T>(name);
console.log('[useService]', name, '→', service);
return service;
```

**After** (1 log, cleaner):
```typescript
import { debugLog } from "../../utils/debugLog";

const service = kernel.getService<T>(name);
debugLog('useService', name, { available: !!service });
return service;
```

---

## Goals

1. **Reduce log volume**: 13 logs → ~6-8 logs (less noise)
2. **Add structure**: Consistent format, clear component names
3. **Make toggle-able**: One flag to disable all debug logs
4. **Keep diagnostic value**: Still see what we need when DEBUG_ENABLED = true
5. **No performance cost**: When disabled, immediate return (no string formatting)

---

## After You're Done

1. Run verification:
```bash
bun run typecheck  # Must pass
bun run build      # Must succeed
```

2. Write REPORT.md:
```markdown
# Sage - Phase 1 Stage 1.5 Report

## Summary
[What you did, before/after log counts]

## Created Files
- src/utils/debugLog.ts (simple toggle-able logging)

## Optimized Files
- src/ui/sidebar/App.tsx (10 logs → X logs)
- src/ui/sidebar/components/QuickActions.tsx (2 logs → X logs)
- src/ui/sidebar/context/KernelContext.tsx (1 log → X logs)

## Pattern for Future Use
[Document how engineers should use debugLog()]

## Build Verification
✅ TypeScript passes
✅ Build succeeds
```

3. Commit using git workflow above

---

## Questions?

If you're unsure, keep it simple:
- Use debugLog() for info
- Use debugError() for errors
- Keep the same diagnostic information
- Just make it cleaner and toggle-able

**Ready? Go optimize those logs and create the utility.**
