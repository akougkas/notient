# Archie - Phase 3 Report

> **Status**: COMPLETE
> **Last Updated**: 2026-01-10
> **Branch**: `archie/backend-fixes`

---

## Summary

Phase 3 implements tag-based intelligence sharding, reorganizing storage from a single model-keyed file (`intelligence-{modelKey}.json`) to multiple topic-keyed files (`data/intelligence/topics/{topic}.json`). Intelligence is now vault-centric rather than model-centric, enabling semantic organization by topic and exportable knowledge bundles.

---

## Files Modified

| File | Lines Changed | Key Changes |
|------|---------------|-------------|
| `src/core/intelligence/types.ts:79-104` | +26 | Added `IntelligenceTopicFile`, `IntelligenceMeta` types |
| `src/core/intelligence/intelligenceDb.ts:1-384` | Complete rewrite | Multi-file topic management, migration logic |
| `src/core/intelligence/noteIntelligence.ts:48-226` | +15/-12 | Updated initialization, pass tags to upsert |

---

## New Types (`types.ts:79-104`)

```typescript
IntelligenceTopicFile   // Topic file structure (per topic/*.json)
IntelligenceMeta        // Meta file structure (meta.json)
```

---

## Rewritten Class: IntelligenceDb (`intelligenceDb.ts`)

### Data Structure

```typescript
// Map: topic -> (Map: notePath -> record)
private topics: Map<string, Map<string, IntelligenceRecord>>
private dirtyTopics: Set<string>
```

### Public Methods

| Method | Line | Purpose |
|--------|------|---------|
| `load()` | 41-78 | Load all topic files (with legacy migration) |
| `get(notePath)` | 84-90 | Search all topics for a note record |
| `getAll()` | 95-101 | Get all records across all topics |
| `getTopicRecords(topic)` | 106-109 | Get records for a specific topic |
| `getTopics()` | 114-116 | Get all topic names |
| `upsert(notePath, record, noteTags)` | 121-142 | Add/update record (routes to correct topic) |
| `delete(notePath)` | 147-157 | Remove record from all topics |
| `flush()` | 162-178 | Save dirty topics to disk |
| `exportTopic(topic, outputPath)` | 183-198 | Export single topic for backup |
| `exportAll(outputPath)` | 203-221 | Export all intelligence to backup |
| `dispose()` | 223-231 | Cleanup |

### Private Methods

| Method | Line | Purpose |
|--------|------|---------|
| `getTopicForNote(notePath, noteTags)` | 239-252 | Determine topic from tags (first tag's root) |
| `scheduleSave()` | 254-260 | Debounced save (2s) |
| `saveTopicFile(topic)` | 262-291 | Save single topic file |
| `saveMetaFile()` | 293-311 | Save meta.json with topic list |
| `checkAndMigrateLegacy()` | 319-338 | Check for and trigger migration |
| `hasNewStructure()` | 340-342 | Check if topics dir exists |
| `migrateLegacyFile(legacyPath)` | 344-383 | Migrate legacy file to topic structure |

---

## NoteIntelligenceService Updates (`noteIntelligence.ts`)

### Changes

1. **Constructor simplified** (lines 48-53):
   - No longer requires `modelKey` from Ollama service
   - Creates `IntelligenceDb(storagePaths)` instead of `(pluginRoot, modelKey)`

2. **processNote() updated** (lines 181-226):
   - Extracts `noteTags` once for consistency
   - Passes tags to `db.upsert(notePath, record, noteTags)`
   - Uses `"unknown"` for modelKey field if indexManager unavailable

---

## Topic Assignment Logic

```typescript
getTopicForNote(notePath, noteTags): string {
  if (noteTags.length === 0) return "_uncategorized";

  return noteTags[0]
    .replace(/^#/, '')        // Remove leading #
    .split('/')[0]            // First part of nested tag
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');  // Sanitize
}
```

**Examples**:
- `#research` → `research.json`
- `#project/iowarp` → `project.json`
- `#AI/machine-learning` → `ai.json`
- (no tags) → `_uncategorized.json`

---

## Migration Approach

1. **Detection**: `load()` checks `hasNewStructure()` first
2. **Legacy search**: If no new structure, scans plugin root for `intelligence-*.json`
3. **Migration steps**:
   - Parse legacy file as `IntelligenceFile`
   - Group records by topic using `suggestedTags[].tag`
   - Write topic files to `data/intelligence/topics/`
   - Write meta.json to `data/intelligence/`
   - Move legacy file to `data/_operational/temp/_deleted/`
4. **One-way**: Legacy file preserved in `_deleted` for safety

---

## Verification Results

### Build
- [x] `bun run typecheck` passes (no errors)
- [x] `bun run build` passes (551.0KB main.js)

### Code Quality
- [x] No TypeScript errors
- [x] Uses Phase 1 path methods (`storagePaths.intelligenceTopics`, etc.)
- [x] Backward compatible with legacy storage (migrates on first load)

---

## Blockers

None.

---

## Notes

1. **No model dependency** - Intelligence is now vault-centric. The `modelKey` field in records is still populated for metadata but doesn't affect storage location.

2. **Topic routing is deterministic** - Same tags always produce same topic. Notes move between topics when tags change.

3. **Empty topics cleaned up** - When last record is deleted from a topic, the file is removed.

4. **Export capability** - Added `exportTopic()` and `exportAll()` for backup/portability.

---

## Previous Phases

### Phase 2: Chunk/Embedding Separation (COMPLETE)
Implemented separated storage for chunks (model-agnostic) and embeddings (model-specific).

### Phase 1: Storage Path Infrastructure (COMPLETE)
Established path infrastructure for hierarchical storage with 45+ path constants.

---

## Next Recommended Action

Proceed to Phase 4: Conversations Per-Note + Rollups.
