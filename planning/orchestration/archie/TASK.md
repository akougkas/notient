# Archie - Phase 5: Actions Time-Bucketed + Diff Undo

> **Status**: ASSIGNED
> **Assigned**: 2026-01-10
> **Branch**: `archie/backend-fixes`
> **Spec**: `planning/coding_tasks/05-actions-time-bucketed.md`

---

## Git Workflow (CRITICAL)

### Before Starting
```bash
git status
git diff --name-only
```
Understand what files are already modified. DO NOT touch files you don't need.

### During Work
- ONLY modify files listed in "Files to Modify" below
- Keep changes focused and minimal

### After Completing
```bash
# Stage ONLY your files
git add src/core/agentic/types.ts
git add src/core/agentic/actionHistory.ts
git add src/core/agentic/actionApplier.ts
git add planning/orchestration/archie/REPORT.md

# Commit with descriptive message
git commit -m "refactor(actions): Implement time-bucketed storage with diff undo

- Replace single file with hot + monthly archives
- Implement diff-based undo (smaller payloads)
- Add inline reasoning field
- Add archive query methods
- Migrate legacy actions

Phase 5 of storage restructure."

# DO NOT PUSH - only commit
```

### Rules
- **NO `git push`** - Only local commits
- **NO staging unrelated files** - Check `git status` before commit
- **NO amending** other people's commits

---

## Objective

Restructure action history for:
- Time-bucketed archival (monthly files, keep forever)
- Diff-based undo (smaller payloads)
- Inline reasoning traces (from chat, summarized)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/agentic/types.ts` | Add DiffUndoPayload, HotActionsFile, ActionsArchiveFile, update AppliedActionRecord |
| `src/core/agentic/actionHistory.ts` | Rewrite for hot + archive structure, diff undo, migration |
| `src/core/agentic/actionApplier.ts` | Generate diffs instead of full content for undo |

---

## Implementation Steps

### 1. Add Types (`types.ts`)

```typescript
// Diff-based undo payload
export interface DiffUndoPayload {
  type: "diff";
  patches: Array<{
    path: string;
    diff: string;  // Unified diff format
  }>;
}

// Combined undo type
export type UndoPayload = DiffUndoPayload | RenameBackUndo | RestoreContentUndo;

// Updated action record with reasoning
export interface AppliedActionRecord {
  id: string;
  timestamp: number;
  workflowId?: string;
  action: AgentAction;
  reasoning: string;  // NEW: Why agent made this decision
  undo: UndoPayload;
  changedPaths: string[];
  status: "pending" | "applied" | "undone" | "failed";
}

// Hot actions file structure
export interface HotActionsFile {
  version: number;
  records: AppliedActionRecord[];
  oldestTimestamp: number;
  newestTimestamp: number;
}

// Archive file structure
export interface ActionsArchiveFile {
  version: number;
  yearMonth: string;
  records: AppliedActionRecord[];
  recordCount: number;
  archivedAt: number;
}
```

### 2. Rewrite ActionHistory

- Hot file: `data/actions/hot/current.json` (recent 200 actions)
- Archives: `data/actions/archive/{YYYY-MM}.json` (monthly)
- Use `storagePaths.actionsCurrent`, `storagePaths.getActionArchivePath(yearMonth)`
- Key methods:
  - `load()` - Load hot actions (with migration)
  - `addRecord(action, undo, changedPaths, reasoning, workflowId?)` - Add with reasoning
  - `archiveOldRecords()` - Move oldest 150 to monthly archive when >200
  - `undo(recordId)` - Apply undo (supports diff, rename, restore_content)
  - `getArchivedActions(yearMonth)` - Query archives
  - `listArchiveMonths()` - List available archives

### 3. Update ActionApplier for Diffs

When applying edits:
1. Read current content BEFORE applying
2. Apply the edit
3. Generate unified diff for undo (reversed: new→old)
4. Return DiffUndoPayload instead of RestoreContentUndo

### 4. Migration Logic

- Detect legacy `actions.json`
- Split into hot (last 200) + archives (grouped by month)
- Add `reasoning: "Legacy action - no reasoning recorded"` to old records
- Move legacy file to `_deleted/`

---

## Use Phase 1 Path Methods

```typescript
storagePaths.actionsHot               // data/actions/hot/
storagePaths.actionsCurrent           // data/actions/hot/current.json
storagePaths.actionsArchive           // data/actions/archive/
storagePaths.getActionArchivePath(yearMonth)  // {YYYY-MM}.json
storagePaths.tempDeleted              // For archived legacy file
```

---

## Verification

```bash
bun run typecheck && bun run build
```

### Manual Tests
1. Start with existing `actions.json` file
2. Load plugin → migration should run
3. Verify `data/actions/hot/current.json` created
4. Verify archives created if >200 legacy actions
5. Test edit action → verify diff-based undo stored
6. Test undo → verify content restored correctly

---

## Report

When complete, update `planning/orchestration/archie/REPORT.md` with:
- Files modified (with line ranges)
- New types added
- Key methods implemented
- Migration approach
- Build verification results
