# Notient Indexing System Revamp

## Mission

Fix the indexing system once and for all. The current implementation is overcomplicated, fragile, and doesn't behave as intended.

## Context

The user has attempted multiple times to get simple, reliable index management working. Each session introduces new bugs, regressions, or misunderstandings about the intended behavior.

## Current Pain Points

1. **Recovery is too aggressive** - Partial indices trigger crash/recovery mode instead of graceful handling
2. **Index discovery is unreliable** - Different indices generated on each session, doesn't attach to existing valid indices
3. **Overcomplicated state management** - State files, lock files, multiple formats causing confusion
4. **Double initialization** - Services initializing twice
5. **Stale locks** - Previous sessions leave locks that block new sessions

## User's Intended Behavior (Verbatim)

> "Any session, any previous thing, even if it was indexing partially or fully, it just generates different indices. When you reboot, you just attach to the latest or to the valid or depending on the settings, and if there is any conflict, you just raise the flag to the user in a nice silent way."

## Required Operations (7 Total)

1. **Rescan** - Check vault for changes, queue new/modified notes
2. **Rebuild** - Full reindex from scratch
3. **Expand** - Add new notes to existing index
4. **Trim** - Remove stale entries for deleted notes
5. **Import** - Load index from backup file
6. **Export** - Save index to backup file
7. **Delete** - Remove an index

## Design Principles

1. **Simple JSON files** - Indices are just JSON files in `.obsidian/plugins/notient/`
2. **Specific naming** - Clear, parseable filename schema
3. **Graceful degradation** - Partial indices work, conflicts are warnings not blockers
4. **No aggressive recovery** - Let user decide what to do
5. **Attach to existing** - On startup, find and use the best matching index

## Key Files to Review

```
src/services/indexManager.ts      # Index state and operations
src/services/simpleVectorStore.ts # Vector storage and persistence
src/core/indexer/simpleIndexer.ts # Indexing orchestration
src/services/vaultLock.ts         # Multi-window locking
src/ui/settings/panels/IndexManagementPanel.ts # UI for index management
src/main.ts                       # Initialization flow (search for vectorStore, indexManager)
```

## Session Instructions

1. **Start with /interview** - Use the interview-conductor skill to deeply understand the user's mental model of how indexing should work
2. **Review current implementation** - Read the key files above
3. **Identify gaps** - Compare current behavior vs intended behavior
4. **Propose simplified design** - Get user approval before coding
5. **Implement incrementally** - Test each change before moving on
6. **No over-engineering** - Keep it simple, keep it working

## Questions to Explore in Interview

- What should happen on first launch with no index?
- What should happen on launch with a partial index?
- What should happen when embedding model changes?
- How should conflicts be surfaced to the user?
- What's the expected index file lifecycle?
- How should settings control index behavior?
- What's the minimal viable index management UI?

## Success Criteria

- [ ] Fresh install creates index without issues
- [ ] Restart attaches to existing index seamlessly
- [ ] Partial index doesn't trigger recovery mode
- [ ] Model change is handled gracefully (not crash)
- [ ] All 7 operations work from settings panel
- [ ] No double initialization
- [ ] No stale lock issues
- [ ] Simple, understandable code
