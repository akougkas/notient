# Archie - Phase 2 Report

> **Status**: COMPLETE
> **Last Updated**: 2026-01-10
> **Branch**: `archie/backend-fixes`

---

## Summary

Phase 2 implements chunk/embedding separation, enabling model switching without re-chunking. Added `ChunkStore` class for model-agnostic chunk storage, updated `IndexManager` to coordinate both stores, and modified `SimpleIndexer` to write chunks and embeddings separately. Legacy index migration logic handles the transition from single-file to separated storage.

---

## Files Modified

| File | Lines Changed | Key Changes |
|------|---------------|-------------|
| `src/types/indexer.ts:121-194` | +74 | New types: `StoredChunk`, `NoteChunkFile`, `ChunksMeta`, `EmbeddingIndex` |
| `src/services/simpleVectorStore.ts:14-277` | +175 | Added imports, `ChunkStore` class (170 LOC) |
| `src/services/indexManager.ts:19-1316` | +265 | Added imports, `chunkStore` member, Phase 2 methods, migration logic |
| `src/core/indexer/simpleIndexer.ts:389-446` | +23/-11 | Updated `processNote()` to use separated storage |

---

## New Types (`types/indexer.ts:121-194`)

```typescript
StoredChunk         // Chunk content without embedding (model-agnostic)
NoteChunkFile       // Per-note chunk file structure
ChunksMeta          // Chunks meta file structure
EmbeddingIndex      // Embedding index structure (model-specific)
```

---

## New Classes/Methods

### ChunkStore (`simpleVectorStore.ts:111-276`)

| Method | Line | Purpose |
|--------|------|---------|
| `loadNoteChunks(noteId)` | 121-139 | Load chunks for specific note from disk |
| `saveNoteChunks(...)` | 145-173 | Save chunks for note to disk (atomic) |
| `getChunk(chunkId)` | 178-180 | Get chunk by ID from memory |
| `getChunksForNote(noteId)` | 185-192 | Get all chunks for a note |
| `removeNoteChunks(noteId)` | 197-218 | Remove chunks, move file to `_deleted` |
| `loadAll()` | 223-239 | Load all chunks at startup |
| `getAllChunkIds()` | 244-246 | Get all chunk IDs |
| `getNoteCount()` | 251-253 | Count notes with chunks |
| `getChunkCount()` | 258-260 | Total chunk count |
| `hasNoteChunks(noteId)` | 265-267 | Check if note has chunks |
| `clear()` | 272-276 | Clear all from memory |

### IndexManager Updates (`indexManager.ts:1063-1316`)

| Method | Line | Purpose |
|--------|------|---------|
| `getChunkStore()` | 1065-1068 | Access ChunkStore instance |
| `isUsingNewStructure()` | 1070-1073 | Check if using separated storage |
| `indexNoteSeparated(...)` | 1079-1108 | Index with separated chunk/embedding storage |
| `toStoredChunk(chunk)` | 1111-1131 | Convert NoteChunk to StoredChunk |
| `removeNoteSeparated(...)` | 1136-1150 | Remove from both stores |
| `hasLegacyIndex()` | 1154-1162 | Check for legacy idx_*.json files |
| `findLegacyIndex()` | 1165-1190 | Find best legacy index for migration |
| `migrateLegacyIndex()` | 1192-1316 | Migrate single-file to separated structure |

### SimpleIndexer Updates (`simpleIndexer.ts:389-446`)

- Updated `processNote()` to check `indexManager.isUsingNewStructure()`
- When enabled, calls `removeNoteSeparated()` then `indexNoteSeparated()`
- Falls back to legacy `removeNote()` + `addChunks()` otherwise

---

## Migration Approach

1. **Detection**: `initialize()` checks `hasNewStructure()` and `hasLegacyIndex()`
2. **Load chunks first**: If new structure exists, loads chunks immediately
3. **Auto-migrate**: If legacy index found but no new structure, runs migration
4. **Migration steps**:
   - Read legacy `idx_*.json` file
   - Group docs by `noteId`
   - Write per-note chunk files to `data/chunks/notes/`
   - Move legacy file to `data/embeddings/_archived/`
5. **Backward compatible**: Legacy path still works if new structure not enabled

---

## Verification Results

### Build
- [x] `bun run typecheck` passes (no errors)
- [x] `bun run build` passes (549.9KB main.js)

### Code Quality
- [x] No TypeScript errors
- [x] Imports properly added
- [x] Backward compatible with legacy storage

---

## Blockers

None.

---

## Notes for Sage's Review

1. **ChunkStore is minimal** - Just load/save/remove per-note JSON files. Could potentially merge into IndexManager but separation keeps concerns clear.

2. **Migration is one-way** - Once migrated, old file moves to `_archived`. No rollback path implemented.

3. **SimpleVectorStore unchanged** - Still stores full docs in memory. A future optimization could make it reference ChunkStore for content during search, reducing memory if needed.

4. **`useNewStructure` flag** - Controls which code path runs. Set based on `hasNewStructure()` check at startup.

---

## Previous Phase

### Phase 1: Storage Path Infrastructure (COMPLETE)

Established path infrastructure for hierarchical storage. Added 45+ path constants, extended `StoragePaths` class with dynamic path builders, migration detection methods, and directory creation helpers.

---

## Next Recommended Action

Proceed to Phase 3: Intelligence Tag-Based Sharding.
