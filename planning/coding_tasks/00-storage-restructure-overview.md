# Storage Restructure - Implementation Overview

## Project Context

**Notient** is an Obsidian plugin providing AI-powered vault management using local LLMs only. This restructure addresses storage inefficiencies identified in a comprehensive audit.

## Problem Statement

Current storage has several issues:
- 316MB single JSON index file blocks startup
- Intelligence keyed by embedding model (wrong scope)
- Conversations in single file (poor scaling)
- Actions flat list with full content undo (bloated)
- No separation between model-agnostic chunks and model-specific embeddings

## Target Architecture

```
.obsidian/plugins/notient/
├── main.js, manifest.json, styles.css  # Core (Obsidian-required)
├── data.json                           # Settings ONLY
│
└── data/                               # All plugin data
    ├── chunks/                         # MODEL-AGNOSTIC chunk content
    │   ├── meta.json
    │   └── notes/{noteId}.json
    │
    ├── embeddings/                     # MODEL-SCOPED vectors
    │   ├── active/{modelKey}-{dim}d.json
    │   ├── _rebuilding/
    │   └── _archived/
    │
    ├── intelligence/                   # TAG-KEYED learning
    │   ├── meta.json
    │   └── topics/{tag}.json
    │
    ├── conversations/                  # PER-NOTE + ROLLUPS
    │   ├── notes/{noteId}.json
    │   ├── rollups/{para-folder}.json
    │   └── _root.json
    │
    ├── actions/                        # TIME-BUCKETED
    │   ├── hot/current.json
    │   └── archive/{YYYY-MM}.json
    │
    ├── profile/profile.json
    │
    └── _operational/                   # Volatile
        ├── locks/, cache/, temp/, logs/
```

## Phase Breakdown

| Phase | Focus | Files | Risk |
|-------|-------|-------|------|
| 1 | Storage paths + directory structure | `storagePaths.ts`, `constants.ts` | Low |
| 2 | Chunk/embedding separation | `indexManager.ts`, `simpleVectorStore.ts`, `simpleIndexer.ts` | Medium |
| 3 | Intelligence tag-based sharding | `intelligenceDb.ts`, `noteIntelligence.ts` | Medium |
| 4 | Conversations per-note + rollups | `conversationStore.ts` | Medium |
| 5 | Actions time-bucketed + diff undo | `actionHistory.ts` | Medium |

## Key Decisions (Locked)

1. **Intelligence sharding**: By tag (each unique tag gets own file)
2. **Chunk/embedding separation**: Yes (enables model flexibility)
3. **Binary format**: Deferred (keep JSON for now)
4. **Conversation rollups**: On-demand only
5. **Reasoning traces**: Inline on action records (summarized)
6. **Retention**: Keep forever via archival (never truly delete)

## Implementation Rules

1. **Extend existing files** - Don't create new files unless absolutely necessary
2. **Use `storagePaths.ts`** - Never hardcode paths
3. **Atomic writes** - Use `atomicWriteFile()` for all persistence
4. **Migration support** - Detect old structure, migrate automatically
5. **Preserve TSI v2** - Tiered chunk hierarchy is foundational

## Verification Strategy

Each phase includes:
1. Unit-level verification (function behavior)
2. Integration verification (data flows correctly)
3. Migration verification (old data migrates cleanly)
4. Build verification (`bun run build` passes and `bun run dev` runs without errors)

## Session Workflow

Each phase prompt is designed for a single Claude session:
1. Read the phase prompt
2. Read referenced source files
3. Implement changes
4. Run verification steps
5. Commit with descriptive message

## Reference Materials

- **CLAUDE.md**: Complete code map and architecture
- **TSI v2**: Tiered Semantic Index documentation in CLAUDE.md
- **Current source**: See file paths in each phase prompt
