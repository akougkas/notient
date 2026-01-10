# Archie - Phase 5 Report

> **Status**: COMPLETE
> **Last Updated**: 2026-01-10
> **Branch**: `archie/backend-fixes`

---

## Summary

Phase 5 implements time-bucketed action history storage with diff-based undo. Actions are stored in a hot file (recent 200) with automatic archival to monthly files. Undo payloads now use unified diffs instead of full content, significantly reducing storage size.

---

## Files Modified

| File | Lines Changed | Key Changes |
|------|---------------|-------------|
| `src/core/agentic/types.ts:361-463` | +103 | Added `DiffUndoPayload`, `HotActionsFile`, `ActionsArchiveFile`, updated `AppliedActionRecord` |
| `src/core/agentic/actionHistory.ts:1-905` | Complete rewrite | Hot + archive structure, diff undo, migration |
| `src/core/agentic/actionApplier.ts:1-1167` | ~200 lines | Added reasoning param, diff-based undo for content changes |

---

## New Types (`types.ts:361-463`)

```typescript
DiffUndoPayload {
  type: "diff";
  patches: Array<{ path: string; diff: string }>;
}

AppliedActionStatus = "pending" | "applied" | "undone" | "failed";

AppliedActionRecord {
  // ... existing fields ...
  reasoning: string;  // NEW: Why agent made this decision
  status: AppliedActionStatus;  // NEW: Current status
}

HotActionsFile {
  version: number;
  records: AppliedActionRecord[];
  oldestTimestamp: number;
  newestTimestamp: number;
}

ActionsArchiveFile {
  version: number;
  yearMonth: string;
  records: AppliedActionRecord[];
  recordCount: number;
  archivedAt: number;
}
```

---

## Rewritten Class: ActionHistory (`actionHistory.ts`)

### Constants

```typescript
ACTIONS_VERSION = 2        // Schema version
MAX_HOT_ACTIONS = 200      // Trigger archival when exceeded
ARCHIVE_THRESHOLD = 150    // Number of records to archive
FLUSH_DEBOUNCE_MS = 500    // Save debounce delay
```

### Public Methods

| Method | Line | Signature | Purpose |
|--------|------|-----------|---------|
| `load()` | 84-109 | `async (): Promise<void>` | Loads hot actions + migration |
| `addRecord()` | 114-148 | `(action, undo, paths, reasoning, workflowId?, taskId?): AppliedActionRecord` | Add record with reasoning |
| `flush()` | 216-239 | `async (): Promise<void>` | Save hot actions (debounced) |
| `getRecord()` | 256-258 | `(id): AppliedActionRecord \| undefined` | Get by ID (hot only) |
| `getAllRecords()` | 263-265 | `(): AppliedActionRecord[]` | Get all hot records |
| `getRecordsForNote()` | 270-274 | `(path): AppliedActionRecord[]` | Filter by note path |
| `getRecordsForWorkflow()` | 279-281 | `(id): AppliedActionRecord[]` | Filter by workflow |
| `getRecentRecords()` | 286-288 | `(limit?): AppliedActionRecord[]` | Recent for dashboard |
| `getArchivedActions()` | 293-304 | `async (yearMonth): Promise<AppliedActionRecord[]>` | Query monthly archive |
| `listArchiveMonths()` | 309-322 | `async (): Promise<string[]>` | List available archives |
| `undo()` | 327-372 | `async (recordId): Promise<UndoResult>` | Undo action |
| `canUndo()` | 511-527 | `(recordId): boolean` | Check if undoable |
| `updateStatus()` | 532-538 | `(recordId, status): void` | Update record status |
| `clear()` | 550-553 | `(): void` | Clear all hot records |
| `prune()` | 559-562 | `(): void` | No-op (backward compat) |
| `dispose()` | 579-585 | `async (): Promise<void>` | Final flush |

### Private Methods

| Method | Line | Purpose |
|--------|------|---------|
| `archiveOldRecords()` | 153-180 | Archive oldest 150 when >200 |
| `appendToArchive()` | 185-213 | Append to monthly file |
| `scheduleFlush()` | 244-253 | Debounced save |
| `applyUndo()` | 377-389 | Route to undo type handler |
| `undoRestoreContent()` | 394-429 | Legacy full content restore |
| `undoRenameBack()` | 434-455 | Rename/move undo |
| `undoDiff()` | 460-504 | Apply reverse diff |
| `migrateIfNeeded()` | 591-656 | Migrate legacy actions.json |

### Exported Diff Utilities

| Function | Line | Purpose |
|----------|------|---------|
| `createUnifiedDiff()` | 685-818 | Create unified diff (new→old for undo) |
| `applyReverseDiff()` | 828-903 | Apply diff to restore content |

---

## Updated Class: ActionApplier (`actionApplier.ts`)

### Method Signature Changes

All `apply*` methods now accept `reasoning?: string`:

```typescript
async apply(
  action: ProposedAction,
  taskId?: string,
  workflowId?: string,
  skipConfirmation = false,
  reasoning = "Action applied by agent",  // NEW
): Promise<ApplyResult>
```

### Undo Strategy by Action Type

| Action Type | Undo Type | Reason |
|-------------|-----------|--------|
| `frontmatter_set` | DiffUndoPayload | Content modification |
| `frontmatter_add_tags` | DiffUndoPayload | Content modification |
| `append_section` | DiffUndoPayload | Content modification |
| `append_related_links` | DiffUndoPayload | Content modification |
| `restructure_note` | DiffUndoPayload | Content modification |
| `append_review_section` | DiffUndoPayload | Content modification |
| `batch_append_links` | DiffUndoPayload | Content modification |
| `move_note` | RenameBackUndo | Path operation |
| `create_note` | RestoreContentUndo (before="") | File creation |
| `batch_create_notes` | RestoreContentUndo (before="") | File creation |
| `create_task_note` | RestoreContentUndo (before="") | File creation |
| `create_synthesis_note` | RestoreContentUndo (before="") | File creation |

---

## Storage Structure

### Hot File: `data/actions/hot/current.json`

```json
{
  "version": 2,
  "records": [
    {
      "id": "action-1736507123456-a1b2c3",
      "timestamp": 1736507123456,
      "workflowId": "workflow-xyz",
      "action": { "type": "append_section", ... },
      "reasoning": "User requested summary section based on context",
      "undo": {
        "type": "diff",
        "patches": [{ "path": "notes/example.md", "diff": "..." }]
      },
      "changedPaths": ["notes/example.md"],
      "status": "applied"
    }
  ],
  "oldestTimestamp": 1736500000000,
  "newestTimestamp": 1736507123456
}
```

### Archive Files: `data/actions/archive/{YYYY-MM}.json`

```json
{
  "version": 2,
  "yearMonth": "2026-01",
  "records": [/* AppliedActionRecord[] */],
  "recordCount": 150,
  "archivedAt": 1736507200000
}
```

---

## Migration Approach

1. **Detection**: Checks for legacy `actions.json` at `storagePaths.legacyActions`
2. **Skip if migrated**: If `data/actions/hot/current.json` exists, skip
3. **Convert records**: Add `reasoning` and `status` fields to legacy records
   - `reasoning: "Legacy action - no reasoning recorded"`
   - `status: "applied"`
4. **Split**: Last 200 → hot file, older → grouped by month into archives
5. **Archive legacy**: Move to `data/_operational/temp/_deleted/actions-legacy-{timestamp}.json`

---

## Diff Algorithm

### Creating Diff (`createUnifiedDiff`)

1. Split both contents into lines
2. Walk through lines comparing old vs new
3. Use lookahead (10 lines) to find best matches
4. Generate unified diff hunks with 3-line context
5. Returns standard unified diff format

### Applying Reverse Diff (`applyReverseDiff`)

1. Parse diff into hunks
2. Apply hunks in reverse order (bottom to top) to preserve line numbers
3. For reverse application:
   - `+` lines (additions) → remove
   - `-` lines (deletions) → add back
   - ` ` lines (context) → preserve

---

## Backward Compatibility

| Feature | Status |
|---------|--------|
| Constructor accepts retention config | ✓ (ignored, uses archival instead) |
| `prune()` method | ✓ (no-op, archival handles cleanup) |
| `RestoreContentUndo` support | ✓ (still works for file creation undo) |
| `RenameBackUndo` support | ✓ (unchanged) |

---

## Verification Results

### Build

```bash
$ bun run typecheck
$ tsc --noEmit
# No errors

$ bun run build
# Build complete in 62ms
# main.js: 557.2kb
```

---

## Previous Phases

### Phase 4: Per-Note Conversations (COMPLETE)
Per-note conversation storage with lazy loading and reasoning summary extraction.

### Phase 3: Intelligence Tag-Keyed Sharding (COMPLETE)
Reorganized intelligence from model-keyed to topic-keyed files.

### Phase 2: Chunk/Embedding Separation (COMPLETE)
Separated storage for chunks (model-agnostic) and embeddings (model-specific).

### Phase 1: Storage Path Infrastructure (COMPLETE)
Established path infrastructure for hierarchical storage with 45+ path constants.

---

## Next Steps

All 5 phases of storage restructure are complete:
1. ~~Update version number in `manifest.json` if needed~~ ✅ **Done** - Bumped to v0.2.0
2. ~~Test full workflow end-to-end in test vault~~ ✅ **Verified**
3. ~~Clean up any orphaned legacy files~~ ✅ **Done** - Migration handles automatically (moves to `data/_operational/temp/_deleted/`)

