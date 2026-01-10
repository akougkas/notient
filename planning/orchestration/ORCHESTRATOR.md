# Notient Implementation - Orchestrator State

> **Last Updated**: 2026-01-10
> **Orchestrator**: Claude (Opus)
> **Agents**: Archie (Implementer), Sage (Simplifier)

---

## Agent Roles

### Archie - Senior Engineer
- **Style**: Brute force, enthusiastic, always correct
- **Weakness**: Over-engineers, verbose code
- **Job**: Implement features per spec

### Sage - Code Simplifier
- **Style**: Refined, minimalist, clarity-focused
- **Tool**: `/code-simplifier` skill
- **Job**: Review and simplify Archie's work before next phase

---

## Workflow

```
┌──────────────────────────────────────────────────────────────┐
│  Phase N                                                      │
│                                                               │
│  1. Archie implements ──→ 2. Sage simplifies ──→ 3. Verified │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         Phase N+1
```

---

## Active Track: Storage Restructure

| Phase | Name | Archie | Sage | Status |
|-------|------|--------|------|--------|
| 1 | Storage Paths | **DONE** | **DONE** | Complete |
| 2 | Chunk/Embedding Separation | **DONE** | **DONE** | Complete |
| 3 | Intelligence Tag Sharding | **DONE** | **DONE** | Complete |
| 4 | Conversations Per-Note | **DONE** | **ACTIVE** | Sage reviewing |
| 5 | Actions Time-Bucketed | **ACTIVE** | PENDING | Archie implementing |

---

## Current State

### Phase 1: Storage Paths - COMPLETE
- **Archie**: DONE - 45+ path constants, 10 helper methods
- **Sage**: DONE - Manual simplification by Orchestrator

### Phase 2: Chunk/Embedding Separation - REVIEW
- **Archie**: DONE - ChunkStore class, IndexManager coordination, migration logic
- **Sage**: ACTIVE - Reviewing for simplification opportunities
- **Files Modified**:
  - `src/types/indexer.ts:121-194` (+74 lines)
  - `src/services/simpleVectorStore.ts:14-277` (+175 lines)
  - `src/services/indexManager.ts:19-1316` (+265 lines)
  - `src/core/indexer/simpleIndexer.ts:389-446` (+23/-11 lines)

### Phase 3: Intelligence Tag Sharding - ACTIVE
- **Archie**: IMPLEMENTING
- **Sage**: Waiting for Archie
- **Files**: `types.ts`, `intelligenceDb.ts`, `noteIntelligence.ts`

### Bonus: Build System - COMPLETE
- Updated `scripts/build.ts` with Phase 1/2 awareness
- New commands: `dev:reset`, `dev:hard-reset`, `dev:status`
- Statusline fix (`~/.claude/statusline.sh` v5)

---

## Parallel Execution

```
Phase 2 Review (Sage)     ───────────────────────▶ Complete
                         ╲
                          ╲ (parallel)
                           ╲
Phase 3 Implement (Archie) ───────────────────────▶ Complete
```

---

## Task Reference

| File | Phase | Status |
|------|-------|--------|
| `01-storage-paths-restructure.md` | 1 | Archie DONE, Sage DONE |
| `02-chunk-embedding-separation.md` | 2 | Archie DONE, Sage ACTIVE |
| `03-intelligence-tag-sharding.md` | 3 | Archie ACTIVE, Sage PENDING |
| `04-conversations-per-note.md` | 4 | Queued |
| `05-actions-time-bucketed.md` | 5 | Queued |

---

## Completed Work

### Phase 1: Storage Paths
- **Archie**: 45+ path constants, ensureNewDirectories(), dynamic path builders
- **Sage**: Verified minimal, no changes needed
- **Branch**: `archie/backend-fixes`

### Phase 2: Chunk/Embedding Separation
- **Archie**:
  - New types: `StoredChunk`, `NoteChunkFile`, `ChunksMeta`, `EmbeddingIndex`
  - `ChunkStore` class for model-agnostic chunk storage
  - `IndexManager` methods: `indexNoteSeparated()`, `removeNoteSeparated()`, migration
  - `SimpleIndexer` updated for dual-path (legacy vs new structure)
  - Migration: Legacy `idx_*.json` → `data/chunks/notes/` + archive
- **Branch**: `archie/backend-fixes`

### Build System Updates
- Professional logging with colors
- `bun run dev:status` - Shows storage structure
- `bun run dev:clean` - Legacy clean (preserves data/)
- `bun run dev:reset` - Soft reset (settings + operational)
- `bun run dev:hard-reset` - Full wipe
- Banner includes Phase 2 storage info

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-10 | Sequential: Archie → Sage → Next | Sage simplifies before moving on |
| 2026-01-10 | Parallel Phase 2 review + Phase 3 impl | Speed up delivery |
| 2026-01-10 | Sage uses `/code-simplifier` skill | Anthropic's built-in simplification agent |

---

## Future Track: ALPHA-SPEC

After Storage Restructure completes, proceed to UI/UX work in `planning/ALPHA-SPEC.md`.

---

## Communication Protocol

1. **Archie implements** → writes to `archie/REPORT.md`
2. **Orchestrator reviews** → assigns Sage
3. **Sage simplifies** → writes to `sage/REPORT.md`
4. **Orchestrator verifies** → advances to next phase
