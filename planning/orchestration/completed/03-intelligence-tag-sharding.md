# Phase 3: Intelligence Tag-Based Sharding

## Objective

Reorganize intelligence storage from model-keyed single file to tag-keyed multiple files. This enables:
- Semantic organization by topic (matches how users think)
- Exportable knowledge bundles
- Keep forever philosophy (intelligence = learned knowledge)

## Prerequisites

- Phase 1 completed (storage paths)
- Read `/.claude/CLAUDE.md` for project context
- Read current implementation:
  - `src/core/intelligence/intelligenceDb.ts`
  - `src/core/intelligence/noteIntelligence.ts`
  - `src/core/intelligence/types.ts`

## Files to Modify

1. `src/core/intelligence/types.ts` - Add topic-related types
2. `src/core/intelligence/intelligenceDb.ts` - Rewrite for tag-based sharding
3. `src/core/intelligence/noteIntelligence.ts` - Update to use new IntelligenceDb API

## Current Architecture

**Single file**: `intelligence-{modelKey}.json`
```json
{
  "version": 1,
  "modelKey": "qwen3-embedding",
  "createdAt": 1704700000000,
  "updatedAt": 1704705600000,
  "records": {
    "path/to/note.md": { ... },
    "another/note.md": { ... }
  }
}
```

**Problem**: Model-keyed doesn't make sense (intelligence uses reasoning LLM, not embedding model).

## Target Architecture

### Topic Files (`data/intelligence/topics/{tag}.json`)

```json
{
  "version": 1,
  "topic": "research",
  "criteria": {
    "tags": ["research", "paper", "study"]
  },
  "records": {
    "3-resources/research/ml-paper.md": {
      "noteId": "abc123",
      "path": "3-resources/research/ml-paper.md",
      "mtimeMs": 1704700000000,
      "contentHash": "def456...",
      "generatedAt": 1704700600000,
      "summaryShort": "This paper explores...",
      "summaryStructured": {
        "keyPoints": ["Point 1", "Point 2"],
        "purpose": "Academic reference"
      },
      "health": {
        "score": 78,
        "breakdown": { ... },
        "computedAt": 1704700600000
      },
      "entities": [ ... ],
      "suggestedTags": [ ... ],
      "suggestedLinks": [ ... ],
      "triageAction": null
    }
  },
  "noteCount": 45,
  "lastUpdated": 1704705600000
}
```

### Meta File (`data/intelligence/meta.json`)

```json
{
  "version": 1,
  "topics": ["research", "project", "area", "security", "_uncategorized"],
  "totalNotes": 102,
  "totalRecords": 98,
  "lastUpdated": 1704705600000
}
```

### Uncategorized (`data/intelligence/topics/_uncategorized.json`)

Notes without any recognized tags go here.

## Topic Assignment Logic

```typescript
function getTopicForNote(notePath: string, noteTags: string[]): string {
  // 1. Check if note has any tags
  if (noteTags.length === 0) {
    return '_uncategorized';
  }

  // 2. Use first tag as topic (normalized)
  const primaryTag = noteTags[0]
    .replace(/^#/, '')           // Remove leading #
    .split('/')[0]               // Take first part of nested tag
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-'); // Sanitize

  return primaryTag || '_uncategorized';
}
```

**Example mappings**:
- `#research` → `research.json`
- `#project/iowarp` → `project.json`
- `#AI/machine-learning` → `ai.json`
- (no tags) → `_uncategorized.json`

## Implementation Steps

### Step 1: Add Types (`types.ts`)

```typescript
/**
 * Intelligence topic file structure
 */
export interface IntelligenceTopicFile {
  version: number;
  topic: string;
  criteria: {
    tags: string[];
  };
  records: Record<string, IntelligenceRecord>;
  noteCount: number;
  lastUpdated: number;
}

/**
 * Intelligence meta file structure
 */
export interface IntelligenceMeta {
  version: number;
  topics: string[];
  totalNotes: number;
  totalRecords: number;
  lastUpdated: number;
}
```

### Step 2: Rewrite IntelligenceDb

Replace single-file logic with multi-file topic management:

```typescript
const INTELLIGENCE_VERSION = 2;

export class IntelligenceDb {
  // Map: topic -> records
  private topics: Map<string, Map<string, IntelligenceRecord>> = new Map();
  private dirtyTopics: Set<string> = new Set();
  private disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private storagePaths: StoragePaths) {}

  /**
   * Load all topic files
   */
  async load(): Promise<void> {
    if (this.disposed) return;

    const topicsDir = this.storagePaths.intelligenceTopics;

    try {
      const files = await fs.promises.readdir(topicsDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const topic = file.replace('.json', '');
        const filePath = path.join(topicsDir, file);

        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const data: IntelligenceTopicFile = JSON.parse(content);

          const records = new Map<string, IntelligenceRecord>();
          for (const [notePath, record] of Object.entries(data.records)) {
            records.set(notePath, record);
          }

          this.topics.set(topic, records);
        } catch (error) {
          console.warn(`[IntelligenceDb] Failed to load topic ${topic}:`, error);
        }
      }

      console.log(`[IntelligenceDb] Loaded ${this.topics.size} topics`);
    } catch {
      // Directory might not exist yet
      console.log('[IntelligenceDb] No existing intelligence data');
    }
  }

  /**
   * Get record for a note
   */
  get(notePath: string): IntelligenceRecord | null {
    // Search all topics for this note
    for (const records of this.topics.values()) {
      const record = records.get(notePath);
      if (record) return record;
    }
    return null;
  }

  /**
   * Get all records for a topic
   */
  getTopicRecords(topic: string): IntelligenceRecord[] {
    const records = this.topics.get(topic);
    return records ? Array.from(records.values()) : [];
  }

  /**
   * Get all topics
   */
  getTopics(): string[] {
    return Array.from(this.topics.keys());
  }

  /**
   * Upsert a record (determines topic from tags)
   */
  upsert(notePath: string, record: IntelligenceRecord, noteTags: string[]): void {
    if (this.disposed) return;

    const newTopic = this.getTopicForNote(notePath, noteTags);

    // Remove from old topic if exists elsewhere
    for (const [topic, records] of this.topics) {
      if (topic !== newTopic && records.has(notePath)) {
        records.delete(notePath);
        this.dirtyTopics.add(topic);
      }
    }

    // Add to new topic
    if (!this.topics.has(newTopic)) {
      this.topics.set(newTopic, new Map());
    }
    this.topics.get(newTopic)!.set(notePath, record);
    this.dirtyTopics.add(newTopic);

    this.scheduleSave();
  }

  /**
   * Delete a record
   */
  delete(notePath: string): void {
    if (this.disposed) return;

    for (const [topic, records] of this.topics) {
      if (records.delete(notePath)) {
        this.dirtyTopics.add(topic);
      }
    }

    this.scheduleSave();
  }

  /**
   * Flush all dirty topics to disk
   */
  async flush(): Promise<void> {
    if (this.dirtyTopics.size === 0 || this.disposed) return;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const topicsToSave = Array.from(this.dirtyTopics);
    this.dirtyTopics.clear();

    for (const topic of topicsToSave) {
      await this.saveTopicFile(topic);
    }

    await this.saveMetaFile();
  }

  /**
   * Export a topic to a file (for backup)
   */
  async exportTopic(topic: string, outputPath: string): Promise<void> {
    const records = this.topics.get(topic);
    if (!records) {
      throw new Error(`Topic not found: ${topic}`);
    }

    const data: IntelligenceTopicFile = {
      version: INTELLIGENCE_VERSION,
      topic,
      criteria: { tags: [topic] },
      records: Object.fromEntries(records),
      noteCount: records.size,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(outputPath, JSON.stringify(data, null, 2));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.topics.clear();
  }

  // ============ Private Methods ============

  private getTopicForNote(notePath: string, noteTags: string[]): string {
    if (noteTags.length === 0) {
      return '_uncategorized';
    }

    // Use first tag as topic
    const primaryTag = noteTags[0]
      .replace(/^#/, '')
      .split('/')[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');

    return primaryTag || '_uncategorized';
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 2000);
  }

  private async saveTopicFile(topic: string): Promise<void> {
    const records = this.topics.get(topic);
    if (!records) return;

    const filePath = this.storagePaths.getIntelligenceTopicPath(topic);

    const data: IntelligenceTopicFile = {
      version: INTELLIGENCE_VERSION,
      topic,
      criteria: { tags: [topic] },
      records: Object.fromEntries(records),
      noteCount: records.size,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  private async saveMetaFile(): Promise<void> {
    const metaPath = this.storagePaths.intelligenceMeta;

    let totalRecords = 0;
    for (const records of this.topics.values()) {
      totalRecords += records.size;
    }

    const meta: IntelligenceMeta = {
      version: INTELLIGENCE_VERSION,
      topics: Array.from(this.topics.keys()),
      totalNotes: totalRecords,  // Assuming 1 record per note
      totalRecords,
      lastUpdated: Date.now(),
    };

    await atomicWriteFile(metaPath, JSON.stringify(meta, null, 2));
  }
}
```

### Step 3: Update NoteIntelligenceService

Modify `noteIntelligence.ts` to pass tags when upserting:

```typescript
// In processNote():

// Get tags from metadata
const metadata = this.kernel.obsidian.getMetadataByPath(notePath);
const tags = metadata?.tags ?? [];

// Existing record building...
const record: IntelligenceRecord = { ... };

// Pass tags to upsert
this.db.upsert(notePath, record, tags);
```

Also update constructor - no longer needs modelKey:

```typescript
async initialize(): Promise<void> {
  if (this.disposed) return;

  // No longer model-keyed!
  this.db = new IntelligenceDb(this.kernel.storagePaths);
  await this.db.load();

  // ... rest of initialization
}
```

### Step 4: Migration Logic

Add to `IntelligenceDb.load()`:

```typescript
async load(): Promise<void> {
  // Check for legacy file first
  const legacyPattern = /^intelligence-.*\.json$/;
  const pluginRoot = path.dirname(this.storagePaths.intelligenceTopics);
  const pluginRootParent = path.dirname(pluginRoot);

  try {
    const files = await fs.promises.readdir(pluginRootParent);
    const legacyFile = files.find(f => legacyPattern.test(f));

    if (legacyFile && !this.hasNewStructure()) {
      console.log('[IntelligenceDb] Migrating legacy intelligence file...');
      await this.migrateLegacyFile(path.join(pluginRootParent, legacyFile));
    }
  } catch {
    // Ignore
  }

  // ... rest of load
}

private hasNewStructure(): boolean {
  return fs.existsSync(this.storagePaths.intelligenceTopics);
}

private async migrateLegacyFile(legacyPath: string): Promise<void> {
  try {
    const content = await fs.promises.readFile(legacyPath, 'utf-8');
    const legacy = JSON.parse(content);

    // Ensure directories
    await fs.promises.mkdir(this.storagePaths.intelligenceTopics, { recursive: true });

    // Group records by topic
    for (const [notePath, record] of Object.entries(legacy.records ?? {})) {
      const rec = record as IntelligenceRecord;

      // Get tags from record or use empty
      const tags = rec.suggestedTags?.map(t => t.tag) ?? [];
      const topic = this.getTopicForNote(notePath, tags);

      if (!this.topics.has(topic)) {
        this.topics.set(topic, new Map());
      }
      this.topics.get(topic)!.set(notePath, rec);
      this.dirtyTopics.add(topic);
    }

    // Save all topics
    await this.flush();

    // Move legacy file to _deleted
    const deletedPath = path.join(
      this.storagePaths.tempDeleted,
      `intelligence-legacy-${Date.now()}.json`
    );
    await fs.promises.rename(legacyPath, deletedPath);

    console.log(`[IntelligenceDb] Migration complete: ${this.topics.size} topics created`);
  } catch (error) {
    console.error('[IntelligenceDb] Migration failed:', error);
  }
}
```

### Step 5: Add Export Command (Optional Enhancement)

Add method to export all intelligence for backup:

```typescript
/**
 * Export all intelligence to a single backup file
 */
async exportAll(outputPath: string): Promise<void> {
  const allRecords: Record<string, IntelligenceRecord> = {};

  for (const records of this.topics.values()) {
    for (const [notePath, record] of records) {
      allRecords[notePath] = record;
    }
  }

  const backup = {
    version: INTELLIGENCE_VERSION,
    exportedAt: Date.now(),
    topics: Array.from(this.topics.keys()),
    records: allRecords,
  };

  await atomicWriteFile(outputPath, JSON.stringify(backup, null, 2));
}
```

## Verification

### 1. Build Check
```bash
bun run typecheck
bun run build
bun run dev  # Test in Obsidian
```

### 2. Migration Test

1. Start with existing `intelligence-*.json` file
2. Load plugin
3. Verify:
   - `data/intelligence/topics/` created
   - Topic files created based on record tags
   - Legacy file moved to `_deleted/`
   - `meta.json` created

### 3. Functionality Test

1. Open a note with tag `#research`
2. Trigger intelligence regeneration (via Quick Action)
3. Verify record saved to `intelligence/topics/research.json`

4. Open a note without tags
5. Trigger regeneration
6. Verify record saved to `_uncategorized.json`

### 4. Topic Verification

```typescript
// In console or test:
const db = kernel.getService('intelligenceDb');
console.log(db.getTopics());  // Should list all topics
console.log(db.getTopicRecords('research'));  // Should list research records
```

## Commit Message

```
refactor(intelligence): Implement tag-based sharding

- Replace single model-keyed file with topic-keyed files
- Add topic assignment based on note tags
- Add migration for legacy intelligence file
- Add export capability for backup
- Intelligence is now vault-centric, not model-centric

Part of storage restructure Phase 3.
```

## Next Phase

After this phase is complete, proceed to Phase 4 (Conversations Per-Note + Rollups).
