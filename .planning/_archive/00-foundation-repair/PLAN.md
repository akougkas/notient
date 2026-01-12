# Phase 0: Foundation Repair

## Status: IN PROGRESS

**Created**: 2026-01-12
**Last Updated**: 2026-01-12

---

## Context

After extensive debugging (2026-01-10 to 2026-01-12), the critical UI freeze bug was fixed (infinite loop in `taskQueue.processNext()`). A comprehensive code audit revealed 4 remaining critical issues that must be resolved before feature work can proceed.

**Previous work archived**: `./_archive/`

---

## Critical Issues

### Issue 1: Sequential Embeddings (CRITICAL)
**Impact**: Indexing is 8x slower than necessary
**Location**: `src/core/indexer/simpleIndexer.ts`

**Problem**:
```
embedChunks() → process 4 chunks → wait for response → next 4 → wait...
```
Each Ollama request (~85ms) blocks the next. For 27,000 chunks = ~9.5 minutes of pure network latency.

**Root Cause**:
`embedChunks()` at line ~473-507 awaits each batch sequentially instead of parallelizing.

**Fix**:
- Batch embedding requests into groups of N (e.g., 8 concurrent)
- Use `Promise.all()` for parallel execution
- Add proper error handling for partial failures

**Estimated Time**: 2 hours

---

### Issue 2: Action ID Mismatch (CRITICAL)
**Impact**: Quick Actions produce "Could not find action" errors — broken feature
**Location**: `src/core/agent/taskQueue.ts`, `src/core/agentic/actionApplier.ts`, `src/main.ts`

**Problem**:
```
TaskQueue creates:    task.id = "12e561b8-..."
Agent produces:       ProposedAction { } (no ID)
ActionApplier saves:  record.id = "action-1768200138745-xyz"
UI applies:           "action-1768200138745-xyz" → NOT FOUND
```

**Root Cause**:
Action IDs are generated at multiple points and never linked. The task ID, the action record ID, and what the UI tries to look up are all different.

**Fix**:
- Add `sourceTaskId?: string` field to `ProposedAction` type
- Propagate task ID from TaskQueue through ChiefOfStaff to Agent output
- Use consistent ID scheme for action lookup

**Estimated Time**: 4 hours

---

### Issue 3: Reranker JSON Parsing (HIGH)
**Impact**: Search reranking silently fails ~10% of the time
**Location**: `src/core/llm/providers/lmstudio-sdk.ts`

**Problem**:
```
LLM output: "<think>reasoning...</think> { rankings: [...] }"
Greedy regex: /\{[\s\S]*\}/ → captures wrong content
Result: "[lmstudio-sdk] No rankings array in response"
```

**Root Cause**:
`parseRerankResponse()` uses greedy regex that fails on thinking model output. The `<think>` tags confuse JSON extraction.

**Fix**:
- Use non-greedy regex `/\{[\s\S]*?\}/`
- Strip `<think>...</think>` blocks before JSON extraction
- Add structure validation (check for `rankings` array)
- Log actual LLM response on parse failure for debugging

**Estimated Time**: 3 hours

---

### Issue 4: FS.syncfs Race Condition (LOW)
**Impact**: Console noise, potential data corruption risk
**Location**: `src/services/hnswVectorStore.ts`

**Problem**:
```
warning: 2 FS.syncfs operations in flight at once
```
During indexing, HNSW persists on every note completion. Saves overlap before previous completes.

**Root Cause**:
`persistNativeIndex()` is called too frequently without checking if previous sync finished.

**Fix**:
- Add `isSyncing` flag to prevent overlapping syncs
- Queue sync requests during active sync
- Or: Increase debounce interval during bulk indexing

**Estimated Time**: 1 hour

---

### Issue 5: Dead ChatAgent Code (LOW)
**Impact**: 248 lines of unused code, architectural confusion
**Location**: `src/core/agents/chatAgent.ts`

**Problem**:
ChatAgent class exists but is never instantiated or called. Chat flows through ChatService directly.

**Fix**:
- Delete `chatAgent.ts` entirely
- Remove from `src/core/agents/index.ts` exports
- Update any stale imports

**Estimated Time**: 30 minutes

---

### Issue 6: action:proposed Event Not Emitted (CRITICAL)
**Impact**: Pending actions UI never populates — broken feature
**Location**: `src/core/agent/taskQueue.ts`

**Problem**:
```
taskQueue.extractActions() gets ProposedAction[]
But never emits "action:proposed" event
pendingActions signal stays empty
```

**Fix**:
- After `extractActions()` in taskQueue, emit event per action:
  ```typescript
  actions.forEach(action => eventBus.emit("action:proposed", { action, noteContext }));
  ```

**Estimated Time**: 1 hour

---

### Issue 7: Action Applier Not Wired (CRITICAL)
**Impact**: Apply button in UI does nothing
**Location**: `src/main.ts`, `src/core/agentic/actionApplier.ts`

**Problem**:
```
App.tsx emits "action:apply-requested"
No handler connects to ActionApplier.applyConfirmed()
```

**Fix**:
- In main.ts, add event listener:
  ```typescript
  eventBus.on("action:apply-requested", (data) => actionApplier.applyConfirmed(data.actionId));
  ```

**Estimated Time**: 2 hours

---

### Issue 8: Capability Cards Not Connected (LOW)
**Impact**: Agent Streams always shows "healthy" status
**Location**: `src/ui/sidebar/App.tsx`, `AgentStreamsView.tsx`

**Problem**:
```
AgentStreamsView expects capabilities prop
App.tsx never passes it
Cards show hardcoded "healthy"
```

**Fix**:
- Create capabilities signal from HealthMonitor
- Pass to AgentStreamsView in App.tsx

**Estimated Time**: 1 hour

---

## Execution Order

1. **Issue 3: Reranker JSON** (3h) — Quick win, improves search
2. **Issue 6: action:proposed** (1h) — Unblocks pending actions UI
3. **Issue 7: Action Applier** (2h) — Makes Apply button work
4. **Issue 2: Action ID** (4h) — Fixes "action not found" errors
5. **Issue 1: Embeddings** (2h) — Major indexing speedup
6. **Issue 5: Dead ChatAgent** (30m) — Cleanup
7. **Issue 4: FS.syncfs** (1h) — Reduce noise
8. **Issue 8: Capability Cards** (1h) — Polish

**Total**: ~14.5 hours

---

## Validation Checklist

After all fixes:
- [ ] Indexing completes in <2 minutes for 895 notes
- [ ] Quick Action "Classify" produces applicable results
- [ ] Search reranking works (no "No rankings array" warnings)
- [ ] Pending actions appear in Agent Streams view
- [ ] Apply button actually applies actions to notes
- [ ] No FS.syncfs warnings during indexing
- [ ] Capability cards show real status
- [ ] No dead code (ChatAgent deleted)

---

## Files to Modify

| Issue | Files |
|-------|-------|
| 1. Embeddings | `src/core/indexer/simpleIndexer.ts` |
| 2. Action ID | `src/core/agent/taskQueue.ts`, `src/core/agentic/types.ts` |
| 3. Reranker | `src/core/llm/providers/lmstudio-sdk.ts` |
| 4. FS.syncfs | `src/services/hnswVectorStore.ts` |
| 5. ChatAgent | `src/core/agents/chatAgent.ts` (DELETE), `src/core/agents/index.ts` |
| 6. action:proposed | `src/core/agent/taskQueue.ts` |
| 7. Action Applier | `src/main.ts` |
| 8. Capability Cards | `src/ui/sidebar/App.tsx` |

---

## Notes

- All fixes are backward compatible
- No new dependencies required
- Each fix can be committed independently
- Previous debugging artifacts archived, not deleted (can reference if needed)
