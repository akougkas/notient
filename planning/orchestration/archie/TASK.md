# Archie - Phase 2: Chunk/Embedding Separation

> **Status**: COMPLETE
> **Assigned**: 2026-01-10
> **Completed**: 2026-01-10
> **Branch**: `archie/backend-fixes`
> **Spec**: `planning/coding_tasks/02-chunk-embedding-separation.md`

---

## Objective

Separate model-agnostic chunk content from model-specific embeddings. This enables:
- Model switching without re-chunking
- Background embedding loading (faster startup)
- Chunk structure preserved across model changes

---

## Files to Modify

| File | What to Do |
|------|------------|
| `src/types/indexer.ts` | Add `StoredChunk`, `NoteChunkFile`, `ChunksMeta`, `EmbeddingIndex` types |
| `src/services/simpleVectorStore.ts` | Add `ChunkStore` class, modify `SimpleVectorStore` to reference it |
| `src/services/indexManager.ts` | Coordinate ChunkStore and VectorStore |
| `src/core/indexer/simpleIndexer.ts` | Write chunks and embeddings separately |

---

## Prerequisites

- [x] Phase 1 completed (storage paths updated)
- [x] Read `/.claude/CLAUDE.md` for TSI v2 architecture
- [x] Read `planning/coding_tasks/00-storage-restructure-overview.md`

---

## Deliverables

1. New types in `types/indexer.ts`
2. `ChunkStore` class managing per-note chunk files
3. Modified `SimpleVectorStore` storing embeddings only
4. Updated `IndexManager` coordinating both stores
5. Migration logic for legacy `idx_*.json` files
6. Verification: `bun run typecheck && bun run build` passes

---

## Reporting

When complete, update `REPORT.md` with:
- Files modified (with line ranges)
- New methods/classes added
- Migration logic summary
- Verification results
- Notes for Sage's simplification review

