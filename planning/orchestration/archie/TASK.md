# Archie - Phase 1 Stage 2: Backend Service Registration Fix

> **Status**: READY TO START
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Branch**: `ALPHA-SPEC-SPRINT` (shared with all engineers)
> **Duration**: 1-2 hours

---

## Assignment

Fix the backend service registration issue identified in Stage 1 diagnosis.

**Root Cause**: Services are conditionally registered based on LM Studio availability. When LM Studio is down, `taskQueue`, `workflowRunner`, and agent services are NOT registered - causing silent failures in the UI.

---

## What to Fix

### File: `src/main.ts`

**Problem**: Lines ~168-200 conditionally skip service registration when LM Studio is unavailable.

**Current Behavior**:
```typescript
if (lmStudioReady) {
  // Register taskQueue, workflowRunner, agents...
} else {
  console.warn("LM Studio not available, skipping agent services");
  // Services NOT registered - UI gets null
}
```

**Required Behavior**: Always register services. Let them handle unavailability gracefully at call time, not registration time.

### Fix Strategy

1. **Always register services** - Don't skip registration based on LM Studio
2. **Add graceful degradation** - Services should check LLM availability when called
3. **Clear error messaging** - User-facing errors when LLM unavailable (not silent null)

### Implementation

```typescript
// BEFORE: Conditional registration
if (lmStudioReady) {
  kernel.register("taskQueue", new AgentTaskQueue(...));
}

// AFTER: Always register, check availability at call time
const taskQueue = new AgentTaskQueue(...);
kernel.register("taskQueue", taskQueue);

// In AgentTaskQueue methods:
async enqueue(task: AgentTask): Promise<void> {
  if (!this.llmProvider.isAvailable()) {
    throw new Error("LLM provider not available. Check LM Studio connection.");
  }
  // ... existing logic
}
```

---

## Files to Modify

| File | What to Change |
|------|----------------|
| `src/main.ts` | Always register services, remove conditional registration |
| `src/core/agent/taskQueue.ts` | Add availability check in enqueue/execute methods |

---

## Verification

1. **TypeScript passes**: `bun run typecheck`
2. **Build succeeds**: `bun run build`
3. **Test in vault**:
   - Start with LM Studio DOWN
   - Open sidebar
   - Click Quick Action
   - Should show clear error "LLM not available" instead of silent failure
4. **Test with LM Studio UP**: Quick Actions should work normally

---

## Git Workflow (CRITICAL)

```bash
# Check you're on shared branch
git branch  # Should show: * ALPHA-SPEC-SPRINT

# After implementation, stage ONLY your files
git add src/main.ts
git add src/core/agent/taskQueue.ts
git add planning/orchestration/archie/REPORT.md

# Commit
git commit -m "fix(backend): Always register services for graceful degradation

- Removed conditional service registration in main.ts
- Added LLM availability check in taskQueue methods
- Clear error messages when LLM unavailable

Backend fix for Phase 1 Stage 2."

# NEVER PUSH
```

**Rules:**
- ❌ NEVER `git add .`
- ❌ NEVER switch branches
- ❌ NEVER push

---

## Report Format

Write `planning/orchestration/archie/REPORT.md`:

```markdown
# Archie - Phase 1 Stage 2 Report

## Summary
[What you fixed, before/after behavior]

## Files Modified
- src/main.ts: [what changed, line numbers]
- src/core/agent/taskQueue.ts: [what changed, line numbers]

## Testing Results
- LM Studio DOWN: [result]
- LM Studio UP: [result]

## Verification
✅ TypeScript passes
✅ Build succeeds
```

---

## Questions?

If you need clarification on the service registration pattern or graceful degradation approach, ask the Orchestrator before proceeding.

**Ready? Fix the backend service registration.**
