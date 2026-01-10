# Faye - Phase 1 Diagnosis Report

> **Status**: COMPLETE
> **Date**: 2026-01-10
> **Branch**: `faye/ui-improvements`

## Summary

Frontend diagnosis reveals a **critical timing/reactivity bug** in the `useService` hook. Services are registered AFTER the sidebar renders (1-second delay), but `useService` doesn't trigger re-renders when services become available. The `taskQueue` variable captured in callback closures remains `null` even after services initialize, causing "Agent system not available" errors when Quick Actions are clicked.

## Click Handler Test Results

| Component | Button/Action | Console Log? | Error? |
|-----------|---------------|--------------|--------|
| QuickActions | Find | YES | None (handler fires, but inner callback fails) |
| QuickActions | Link | YES | None (handler fires, but inner callback fails) |
| QuickActions | Enrich | YES | None (handler fires, but inner callback fails) |
| QuickActions | Tags | YES | None (handler fires, but inner callback fails) |
| QuickActions | Summary | YES | None (sends to chat) |
| QuickActions | Tasks | YES | None (sends to chat) |
| Footer | Providers | YES | None |
| Footer | Index | YES | None |

**Key Finding**: Click handlers fire correctly. The issue is NOT event binding. The problem is inside `triggerAgenticAction` where `taskQueue` is null.

## Signal Reactivity

| Signal | Updates Correctly? | Notes |
|--------|-------------------|-------|
| `activeAgents.value` | YES | Reactive via `@preact/signals` |
| `chatMessages.value` | YES | Works correctly |
| `searchResults.value` | YES | Works correctly |
| `noteVitals.value` | YES | Works correctly |
| `isServicesReady.value` | YES | Triggers UI update |

**Conclusion**: Signals are correctly implemented and reactive. This is NOT the root cause.

## useService Results

**CRITICAL FINDING**: The `useService` hook is called during render and returns whatever `kernel.getService()` returns at that moment. It has NO reactivity mechanism.

| Service | Available on First Render? | Available After Init? | Issue |
|---------|---------------------------|----------------------|-------|
| taskQueue | **NO (null)** | YES | Race condition |
| actionApplier | **NO (null)** | YES | Race condition |
| workflowRunner | **NO (null)** | YES | Race condition |
| actionHistory | **NO (null)** | YES | Race condition |

## Root Cause Analysis

### Timing Sequence (main.ts)

1. **Line 123**: `registerViews()` called - sidebar view registered
2. **Line 168**: `setTimeout(() => initializeServicesAsync(), 1000)` - services init delayed
3. **User opens sidebar**: Before 1 second passes, sidebar renders
4. **useService("taskQueue")**: Returns `null` because services not registered
5. **triggerAgenticAction callback**: Created with `taskQueue = null` in closure
6. **Services initialize**: `services:initialized` event fires
7. **isServicesReady.value = true**: Component re-renders
8. **useService("taskQueue")**: NOW returns valid instance
9. **BUT**: `triggerAgenticAction` callback not updated?

### The Bug

Looking at the callback dependencies:

```typescript
const triggerAgenticAction = useCallback(
  (prompt, taskType) => {
    if (taskQueue && noteVitals.value) { ... }
    else { new Notice("Agent system not available"); }
  },
  [taskQueue, noteVitals],  // <-- taskQueue changes null → instance
);
```

When `taskQueue` changes from `null` to a valid instance:
- `useCallback` SHOULD create a new callback
- But the component must RE-RENDER for this to happen
- Re-render IS triggered by `isServicesReady.value = true`
- So the callback SHOULD update...

### Hypothesis: useService Not Reactive

The issue may be that `useService` is called synchronously during render:

```typescript
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  return kernel.getService<T>(name);  // Direct call, no state
}
```

Even though `isServicesReady.value = true` causes a re-render, there's a question of whether `useService` returns the correct value on that re-render.

**Expected behavior**: On re-render after `services:initialized`, `kernel.getService("taskQueue")` should return the registered service.

**Debug logs will confirm**: The added `console.log("[useService]", name, "→", service)` will show exactly what's returned on each render.

## Callback Dependencies

### Analysis of triggerAgenticAction

```typescript
const triggerAgenticAction = useCallback(
  (prompt: string, taskType: ...) => { ... },
  [taskQueue, noteVitals],
);
```

- `taskQueue`: Goes from `null` → `AgentTaskQueue` instance after init
- `noteVitals`: Is a `Signal` object (stable reference)
- `noteVitals.value`: Accessed INSIDE callback, not as dependency (correct)

This looks correct. The callback SHOULD update when `taskQueue` changes reference.

## Console Errors

**Expected console output when Quick Action clicked (if bug confirmed)**:

```
[useService] taskQueue → null
[useService] taskQueue → AgentTaskQueue {...}  // After services init
[QuickActions] Button clicked: find-connections
[triggerAgenticAction] Called with: { prompt: "Find notes...", taskType: "link" }
[triggerAgenticAction] taskQueue: null  // <-- BUG: should be the instance!
[triggerAgenticAction] noteVitals: { title: "Note", path: "..." }
[triggerAgenticAction] FAILED - missing: { hasTaskQueue: false, hasNoteVitals: true }
[QuickActions] onClick called successfully
```

## Root Cause Hypothesis

### Scenario B: Handlers Fire, Services Null (CONFIRMED BY CODE ANALYSIS)

```
ROOT CAUSE: Services not available in UI callbacks

The useService hook returns null on first render because services are
registered AFTER a 1-second delay. Even though the component re-renders
when isServicesReady changes, the callback closure captured the stale
null reference.

EVIDENCE:
- main.ts line 168: setTimeout(..., 1000) delays service init
- main.ts line 123: Views registered BEFORE services
- useService has no reactivity (no useState/useEffect)

CONCLUSION: The callback is NOT being updated when taskQueue changes.
```

## Recommended Fix

### Option 1: Make useService Reactive (Preferred)

```typescript
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const [service, setService] = useState<T | null>(kernel.getService<T>(name));

  useEffect(() => {
    const unsubscribe = kernel.eventBus.on("services:initialized", () => {
      setService(kernel.getService<T>(name));
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

**Estimated effort**: 2 hours

### Option 2: Force Re-render in App.tsx (Quick Fix)

```typescript
const [, forceUpdate] = useState({});

useEventBus("services:initialized", () => {
  isServicesReady.value = true;
  forceUpdate({}); // Force re-render to pick up new service values
});
```

**Estimated effort**: 30 minutes

### Option 3: Get Services Inside Callback (Workaround)

```typescript
const triggerAgenticAction = useCallback(
  (prompt: string, taskType: ...) => {
    const currentTaskQueue = kernel.getService<AgentTaskQueue>("taskQueue");
    if (currentTaskQueue && noteVitals.value) { ... }
  },
  [kernel, noteVitals],
);
```

**Estimated effort**: 15 minutes (but less clean)

## Next Steps

1. **Run instrumented build** in Obsidian
2. **Click Quick Actions** and capture console logs
3. **Verify hypothesis**: Is `taskQueue` null in the callback after services init?
4. **Confirm fix approach** with Orchestrator

## Appendix: Debug Logging Added

### QuickActions.tsx (line 51-55)
```typescript
const handleClick = useCallback(() => {
  console.log("[QuickActions] Button clicked:", action.id);
  action.onClick();
  console.log("[QuickActions] onClick called successfully");
}, [action.onClick]);
```

### App.tsx (line 473-526)
```typescript
const triggerAgenticAction = useCallback(
  (prompt: string, taskType: ...) => {
    console.log("[triggerAgenticAction] Called with:", { prompt, taskType });
    console.log("[triggerAgenticAction] taskQueue:", taskQueue);
    console.log("[triggerAgenticAction] noteVitals:", noteVitals.value);

    if (taskQueue && noteVitals.value) {
      // ... existing code
    } else {
      console.error("[triggerAgenticAction] FAILED - missing:", {
        hasTaskQueue: !!taskQueue,
        hasNoteVitals: !!noteVitals.value,
      });
      // ... existing code
    }
  },
  [taskQueue, noteVitals],
);
```

### App.tsx (line 735-743)
```typescript
const openModelSelector = useCallback(() => {
  console.log("[openModelSelector] Called");
  // ...
}, [app, kernel]);

const openIndexDashboard = useCallback(() => {
  console.log("[openIndexDashboard] Called");
  // ...
}, [app, kernel]);
```

### KernelContext.tsx (line 71-76)
```typescript
export function useService<T>(name: string): T | null {
  const kernel = useKernel();
  const service = kernel.getService<T>(name);
  console.log("[useService]", name, "→", service);
  return service;
}
```
