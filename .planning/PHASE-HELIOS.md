# Phase Helios: Backend Pipeline Cohesion

**Status**: READY FOR EXECUTION
**Created**: 2026-01-15 (Session 7)
**Goal**: Bug-free backend pipeline, close Phase Universe
**Scope**: Backend/agentic fixes only (UI deferred to Project Gaia)

---

## Executive Summary

14 issues from Reviewer 3+4 audit. Three waves of fixes targeting lifecycle safety, data flow correctness, and error surfacing. Estimated effort: ~8 hours.

---

## Issue Registry

### HIGH Priority (Must Fix)

| ID | Issue | File(s) | Lines |
|----|-------|---------|-------|
| H1 | EventBus handlers duplicate on reinit | main.ts | 648-656, 1074-1092 |
| H2 | Background indexing can overlap | main.ts | 1230-1268 |
| H3 | Pending actions never clear (ID mismatch) | useAppEvents.ts, actionHistory.ts | 259-271, 83-107 |
| H4 | Chat slash results never populate | appHandlers.ts, state.ts | 704-745, 69-70 |
| H5 | Indexing guard never activates | appHandlers.ts, simpleIndexer.ts, useAppEvents.ts | 85-88, 513-529, 76-85 |
| H6 | Worker errors never reject pending ops | workerBridge.ts | 117-120, 168-170 |

### MEDIUM Priority (Should Fix)

| ID | Issue | File(s) | Lines |
|----|-------|---------|-------|
| M1 | Unload doesn't abort indexing | main.ts | 233-240 |
| M2 | Agent tasks not cancelled on unload | main.ts, taskQueue.ts | 273-277, 164-174 |
| M3 | File rename listener not unregistered | main.ts | 589-594 |
| M4 | Partial batch failures silently swallowed | main.ts, actionApplier.ts | 1328-1336, 735-740 |
| M5 | SearchPipeline events never surfaced | pipeline.ts, useAppEvents.ts | 152-205, 359-373 |
| M6 | OllamaReranker never registered | main.ts, balanced.ts | 471-483, 231-238 |

### LOW Priority (Tech Debt)

| ID | Issue | File(s) |
|----|-------|---------|
| L1 | Intelligence updates never surfaced | noteIntelligence.ts:231-234 |

---

## Wave 1: Lifecycle Safety

**Dependencies**: None (foundational)
**Role**: implementer
**CLI**: claude

### H1: EventBus Handler Deduplication

**Problem**: `registerActionEventHandlers()` and `registerContextActionHandlers()` called on every reinit without cleanup.

**Fix**:
```typescript
// main.ts - Add to class properties
private eventUnsubscribes: Array<() => void> = [];

// In registerActionEventHandlers - store unsubscribes
this.eventUnsubscribes.push(
  eventBus.on("action:apply-requested", handler),
  eventBus.on("action:undo-requested", handler)
);

// In disposeServices - clear them
this.eventUnsubscribes.forEach(unsub => unsub());
this.eventUnsubscribes = [];
```

### H2: Indexing Overlap Guard

**Problem**: `startBackgroundIndexing()` overwrites controller without checking active run.

**Fix**:
```typescript
// main.ts - Add to class properties
private isIndexing = false;
private currentIndexingPromise: Promise<void> | null = null;

// In startBackgroundIndexing
if (this.isIndexing) {
  console.log("[Notient] Indexing already in progress, skipping");
  return;
}
this.isIndexing = true;
// ... existing code ...
// In finally block:
this.isIndexing = false;
```

### M1: Abort Indexing on Unload

**Problem**: `onunload()` doesn't abort in-flight indexing.

**Fix**:
```typescript
// In onunload()
this.indexingAbortController?.abort();
await this.currentIndexingPromise; // Wait for cleanup
await this.disposeServices();
```

### M2: Cancel Agent Tasks on Unload

**Problem**: AgentTaskQueue has `cancel()` but no `cancelAll()`, not called on dispose.

**Fix**:
```typescript
// In AgentTaskQueue - add method
cancelAll(): void {
  for (const task of this.tasks.filter(t => t.status === "running" || t.status === "queued")) {
    this.cancel(task.id);
  }
}

// In disposeServices
this.agentTaskQueue?.cancelAll();
```

### M3: File Rename Listener Cleanup

**Problem**: `onFileRename` registered via facade without storing EventRef.

**Fix**:
```typescript
// Use this.registerEvent() which auto-cleans on unload
this.registerEvent(
  this.app.vault.on("rename", (file, oldPath) => {
    if (this.conversationStore && file instanceof TFile) {
      this.conversationStore.handleRename(oldPath, file.path);
    }
  })
);
```

---

## Wave 2: Data Flow Fixes

**Dependencies**: Wave 1 (stable lifecycle)
**Role**: implementer
**CLI**: claude

### H3: Pending Actions ID Mismatch

**Problem**: `action:applied` handler filters by `record.id` but pending uses `action.id`.

**Fix**:
```typescript
// useAppEvents.ts:259-271
useEventBus("action:applied", (data) => {
  const { record } = data;
  const actionId = record.action.id; // Use action.id, not record.id
  batch(() => {
    pendingActions.value = pendingActions.value.filter((a) => a.id !== actionId);
    // Also clean pendingActionSources if exists
  });
});
```

### H4: Chat Slash Command Result Mirroring

**Problem**: Placeholder message created but never updated with results.

**Fix**:
```typescript
// useAppEvents.ts - Add handler
useEventBus("agent:task-update", (data) => {
  if (data.status === "completed" || data.status === "failed") {
    const messageId = chatSlashCommandTasks.value.get(data.taskId);
    if (messageId) {
      // Update placeholder message with result
      chatMessages.value = chatMessages.value.map(msg =>
        msg.id === messageId
          ? { ...msg, content: data.result?.summary || `Task ${data.status}` }
          : msg
      );
      // Clean up mapping
      const newMap = new Map(chatSlashCommandTasks.value);
      newMap.delete(data.taskId);
      chatSlashCommandTasks.value = newMap;
    }
  }
});
```

### H5: Indexing Status Signal Wiring

**Problem**: `indexStatus.isIndexing` never set true during indexing.

**Fix**:
```typescript
// useAppEvents.ts - Add handlers
useEventBus("index:progress", (data) => {
  indexStatus.value = {
    ...indexStatus.value,
    isIndexing: true,
    noteCount: data.progress.completed,
  };
});

useEventBus("index:complete", () => {
  indexStatus.value = { ...indexStatus.value, isIndexing: false };
});

useEventBus("index:error", () => {
  indexStatus.value = { ...indexStatus.value, isIndexing: false };
});
```

### H6: Worker Error Rejection

**Problem**: Worker errors logged but pending promises never rejected.

**Fix**:
```typescript
// workerBridge.ts - Track pending operations
private pendingOps = new Map<string, { resolve: Function, reject: Function }>();

// In error handler
case "error":
  console.error("[VectorWorkerBridge] Error:", message.message);
  // Reject all pending operations
  for (const [id, { reject }] of this.pendingOps) {
    reject(new Error(`Worker error: ${message.message}`));
  }
  this.pendingOps.clear();
  break;

// In terminate()
terminate(): void {
  for (const [id, { reject }] of this.pendingOps) {
    reject(new Error("Worker terminated"));
  }
  this.pendingOps.clear();
  this.worker.terminate();
}
```

---

## Wave 3: Error Surfaces + Missing Wiring

**Dependencies**: Wave 2 (data flow correct)
**Roles**: implementer + simplifier
**CLI**: claude/gemini

### M4: Partial Batch Failure Warnings

**Problem**: Success with error field not surfaced to user.

**Fix**:
```typescript
// main.ts:1328-1336
if (result.success) {
  if (result.error) {
    // Partial success - warn user
    this.kernel.obsidian.notice(`Warning: ${result.error}`, 5000);
  } else {
    this.kernel.obsidian.notice(`Applied: ${actionToApply.title}`);
  }
}
```

### M5: SearchPipeline Event Handlers

**Problem**: `search:error` emitted but never handled.

**Fix**:
```typescript
// useAppEvents.ts - Add handler
useEventBus("search:error", (data) => {
  console.error("[Search] Error:", data.error);
  // Optionally surface to UI
  searchResults.value = []; // Clear stale results
});
```

### M6: OllamaReranker Registration

**Problem**: `balanced.ts` requests `ollamaReranker` service but it's never registered.

**Fix**:
```typescript
// main.ts - In initializeServicesAsync, after ollama service
this.ollamaReranker = new OllamaReranker(this.settings, eventBus);
await this.ollamaReranker.initialize();
this.kernel.registerService("ollamaReranker", this.ollamaReranker);
```

---

## Verification Plan

### After Wave 1
```bash
bun run build
# Manual: Change settings, verify no double-apply
# Manual: Trigger reinit, check console for duplicate handlers
```

### After Wave 2
```bash
bun run build
# Manual: Apply action, verify pending clears
# Manual: Chat /enhance, verify placeholder updates
# Manual: Start indexing, verify guard blocks agents
```

### After Wave 3
```bash
bun run build
bun run typecheck
# Manual: Full app test - all buttons, all flows
```

---

## Dispatch Commands

### Wave 1
```bash
.claude/agents/git-prepare.sh implementer implementer/helios-wave1
uv run .claude/agents/dispatch.py implementer "Phase Helios Wave 1: Lifecycle safety. Fix H1 (eventBus dedup), H2 (indexing guard), M1 (abort on unload), M2 (cancel agents), M3 (rename listener). See PHASE-HELIOS.md for details." --cli claude
```

### Wave 2
```bash
.claude/agents/git-prepare.sh implementer implementer/helios-wave2
uv run .claude/agents/dispatch.py implementer "Phase Helios Wave 2: Data flow fixes. Fix H3 (pending ID), H4 (chat slash), H5 (indexing signal), H6 (worker rejection). See PHASE-HELIOS.md for details." --cli claude
```

### Wave 3
```bash
uv run .claude/agents/dispatch.py implementer "Phase Helios Wave 3: Fix M6 - register OllamaReranker in main.ts" --cli claude
uv run .claude/agents/dispatch.py simplifier "Phase Helios Wave 3: Fix M4 (partial warnings), M5 (search error handler). See PHASE-HELIOS.md" --cli gemini
```

---

## Success Criteria

- [ ] No console errors during normal operation
- [ ] Settings change doesn't duplicate event handlers
- [ ] Only one indexing run at a time
- [ ] Plugin unload is clean (no orphan tasks)
- [ ] Pending actions clear after apply
- [ ] Chat slash commands show results
- [ ] Indexing blocks agent triggers
- [ ] Worker errors surface to caller
- [ ] Reranker is available for balanced search

---

*Phase Helios: Morph the codebase into cohesion.*
