# Phase 1: Storage Paths + Directory Structure

## Objective

Update the storage path infrastructure to support the new directory structure. This phase is foundational - all other phases depend on it.

## Prerequisites

- Read `/.claude/CLAUDE.md` for project context and code map
- Read `00-storage-restructure-overview.md` for target architecture

## Files to Modify

1. `src/core/constants.ts` - Update STORAGE_PATHS
2. `src/services/storagePaths.ts` - Add new path getters
3. `src/types/settings.ts` - Add migration version tracking (if needed)

## Current State

**constants.ts** defines:
```typescript
export const STORAGE_PATHS = {
  CACHE: "cache",
  LOCKS: "locks",
  LOGS: "logs",
  INDEX_STATE: "index-state.json",
  CONVERSATIONS: "conversations.json",
  ACTIONS: "actions.json",
  PROFILE: "profile.json",
} as const;
```

**storagePaths.ts** provides:
- `pluginRoot` - `.obsidian/plugins/notient`
- `cache`, `locks`, `logs` - Subdirectories
- `conversations`, `actions`, `profile` - File paths
- `ensureDirectories()` - Creates required directories

## Target State

### constants.ts

```typescript
export const STORAGE_PATHS = {
  // Root data folder (new)
  DATA: "data",

  // Chunks (model-agnostic)
  CHUNKS: "data/chunks",
  CHUNKS_META: "data/chunks/meta.json",
  CHUNKS_NOTES: "data/chunks/notes",

  // Embeddings (model-scoped)
  EMBEDDINGS: "data/embeddings",
  EMBEDDINGS_ACTIVE: "data/embeddings/active",
  EMBEDDINGS_REBUILDING: "data/embeddings/_rebuilding",
  EMBEDDINGS_ARCHIVED: "data/embeddings/_archived",

  // Intelligence (tag-keyed)
  INTELLIGENCE: "data/intelligence",
  INTELLIGENCE_META: "data/intelligence/meta.json",
  INTELLIGENCE_TOPICS: "data/intelligence/topics",

  // Conversations (per-note)
  CONVERSATIONS: "data/conversations",
  CONVERSATIONS_NOTES: "data/conversations/notes",
  CONVERSATIONS_ROLLUPS: "data/conversations/rollups",
  CONVERSATIONS_ROOT: "data/conversations/_root.json",

  // Actions (time-bucketed)
  ACTIONS: "data/actions",
  ACTIONS_HOT: "data/actions/hot",
  ACTIONS_CURRENT: "data/actions/hot/current.json",
  ACTIONS_ARCHIVE: "data/actions/archive",

  // Profile
  PROFILE: "data/profile",
  PROFILE_FILE: "data/profile/profile.json",

  // Operational (volatile)
  OPERATIONAL: "data/_operational",
  LOCKS: "data/_operational/locks",
  CACHE: "data/_operational/cache",
  TEMP: "data/_operational/temp",
  TEMP_INCOMPLETE: "data/_operational/temp/_incomplete",
  TEMP_INVALID: "data/_operational/temp/_invalid",
  TEMP_DELETED: "data/_operational/temp/_deleted",
  LOGS: "data/_operational/logs",

  // Legacy paths (for migration detection)
  LEGACY_CONVERSATIONS: "conversations.json",
  LEGACY_ACTIONS: "actions.json",
  LEGACY_PROFILE: "profile.json",
  LEGACY_CACHE: "cache",
  LEGACY_LOCKS: "locks",
  LEGACY_LOGS: "logs",
} as const;
```

### storagePaths.ts

Add these new getters and methods to the `StoragePaths` class:

```typescript
export interface StoragePathsConfig {
  // Existing
  vaultRoot: string;
  vaultHash: string;
  pluginRoot: string;

  // New structure
  data: string;

  // Chunks
  chunks: string;
  chunksMeta: string;
  chunksNotes: string;

  // Embeddings
  embeddings: string;
  embeddingsActive: string;
  embeddingsRebuilding: string;
  embeddingsArchived: string;

  // Intelligence
  intelligence: string;
  intelligenceMeta: string;
  intelligenceTopics: string;

  // Conversations
  conversations: string;
  conversationsNotes: string;
  conversationsRollups: string;
  conversationsRoot: string;

  // Actions
  actions: string;
  actionsHot: string;
  actionsCurrent: string;
  actionsArchive: string;

  // Profile
  profile: string;
  profileFile: string;

  // Operational
  operational: string;
  locks: string;
  cache: string;
  temp: string;
  tempIncomplete: string;
  tempInvalid: string;
  tempDeleted: string;
  logs: string;

  // Legacy (for migration)
  legacyConversations: string;
  legacyActions: string;
  legacyProfile: string;
}
```

Add these methods:

```typescript
class StoragePaths {
  // ... existing code ...

  /**
   * Check if legacy (pre-restructure) data exists
   */
  hasLegacyData(): boolean {
    // Check for any legacy file/folder
    return (
      fs.existsSync(this.config.legacyConversations) ||
      fs.existsSync(this.config.legacyActions) ||
      fs.existsSync(this.config.legacyProfile)
    );
  }

  /**
   * Check if new structure exists
   */
  hasNewStructure(): boolean {
    return fs.existsSync(this.config.data);
  }

  /**
   * Get path for a specific note's chunk file
   */
  getChunkPath(noteId: string): string {
    return path.join(this.config.chunksNotes, `${noteId}.json`);
  }

  /**
   * Get path for a specific note's conversation file
   */
  getConversationPath(noteId: string): string {
    return path.join(this.config.conversationsNotes, `${noteId}.json`);
  }

  /**
   * Get path for a conversation rollup (PARA folder)
   */
  getConversationRollupPath(paraFolder: string): string {
    // Sanitize folder path for filename
    const sanitized = paraFolder.replace(/[\/\\]/g, '-').replace(/^-|-$/g, '');
    return path.join(this.config.conversationsRollups, `${sanitized}.json`);
  }

  /**
   * Get path for an intelligence topic file
   */
  getIntelligenceTopicPath(tag: string): string {
    // Sanitize tag for filename
    const sanitized = tag.replace(/^#/, '').replace(/[\/\\:*?"<>|]/g, '-');
    return path.join(this.config.intelligenceTopics, `${sanitized}.json`);
  }

  /**
   * Get path for embedding index (current model)
   */
  getEmbeddingIndexPath(modelKey: string, dimension: number): string {
    const sanitized = modelKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.embeddingsActive, `${sanitized}-${dimension}d.json`);
  }

  /**
   * Get path for archived embedding index
   */
  getArchivedEmbeddingPath(modelKey: string, dimension: number, timestamp: string): string {
    const sanitized = modelKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.embeddingsArchived, `${sanitized}-${dimension}d-${timestamp}.json`);
  }

  /**
   * Get path for monthly action archive
   */
  getActionArchivePath(yearMonth: string): string {
    return path.join(this.config.actionsArchive, `${yearMonth}.json`);
  }

  /**
   * Ensure all new directories exist
   */
  async ensureNewDirectories(): Promise<void> {
    const dirs = [
      this.config.data,
      this.config.chunks,
      this.config.chunksNotes,
      this.config.embeddings,
      this.config.embeddingsActive,
      this.config.embeddingsRebuilding,
      this.config.embeddingsArchived,
      this.config.intelligence,
      this.config.intelligenceTopics,
      this.config.conversations,
      this.config.conversationsNotes,
      this.config.conversationsRollups,
      this.config.actions,
      this.config.actionsHot,
      this.config.actionsArchive,
      this.config.profile,
      this.config.operational,
      this.config.locks,
      this.config.cache,
      this.config.temp,
      this.config.tempIncomplete,
      this.config.tempInvalid,
      this.config.tempDeleted,
      this.config.logs,
    ];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }
}
```

## Implementation Steps

### Step 1: Update constants.ts

1. Read the current file
2. Replace `STORAGE_PATHS` with the new structure
3. Keep `PLUGIN_ID` and other constants unchanged

### Step 2: Update StoragePathsConfig interface

1. Add all new path properties
2. Keep existing properties for backwards compatibility during migration

### Step 3: Update StoragePaths constructor

1. Initialize all new paths using the constants
2. Compute full absolute paths from `pluginRoot`

### Step 4: Add new methods

1. `hasLegacyData()` - Detects old structure
2. `hasNewStructure()` - Detects new structure
3. `getChunkPath(noteId)` - Per-note chunk file
4. `getConversationPath(noteId)` - Per-note conversation
5. `getConversationRollupPath(folder)` - PARA rollup
6. `getIntelligenceTopicPath(tag)` - Tag-based intelligence
7. `getEmbeddingIndexPath(model, dim)` - Active embedding index
8. `getArchivedEmbeddingPath(...)` - Archived index
9. `getActionArchivePath(yearMonth)` - Monthly archive
10. `ensureNewDirectories()` - Create all new folders

### Step 5: Update ensureDirectories()

Modify existing method to call `ensureNewDirectories()` when appropriate.

## Verification

### 1. Build Check
```bash
bun run typecheck
bun run build
```

### 2. Unit Verification

Create a test script or verify manually:
```typescript
const paths = new StoragePaths(app);

// Check paths are correct
console.log(paths.chunks);  // Should be absolute path
console.log(paths.getChunkPath("abc123"));  // Should include noteId
console.log(paths.getIntelligenceTopicPath("#research"));  // Should sanitize

// Check detection
console.log(paths.hasLegacyData());  // true if old files exist
console.log(paths.hasNewStructure());  // false initially
```

### 3. Directory Creation
```typescript
await paths.ensureNewDirectories();
// Verify all directories exist
```

## Migration Notes

This phase does NOT migrate data - it only sets up the infrastructure. Migration happens in subsequent phases:

- Phase 2: Migrates index data
- Phase 3: Migrates intelligence data
- Phase 4: Migrates conversation data
- Phase 5: Migrates action data

## Commit Message

```
refactor(storage): Add new directory structure paths

- Update STORAGE_PATHS with hierarchical structure
- Add path getters for chunks, embeddings, intelligence, conversations, actions
- Add legacy path detection for migration support
- Add ensureNewDirectories() for new folder structure

Part of storage restructure Phase 1.
```

## Next Phase

After this phase is complete, proceed to Phase 2 (Chunk/Embedding Separation).
