# Faye - Phase 1 Stage 2: Frontend useService Reactivity Fix

> **Status**: READY TO START
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Branch**: `ALPHA-SPEC-SPRINT` (shared with all engineers)
> **Duration**: 1-2 hours

---

## Assignment

Fix the frontend `useService` hook reactivity issue identified in Stage 1 diagnosis.

**Root Cause**: The `useService` hook returns whatever `kernel.getService()` returns at render time. It has NO reactivity - it doesn't subscribe to `services:initialized` events, so callbacks capture stale null references.

---

## What to Fix

### File: `src/ui/sidebar/context/KernelContext.tsx`

**Current `useService` (broken)**:
```typescript
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const service = kernel.getService<T>(name);
  console.log("[useService]", name, "→", service);  // Debug log from diagnosis
  return service;
}
```

**Problem**:
- No state, no effect, no reactivity
- Called during render, returns null if services not ready
- Component re-renders but callback closures keep stale null

---

## Fix: Make useService Reactive

Replace with a reactive implementation that subscribes to `services:initialized`:

```typescript
import { useState, useEffect } from "preact/hooks";

export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const [service, setService] = useState<T | null>(() => kernel.getService<T>(name));

  useEffect(() => {
    // Subscribe to services:initialized event
    const unsubscribe = kernel.eventBus.on("services:initialized", () => {
      const current = kernel.getService<T>(name);
      setService(current);
    });

    // Check immediately in case we missed the event
    const current = kernel.getService<T>(name);
    if (current !== service) {
      setService(current);
    }

    return unsubscribe;
  }, [kernel, name]);

  return service;
}
```

**Why this works**:
1. `useState` holds the service reference
2. `useEffect` subscribes to `services:initialized`
3. When event fires, `setService` triggers re-render
4. New service value flows to dependent `useCallback` hooks
5. Callbacks get fresh references

---

## Also Clean Up Debug Logging

The debug logging from diagnosis is now handled by `debugLog.ts`. Remove the remaining console.log in useService (Sage already created the utility).

**Before**:
```typescript
console.log("[useService]", name, "→", service);
```

**After**: Either remove entirely or use the debug utility:
```typescript
import { debugLog } from "../../utils/debugLog";
debugLog("useService", name, { available: !!service });
```

---

## Files to Modify

| File | What to Change |
|------|----------------|
| `src/ui/sidebar/context/KernelContext.tsx` | Make useService reactive with useState/useEffect |

---

## Verification

1. **TypeScript passes**: `bun run typecheck`
2. **Build succeeds**: `bun run build`
3. **Test in vault**:
   - Open Obsidian with test vault
   - Open sidebar immediately (before 1-second delay)
   - Wait 2 seconds for services to initialize
   - Click Quick Action (Find, Link, Enrich, Tags)
   - Should work correctly (not "Agent system not available")
4. **Console check**: No errors, no null taskQueue in callbacks

---

## Git Workflow (CRITICAL)

```bash
# Check you're on shared branch
git branch  # Should show: * ALPHA-SPEC-SPRINT

# After implementation, stage ONLY your files
git add src/ui/sidebar/context/KernelContext.tsx
git add planning/orchestration/faye/REPORT.md

# Commit
git commit -m "fix(ui): Make useService hook reactive to service initialization

- Added useState to hold service reference
- Added useEffect to subscribe to services:initialized
- Callbacks now receive fresh service references after init

Frontend fix for Phase 1 Stage 2."

# NEVER PUSH
```

**Rules:**
- ❌ NEVER `git add .`
- ❌ NEVER switch branches
- ❌ NEVER push

---

## Report Format

Write `planning/orchestration/faye/REPORT.md`:

```markdown
# Faye - Phase 1 Stage 2 Report

## Summary
[What you fixed, before/after behavior]

## Files Modified
- src/ui/sidebar/context/KernelContext.tsx: [what changed, line numbers]

## Testing Results
- Quick Actions after page load: [result]
- Quick Actions after services init: [result]

## Verification
✅ TypeScript passes
✅ Build succeeds
```

---

## Coordination with Archie

Archie is fixing the backend service registration. Your frontend fix is independent and can run in parallel. Both fixes together solve the complete problem:
- Archie: Services always registered (not conditional)
- Faye: UI reacts when services become available

---

## Questions?

If you need clarification on the reactivity pattern or Preact hooks, ask the Orchestrator before proceeding.

**Ready? Fix the useService hook reactivity.**
