---
phase: 00-foundation-repair
plan: 01-fix
type: execute
---

<objective>
Fix the ACTUAL 36-second bottleneck in HNSWVectorStore.loadFromDataAsync().

Purpose: The 00-01 plan fixed chunk loading (now 243ms), but the real bottleneck is the HNSW metadata hydration loop which iterates over 22,313 docs synchronously without yielding.

Output: Plugin startup under 5 seconds, UI responsive during HNSW loading.
</objective>

<context>
@.planning/phases/00-foundation-repair/00-01-ISSUES.md

**Root Cause from UAT:**
- `[IndexManager] Initialized: 471 notes in 36651ms` - 36 seconds!
- ChunkStore fast (243ms), HNSWVectorStore slow (36s)

**Files to fix:**
@src/services/hnswVectorStore.ts

**Problem Location (lines 366-402):**
```typescript
for (let i = 0; i < data.docs.length; i++) {
  const persisted = data.docs[i];
  const embedding = new Float32Array(persisted.embedding);  // 22K allocations
  // ... populate 5 Maps with 22K entries each
}
```

This loop runs 22,313 iterations synchronously, creating:
- 22K Float32Array objects
- 22K Map.set() operations on 5 different Maps
- Zero yields to event loop = frozen UI

**Fix Strategy:**
Same pattern as ChunkStore fix - batch processing with yields between batches.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add batched processing to loadFromDataAsync metadata loop</name>
  <files>src/services/hnswVectorStore.ts</files>
  <action>
Refactor the for-loop at lines 366-402 to process in batches with yields:

**Current (synchronous, blocking):**
```typescript
for (let i = 0; i < data.docs.length; i++) {
  const persisted = data.docs[i];
  const embedding = new Float32Array(persisted.embedding);
  // ... Map operations
}
```

**Fixed (batched with yields):**
```typescript
// Process in batches to prevent UI freeze
const BATCH_SIZE = 1000; // 22K docs / 1000 = 22 batches
const totalDocs = data.docs.length;

for (let batchStart = 0; batchStart < totalDocs; batchStart += BATCH_SIZE) {
  const batchEnd = Math.min(batchStart + BATCH_SIZE, totalDocs);

  // Process batch
  for (let i = batchStart; i < batchEnd; i++) {
    const persisted = data.docs[i];
    const embedding = new Float32Array(persisted.embedding);
    const label = typeof persisted.label === "number" ? persisted.label : i;

    // ... same Map operations
  }

  // Yield to event loop between batches
  if (batchEnd < totalDocs) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
```

Add progress logging every 5000 docs for visibility.
  </action>
  <verify>
TypeScript compiles without errors:
```bash
bun run typecheck
```
  </verify>
  <done>loadFromDataAsync processes docs in batches with yields between batches</done>
</task>

<task type="auto">
  <name>Task 2: Add timing metrics to identify remaining bottlenecks</name>
  <files>src/services/hnswVectorStore.ts</files>
  <action>
Add detailed timing to loadFromDataAsync to identify where time is spent:

```typescript
async loadFromDataAsync(...) {
  const timings = {
    syncFsStart: 0,
    readIndex: 0,
    metadataLoop: 0,
  };

  // Before syncFs
  let start = performance.now();
  await this.syncFs(true);
  timings.syncFsStart = performance.now() - start;

  // Before readIndex
  start = performance.now();
  const ok = await index.readIndex(hnswFilename, maxElements);
  timings.readIndex = performance.now() - start;

  // Before metadata loop
  start = performance.now();
  // ... batched loop
  timings.metadataLoop = performance.now() - start;

  console.log(`[HNSWVectorStore] Timing: syncFs=${timings.syncFsStart}ms, readIndex=${timings.readIndex}ms, metadata=${timings.metadataLoop}ms`);
}
```

This will show exactly where the 36 seconds is spent.
  </action>
  <verify>
Timing logs appear in console:
```
[HNSWVectorStore] Timing: syncFs=Xms, readIndex=Yms, metadata=Zms
```
  </verify>
  <done>Timing metrics added to loadFromDataAsync for profiling</done>
</task>

</tasks>

<verification>
Before declaring plan complete:
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Console shows timing breakdown during startup
- [ ] Total startup time significantly reduced from 36s
</verification>

<success_criteria>
- Batched processing added to metadata loop
- Timing metrics show where time is spent
- UI remains responsive during HNSW loading
- Total startup time <10 seconds (stretch goal: <5s)
</success_criteria>

<output>
After completion, update `.planning/phases/00-foundation-repair/00-01-ISSUES.md` to mark UAT-001 as resolved.
</output>
