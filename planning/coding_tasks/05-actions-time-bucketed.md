# Phase 5: Actions Time-Bucketed + Diff Undo + Reasoning

## Objective

Restructure action history for:
- Time-bucketed archival (monthly files, keep forever)
- Diff-based undo (smaller payloads)
- Inline reasoning traces (from chat, summarized)

## Prerequisites

- Phase 1 completed (storage paths)
- Phase 4 completed (reasoning flow from chat established)
- Read `/.claude/CLAUDE.md` for project context
- Read current implementation:
  - `src/core/agentic/actionHistory.ts`
  - `src/core/agentic/types.ts`
  - `src/core/agentic/actionApplier.ts`

## Files to Modify

1. `src/core/agentic/types.ts` - Add diff-based undo types
2. `src/core/agentic/actionHistory.ts` - Implement time buckets and diff undo
3. `src/core/agentic/actionApplier.ts` - Generate diffs instead of full content

## Current Architecture

**Single file**: `actions.json`
```json
{
  "version": 1,
  "records": [
    {
      "id": "action-001",
      "timestamp": 1704700000000,
      "action": { "type": "edit", "target": "...", ... },
      "undo": {
        "type": "restore_content",
        "files": [
          { "path": "...", "before": "FULL FILE CONTENT HERE" }
        ]
      },
      "status": "applied"
    }
  ]
}
```

**Problems**:
- Full content stored (bloated)
- Flat list (no archival)
- No reasoning traces

## Target Architecture

### Hot File (`data/actions/hot/current.json`)

Recent 200 actions:
```json
{
  "version": 2,
  "records": [
    {
      "id": "action-xyz",
      "timestamp": 1704705600000,
      "workflowId": "workflow-abc",
      "action": {
        "type": "edit",
        "target": "projects/auth/setup.md",
        "title": "Added JWT configuration section"
      },
      "reasoning": "User asked about JWT setup. Based on context from [[security-guide]] and current best practices, added configuration section.",
      "undo": {
        "type": "diff",
        "patches": [
          {
            "path": "projects/auth/setup.md",
            "diff": "@@ -10,0 +11,5 @@\n+## JWT Configuration\n+\n+Add your JWT secret to `.env`:\n+```\n+JWT_SECRET=your-secret-here\n+```"
          }
        ]
      },
      "changedPaths": ["projects/auth/setup.md"],
      "status": "applied"
    }
  ],
  "oldestTimestamp": 1704700000000,
  "newestTimestamp": 1704705600000
}
```

### Archive Files (`data/actions/archive/{YYYY-MM}.json`)

Monthly archives:
```json
{
  "version": 2,
  "yearMonth": "2026-01",
  "records": [ ... ],
  "recordCount": 150,
  "archivedAt": 1704790800000
}
```

## Key Changes

### 1. Diff-Based Undo

Instead of storing full file content, store unified diff:

```typescript
interface DiffUndoPayload {
  type: "diff";
  patches: Array<{
    path: string;
    diff: string;  // Unified diff format
  }>;
}
```

### 2. Inline Reasoning

```typescript
interface AppliedActionRecord {
  // ... existing fields ...
  reasoning: string;  // Why the agent made this decision
}
```

### 3. Time Bucketing

- Hot file: Recent 200 actions
- On overflow: Move oldest 150 to monthly archive
- Archives: `2026-01.json`, `2026-02.json`, etc.

## Implementation Steps

### Step 1: Update Types (`types.ts`)

```typescript
/**
 * Diff-based undo payload (NEW)
 */
export interface DiffUndoPayload {
  type: "diff";
  patches: Array<{
    path: string;
    diff: string;  // Unified diff format
  }>;
}

/**
 * Rename undo (existing, unchanged)
 */
export interface RenameBackUndo {
  type: "rename_back";
  from: string;
  to: string;
}

/**
 * Legacy full content undo (for migration compatibility)
 */
export interface RestoreContentUndo {
  type: "restore_content";
  files: Array<{
    path: string;
    before: string;
  }>;
}

/**
 * Combined undo type
 */
export type UndoPayload = DiffUndoPayload | RenameBackUndo | RestoreContentUndo;

/**
 * Action record with reasoning
 */
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

/**
 * Hot actions file structure
 */
export interface HotActionsFile {
  version: number;
  records: AppliedActionRecord[];
  oldestTimestamp: number;
  newestTimestamp: number;
}

/**
 * Archive file structure
 */
export interface ActionsArchiveFile {
  version: number;
  yearMonth: string;
  records: AppliedActionRecord[];
  recordCount: number;
  archivedAt: number;
}
```

### Step 2: Add Diff Utilities

Create or add to utils:

```typescript
/**
 * Simple unified diff generator
 * Note: For production, consider using a library like 'diff'
 */
export function createUnifiedDiff(
  oldContent: string,
  newContent: string,
  path: string
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple line-by-line diff (could use more sophisticated algorithm)
  const hunks: string[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldLines[oldIdx];
    const newLine = newLines[newIdx];

    if (oldLine === newLine) {
      oldIdx++;
      newIdx++;
    } else if (oldLine === undefined) {
      // Addition
      hunks.push(`@@ -${oldIdx},0 +${newIdx + 1},1 @@`);
      hunks.push(`+${newLine}`);
      newIdx++;
    } else if (newLine === undefined) {
      // Deletion
      hunks.push(`@@ -${oldIdx + 1},1 +${newIdx},0 @@`);
      hunks.push(`-${oldLine}`);
      oldIdx++;
    } else {
      // Change
      hunks.push(`@@ -${oldIdx + 1},1 +${newIdx + 1},1 @@`);
      hunks.push(`-${oldLine}`);
      hunks.push(`+${newLine}`);
      oldIdx++;
      newIdx++;
    }
  }

  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`;
}

/**
 * Apply unified diff to restore original content
 */
export function applyReverseDiff(
  currentContent: string,
  diff: string
): string {
  // Parse diff and apply in reverse (+ becomes -, - becomes +)
  const lines = diff.split('\n');
  const result = currentContent.split('\n');

  // Simple implementation - for production, use a proper diff library
  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Parse hunk header
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        // Process hunk...
      }
    }
  }

  return result.join('\n');
}
```

**Note**: For production, recommend using `diff` npm package. The above is simplified.

### Step 3: Rewrite ActionHistory

```typescript
const ACTIONS_VERSION = 2;
const MAX_HOT_ACTIONS = 200;
const ARCHIVE_THRESHOLD = 150;  // When to archive

export class ActionHistory {
  private records: AppliedActionRecord[] = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(
    private storagePaths: StoragePaths,
    private obsidian: ObsidianFacade,
    private eventBus: EventBus,
  ) {}

  /**
   * Load hot actions from disk
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    // Migrate if needed
    await this.migrateIfNeeded();

    const hotPath = this.storagePaths.actionsCurrent;

    try {
      const content = await fs.promises.readFile(hotPath, 'utf-8');
      const data: HotActionsFile = JSON.parse(content);

      this.records = data.records || [];
      this.loaded = true;

      console.log(`[ActionHistory] Loaded ${this.records.length} hot actions`);
    } catch {
      this.loaded = true;
      console.log('[ActionHistory] No existing hot actions');
    }
  }

  /**
   * Add action record with reasoning
   */
  async addRecord(
    action: AgentAction,
    undo: UndoPayload,
    changedPaths: string[],
    reasoning: string,
    workflowId?: string
  ): Promise<AppliedActionRecord> {
    const record: AppliedActionRecord = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      workflowId,
      action,
      reasoning,
      undo,
      changedPaths,
      status: "applied",
    };

    this.records.push(record);
    this.dirty = true;

    // Check if we need to archive
    if (this.records.length > MAX_HOT_ACTIONS) {
      await this.archiveOldRecords();
    }

    this.scheduleFlush();
    this.eventBus.emit("action:applied", { record });

    return record;
  }

  /**
   * Archive oldest records to monthly file
   */
  private async archiveOldRecords(): Promise<void> {
    if (this.records.length <= ARCHIVE_THRESHOLD) return;

    // Get records to archive
    const toArchive = this.records.slice(0, ARCHIVE_THRESHOLD);
    this.records = this.records.slice(ARCHIVE_THRESHOLD);

    // Group by month
    const byMonth = new Map<string, AppliedActionRecord[]>();

    for (const record of toArchive) {
      const date = new Date(record.timestamp);
      const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!byMonth.has(yearMonth)) {
        byMonth.set(yearMonth, []);
      }
      byMonth.get(yearMonth)!.push(record);
    }

    // Save to archive files
    for (const [yearMonth, records] of byMonth) {
      await this.appendToArchive(yearMonth, records);
    }

    console.log(`[ActionHistory] Archived ${toArchive.length} records`);
  }

  /**
   * Append records to monthly archive file
   */
  private async appendToArchive(yearMonth: string, newRecords: AppliedActionRecord[]): Promise<void> {
    const archivePath = this.storagePaths.getActionArchivePath(yearMonth);

    let existing: AppliedActionRecord[] = [];

    try {
      const content = await fs.promises.readFile(archivePath, 'utf-8');
      const data: ActionsArchiveFile = JSON.parse(content);
      existing = data.records;
    } catch {
      // File doesn't exist yet
    }

    const allRecords = [...existing, ...newRecords];

    const archive: ActionsArchiveFile = {
      version: ACTIONS_VERSION,
      yearMonth,
      records: allRecords,
      recordCount: allRecords.length,
      archivedAt: Date.now(),
    };

    await atomicWriteFile(archivePath, JSON.stringify(archive, null, 2));
  }

  /**
   * Save hot actions
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const hotPath = this.storagePaths.actionsCurrent;

    const data: HotActionsFile = {
      version: ACTIONS_VERSION,
      records: this.records,
      oldestTimestamp: this.records[0]?.timestamp ?? Date.now(),
      newestTimestamp: this.records[this.records.length - 1]?.timestamp ?? Date.now(),
    };

    await atomicWriteFile(hotPath, JSON.stringify(data, null, 2));
    this.dirty = false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 500);
  }

  /**
   * Undo an action
   */
  async undo(recordId: string): Promise<UndoResult> {
    const recordIndex = this.records.findIndex(r => r.id === recordId);
    if (recordIndex === -1) {
      return { success: false, error: `Record not found: ${recordId}` };
    }

    const record = this.records[recordIndex];

    try {
      const result = await this.applyUndo(record.undo);

      if (result.success) {
        // Remove record after successful undo
        this.records.splice(recordIndex, 1);
        this.dirty = true;
        this.scheduleFlush();
        this.eventBus.emit("action:undone", { recordId });
      }

      return result;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Apply undo based on type
   */
  private async applyUndo(payload: UndoPayload): Promise<UndoResult> {
    switch (payload.type) {
      case "diff":
        return this.undoDiff(payload);
      case "rename_back":
        return this.undoRename(payload);
      case "restore_content":
        return this.undoRestoreContent(payload);  // Legacy support
      default:
        return { success: false, error: `Unknown undo type` };
    }
  }

  /**
   * Undo using diff (apply reverse patch)
   */
  private async undoDiff(payload: DiffUndoPayload): Promise<UndoResult> {
    const errors: string[] = [];

    for (const patch of payload.patches) {
      try {
        // Read current content
        const current = await this.obsidian.readFileByPath(patch.path);
        if (current === null) {
          errors.push(`File not found: ${patch.path}`);
          continue;
        }

        // Apply reverse diff
        const restored = applyReverseDiff(current, patch.diff);

        // Write restored content
        const result = await this.obsidian.modifyFile(patch.path, restored);
        if (!result.success) {
          errors.push(`Failed to restore ${patch.path}: ${result.error}`);
        }
      } catch (error) {
        errors.push(`Error restoring ${patch.path}: ${error}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }

  /**
   * Get archived actions for a month
   */
  async getArchivedActions(yearMonth: string): Promise<AppliedActionRecord[]> {
    const archivePath = this.storagePaths.getActionArchivePath(yearMonth);

    try {
      const content = await fs.promises.readFile(archivePath, 'utf-8');
      const data: ActionsArchiveFile = JSON.parse(content);
      return data.records;
    } catch {
      return [];
    }
  }

  /**
   * List available archive months
   */
  async listArchiveMonths(): Promise<string[]> {
    const archiveDir = this.storagePaths.actionsArchive;

    try {
      const files = await fs.promises.readdir(archiveDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort()
        .reverse();  // Most recent first
    } catch {
      return [];
    }
  }

  // ... existing methods (getRecord, getRecentRecords, etc.)

  /**
   * Migration from legacy format
   */
  private async migrateIfNeeded(): Promise<void> {
    const legacyPath = this.storagePaths.legacyActions;

    try {
      const exists = await fs.promises.access(legacyPath).then(() => true).catch(() => false);
      if (!exists) return;

      // Check if already migrated
      const hotPath = this.storagePaths.actionsCurrent;
      const hotExists = await fs.promises.access(hotPath).then(() => true).catch(() => false);
      if (hotExists) return;

      console.log('[ActionHistory] Migrating legacy actions...');

      // Read legacy
      const content = await fs.promises.readFile(legacyPath, 'utf-8');
      const legacy = JSON.parse(content);

      // Ensure directories
      await fs.promises.mkdir(this.storagePaths.actionsHot, { recursive: true });
      await fs.promises.mkdir(this.storagePaths.actionsArchive, { recursive: true });

      // Convert records (add reasoning field, keep undo as-is for now)
      const records: AppliedActionRecord[] = (legacy.records ?? []).map((r: any) => ({
        ...r,
        reasoning: r.reasoning ?? "Legacy action - no reasoning recorded",
      }));

      // Split into hot and archives
      const hot = records.slice(-MAX_HOT_ACTIONS);
      const toArchive = records.slice(0, -MAX_HOT_ACTIONS);

      // Save hot
      this.records = hot;
      this.dirty = true;
      await this.flush();

      // Archive old records
      if (toArchive.length > 0) {
        const byMonth = new Map<string, AppliedActionRecord[]>();

        for (const record of toArchive) {
          const date = new Date(record.timestamp);
          const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

          if (!byMonth.has(yearMonth)) {
            byMonth.set(yearMonth, []);
          }
          byMonth.get(yearMonth)!.push(record);
        }

        for (const [yearMonth, recs] of byMonth) {
          await this.appendToArchive(yearMonth, recs);
        }
      }

      // Move legacy file
      const deletedPath = path.join(
        this.storagePaths.tempDeleted,
        `actions-legacy-${Date.now()}.json`
      );
      await fs.promises.rename(legacyPath, deletedPath);

      console.log(`[ActionHistory] Migration complete: ${hot.length} hot, ${toArchive.length} archived`);
    } catch (error) {
      console.error('[ActionHistory] Migration failed:', error);
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
```

### Step 4: Update ActionApplier for Diffs

In `actionApplier.ts`, generate diffs when applying edits:

```typescript
// When applying an edit action:

async applyEdit(action: EditAction): Promise<ApplyResult> {
  const { path, newContent } = action;

  // Read current content BEFORE applying
  const oldContent = await this.obsidian.readFileByPath(path);
  if (oldContent === null) {
    return { success: false, error: 'File not found' };
  }

  // Apply the edit
  const result = await this.obsidian.modifyFile(path, newContent);
  if (!result.success) {
    return result;
  }

  // Generate diff for undo
  const diff = createUnifiedDiff(newContent, oldContent, path);  // Reversed!

  const undoPayload: DiffUndoPayload = {
    type: "diff",
    patches: [{ path, diff }],
  };

  return {
    success: true,
    undo: undoPayload,
  };
}
```

### Step 5: Wire Reasoning from Chat

When an action is triggered from chat, pass reasoning:

```typescript
// In ChiefOfStaff or WorkflowRunner:

const actionResult = await this.actionApplier.apply(action);

if (actionResult.success) {
  // Get reasoning from the agent's thinking
  const reasoning = agentContext.reasoning ?? "Action applied by agent";

  await this.actionHistory.addRecord(
    action,
    actionResult.undo,
    [action.target],
    reasoning,
    workflowId
  );
}
```

## Verification

### 1. Build Check
```bash
bun run typecheck
bun run build
bun run dev
```

### 2. Migration Test

1. Start with existing `actions.json` (>200 records if possible)
2. Load plugin
3. Verify:
   - `data/actions/hot/current.json` created
   - `data/actions/archive/{YYYY-MM}.json` created for old records
   - Legacy file moved to `_deleted/`

### 3. Diff Undo Test

1. Open a note
2. Trigger an edit action (via Quick Action or chat)
3. Verify action stored with `type: "diff"` undo
4. Test undo - verify content restored correctly

### 4. Archival Test

1. Generate many actions (or manually add to test)
2. Verify when >200, oldest are archived
3. Verify archive files created by month

### 5. Reasoning Test

1. Trigger action from chat (agent decision)
2. Verify `reasoning` field captured in action record
3. View in Agent Streams UI

## Commit Message

```
refactor(actions): Implement time-bucketed storage with diff undo

- Replace single file with hot + monthly archives
- Implement diff-based undo (smaller payloads)
- Add inline reasoning field
- Add archive query methods
- Migrate legacy actions

Part of storage restructure Phase 5.
```

## Post-Implementation

After all 5 phases complete:
1. Update version number in `manifest.json`
2. Test full workflow end-to-end
3. Clean up any orphaned legacy files
4. Update CLAUDE.md with final architecture notes
