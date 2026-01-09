# Sidebar & Preact Integration Audit Findings

## Critical Issues (Blocking)

### 1. Static Kernel State - MAIN BLOCKER
- [ ] `App.tsx:91` reads `kernel.isServicesInitialized` once at render time | File: `src/ui/sidebar/App.tsx:91` | **Impact: Sidebar stuck forever on "Initializing services..."**

**Root Cause:** The `kernel.isServicesInitialized` is a plain boolean property, not a signal. When `main.ts` calls `kernel.setServicesInitialized()` (line 436), the App component does NOT re-render.

**Evidence:** DashboardView.ts correctly subscribes at line 185:
```typescript
kernel.eventBus.on("services:initialized", () => { this.render(); })
```
But App.tsx has NO such subscription.

### 2. No useInitializedServices Hook
- [ ] Missing hook to subscribe to `services:initialized` event | Files: `src/ui/sidebar/` | **Impact: No re-render trigger**

**What exists:** `useEventBus` hook exists but is NEVER USED in App.tsx

**What's missing:** A hook like:
```typescript
function useServicesInitialized() {
  const [ready, setReady] = useState(kernel.isServicesInitialized);
  useEventBus("services:initialized", () => setReady(true));
  return ready;
}
```

### 3. Signal Dependency Issue in useNoteVitals
- [ ] useEffect dependency array includes `[app, calculator]` causing frequent resubscriptions | File: `src/ui/sidebar/hooks/useNoteVitals.ts:88` | **Impact: Performance issues**

---

## Implementation Gaps (Missing Features)

### 1. Preact Signals Not Leveraged for Initialization State
- [ ] Should wrap initialization state in a Preact signal | File: `App.tsx` | **Current:** Static property read

### 2. No Reactive Re-render Bridge
- [ ] App component needs reactive hooks, not static property reads | Expected: Event subscription | **Current:** Direct boolean read

### 3. Missing Event Subscription in App Component
- [ ] App should subscribe to `services:initialized` event on mount | Expected: useEffect with subscription | **Current:** No subscription

---

## Mock/Stub Code

### 1. IntelligenceActions.ts - Imperative Class in Preact Context
- [ ] Old imperative class (not Preact component), 442 lines | File: `src/ui/sidebar/components/IntelligenceActions.ts` | **Status: Dead code or incomplete**

Evidence:
- Line 81: `render(container: HTMLElement)` - returns DOM, not JSX
- Line 128: `btn.addEventListener("click", ...)` - imperative
- Never imported in App.tsx

---

## Type Errors / Runtime Errors

### 1. Potential Runtime Error in useNoteVitals
- [ ] Type checking `file instanceof Object` is too permissive | File: `src/ui/sidebar/hooks/useNoteVitals.ts:76-78` | **Risk: Type assertion failures**

### 2. useCallback Circular Dependency
- [ ] `useCallback(callback, [callback])` defeats memoization purpose | File: `src/ui/sidebar/context/KernelContext.tsx:90` | **Impact: Creates new function every render**

---

## Integration Issues

### 1. App.tsx Never Uses useEventBus Hook
- [ ] Hook defined and exported but never used | File: `src/ui/sidebar/App.tsx` | **Impact: Event infrastructure unused**

### 2. Workspace Events May Not Fire
- [ ] No logging to verify events trigger | File: `src/ui/sidebar/hooks/useNoteVitals.ts:68-70` | **Impact: Silent failures possible**

### 3. Sidebar View Doesn't Check Services Before Rendering
- [ ] `onOpen()` immediately renders without checking `kernel.isServicesInitialized` | File: `src/ui/sidebar/SidebarView.tsx:37-49` | **Impact: Renders before ready**

### 4. NoteVitalsCalculator Service Resolution
- [ ] If called before services initialized, `getService()` returns null | File: `src/ui/sidebar/hooks/useNoteVitals.ts:50-51` | **Risk: Null reference**

---

## Summary Table

| Component | Issue | Severity | Root Cause |
|-----------|-------|----------|-----------|
| App.tsx | Static isReady property | CRITICAL | No reactive state |
| App.tsx | No services:initialized listener | CRITICAL | Missing useEffect |
| useNoteVitals | Unsafe indexManager access | HIGH | No null check |
| KernelContext | Useless useCallback | MEDIUM | Circular dependency |
| IntelligenceActions | Dead code | MEDIUM | Never imported |
