# Archie - Phase 3: Intelligence Tag-Based Sharding

> **Status**: COMPLETE
> **Assigned**: 2026-01-10
> **Branch**: `archie/backend-fixes`
> **Spec**: `planning/coding_tasks/03-intelligence-tag-sharding.md`

---

## Objective

Reorganize intelligence storage from model-keyed single file to tag-keyed multiple files. This enables:
- Semantic organization by topic (matches how users think)
- Exportable knowledge bundles
- Keep forever philosophy (intelligence = learned knowledge)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/intelligence/types.ts` | Add IntelligenceTopicFile, IntelligenceMeta types |
| `src/core/intelligence/intelligenceDb.ts` | Rewrite for tag-based sharding |
| `src/core/intelligence/noteIntelligence.ts` | Update to pass tags to upsert |

---

## Implementation Steps

### 1. Add Types (`types.ts`)

```typescript
export interface IntelligenceTopicFile {
  version: number;
  topic: string;
  criteria: { tags: string[] };
  records: Record<string, IntelligenceRecord>;
  noteCount: number;
  lastUpdated: number;
}

export interface IntelligenceMeta {
  version: number;
  topics: string[];
  totalNotes: number;
  totalRecords: number;
  lastUpdated: number;
}
```

### 2. Rewrite IntelligenceDb

- Replace single-file with multi-file topic management
- Use `storagePaths.getIntelligenceTopicPath(topic)` from Phase 1
- Key methods:
  - `load()` - Load all topic files
  - `get(notePath)` - Search all topics for a note
  - `upsert(notePath, record, noteTags)` - Determine topic from tags
  - `delete(notePath)` - Remove from all topics
  - `flush()` - Save dirty topics

### 3. Topic Assignment Logic

```typescript
function getTopicForNote(notePath: string, noteTags: string[]): string {
  if (noteTags.length === 0) return '_uncategorized';

  const primaryTag = noteTags[0]
    .replace(/^#/, '')
    .split('/')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');

  return primaryTag || '_uncategorized';
}
```

### 4. Update NoteIntelligenceService

- Pass tags when upserting: `this.db.upsert(notePath, record, tags)`
- Remove model-key dependency from initialization

### 5. Migration Logic

- Detect legacy `intelligence-*.json` file
- Group records by topic based on suggestedTags
- Write topic files to `data/intelligence/topics/`
- Move legacy file to `_deleted/`

---

## Use Phase 1 Path Methods

```typescript
storagePaths.intelligenceTopics      // Directory for topic files
storagePaths.intelligenceMeta        // meta.json path
storagePaths.getIntelligenceTopicPath(topic)  // {topic}.json path
storagePaths.tempDeleted             // For archived legacy file
```

---

## Verification

```bash
bun run typecheck && bun run build
```

### Manual Test
1. Start with existing `intelligence-*.json` file
2. Load plugin → migration should run
3. Verify `data/intelligence/topics/` created
4. Test note intelligence generation writes to correct topic file

---

## Report

When complete, update `planning/orchestration/archie/REPORT.md` with:
- Files modified (with line ranges)
- New methods/classes added
- Migration approach
- Build verification results
