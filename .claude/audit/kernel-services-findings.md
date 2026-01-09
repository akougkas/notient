# Kernel & Services Initialization Audit Findings

## Critical Issues (Blocking)

### 1. Sidebar App.tsx: Non-Reactive Property Read (PRIMARY BLOCKER)
- [ ] `kernel.isServicesInitialized` read as plain boolean, no re-render on change | File: `src/ui/sidebar/App.tsx:91` | **Impact: Sidebar frozen forever**

**Problem:**
- The sidebar reads `kernel.isServicesInitialized` as a plain boolean property
- When `setServicesInitialized()` is called, it updates the Kernel's internal state
- BUT the Preact component does NOT re-render when this changes
- There is NO event listener on `services:initialized` event

**Why It Breaks:**
1. App.tsx renders with `isReady = false` (initial state)
2. Main.ts calls `kernel.setServicesInitialized()` at line 436
3. Kernel emits `services:initialized` event at kernel.ts:166
4. Dashboard listens to this event (dashboard.ts:185) and re-renders ✓
5. Sidebar DOES NOT listen - frozen showing loading state ✗

### 2. Early Return in initializeServicesAsync Without Setting Flag
- [ ] Returns early without calling `setServicesInitialized()` | File: `src/main.ts:231-241` | **Impact: Permanent stuck state on config error**

```typescript
if (!hasEmbeddingModel || !hasReasoningModel || !ollamaEnabled || !lmstudioEnabled) {
  console.error("[Notient] Missing required configuration:", {...});
  this.kernel.obsidian.notice("Notient requires BOTH Ollama and LM Studio...");
  return;  // ← EXITS WITHOUT CALLING setServicesInitialized()
}
```

---

## Implementation Gaps (Missing Features)

### 3. No Status Feedback for Initialization Failures
- [ ] No event emitted when initialization fails | File: `src/main.ts:211-477` | **Impact: No UI feedback**

**Missing:**
- No event emitted when initialization fails
- No mechanism to communicate partial failures to UI
- When Ollama is down, sidebar shows loading state forever

### 4. Inconsistent Error Handling in Service Initialization Chain
- [ ] OllamaService throws, LMStudioService continues silently | File: `src/main.ts:249-472` | **Impact: Unreliable state tracking**

Services have mismatched error strategies:
1. OllamaService (line 253): If fails → throws → caught at line 466 ✓
2. LMStudioService (line 259): If fails → caught and logged → continues silently ✗
3. SimpleVectorStore (line 272): If fails → throws ✓
4. IndexManager (line 277): If fails → throws ✓

### 5. EventBus Listener Not Reactive in Preact
- [ ] No `useEventBus()` hook or Preact signal for initialization state | File: `src/ui/sidebar/App.tsx` | **Impact: UI can't track state changes**

---

## Type Errors / Runtime Errors

### 6. Fallthrough Path in initializeServicesAsync
- [ ] Partial failure leaves `servicesInitialized = false` but `setServicesInitializing(false)` called | File: `src/main.ts:211-477` | **Impact: Retry from scratch on second attempt**

---

## Integration Issues

### 7. Kernel Getter Not Observable
- [ ] Plain getter returns boolean primitive | File: `src/core/kernel.ts:153-155` | **Impact: Components can't track changes**

```typescript
get isServicesInitialized(): boolean {
  return this._servicesInitialized;
}
```

Preact can't track changes to primitive properties.

### 8. Race Condition: Service Registration vs. Sidebar Rendering
- [ ] 1000ms delay before services initialize | File: `src/main.ts:144` | **Impact: Sidebar renders before services ready**

```typescript
setTimeout(() => this.initializeServicesAsync(), 1000);  // Line 144
```

Sidebar may render with `isReady=false` before services start.

---

## Mock/Stub Code

### 9. Placeholder Service References in Kernel
- [ ] All services typed as `unknown` instead of actual types | File: `src/core/kernel.ts:58-85` | **Impact: Lost type safety**

```typescript
private healthMonitor: unknown = null;
private ollamaService: unknown = null;
// ... 13 more services ...
```

---

## Summary Table

| Issue | Location | Severity | Impact |
|-------|----------|----------|--------|
| Non-reactive property read | App.tsx:91 | CRITICAL | Sidebar frozen on loading |
| Early return without flag reset | main.ts:231-241 | CRITICAL | Permanent stuck state |
| No initialization failure event | main.ts:466 | HIGH | No UI feedback |
| Silent service failures | main.ts:262-268 | HIGH | Inconsistent state |
| No event listener in sidebar | App.tsx | HIGH | No re-render trigger |
| Non-observable kernel getter | kernel.ts:153-155 | HIGH | Components can't track |
| Race condition with timing | main.ts:144 | MEDIUM | Early render |
| Services typed as unknown | kernel.ts:58-85 | MEDIUM | Lost type info |

---

## Root Cause Analysis

The sidebar component reads `kernel.isServicesInitialized` at line 91 as a static property and never re-evaluates it. When `setServicesInitialized()` is called on the kernel, the Preact component doesn't know to re-render because:

1. No event listener registered for `services:initialized`
2. No Preact signal wraps the property
3. Component uses plain boolean read cached at render time

**This is the exact pattern Dashboard uses, but Dashboard correctly subscribes to the event while App.tsx does not.**
