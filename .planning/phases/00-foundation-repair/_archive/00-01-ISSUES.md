# UAT Issues: Phase 0 Plan 1

**Tested:** 2026-01-11
**Source:** .planning/phases/00-foundation-repair/00-01-SUMMARY.md
**Tester:** User via /gsd:verify-work

## Open Issues

### UAT-001: HNSWVectorStore loadFromDataAsync takes 36 seconds

**Discovered:** 2026-01-11
**Phase/Plan:** 00-01
**Severity:** Blocker
**Feature:** Startup performance
**Description:** The 00-01 fixes targeted the wrong bottleneck. ChunkStore now loads in 243ms (fixed), but HNSWVectorStore.loadFromDataAsync takes 36,651ms (36 seconds). The real blocking issue is WASM/IDBFS sync operations.
**Expected:** Plugin loads in <3 seconds total
**Actual:** Plugin takes 36+ seconds, UI frozen during HNSW index loading
**Repro:**
1. Reload plugin in Obsidian
2. Watch console logs
3. Note: `[ChunkStore] Loaded 29050 chunks from 542 notes in 243ms` (fast)
4. Note: `[IndexManager] Initialized: 471 notes in 36651ms` (36s - problem)

**Root Cause Evidence:**
```
warning: 2 FS.syncfs operations in flight at once, probably just doing extra work
```

Multiple IDBFS sync operations are happening, and the WASM HNSW loading blocks the main thread.

**Files to investigate:**
- `src/services/hnswVectorStore.ts:loadFromDataAsync()` - takes 36s
- `EmscriptenFileSystemManager.syncFS()` - race conditions
- Native HNSW WASM index loading

### UAT-002: Quick Actions require double-click to trigger

**Discovered:** 2026-01-11
**Phase/Plan:** 00-01
**Severity:** Major
**Feature:** Agent triggers
**Description:** First click on Quick Action (e.g., Classify) does nothing. Second click triggers the agent.
**Expected:** Single click triggers agent immediately
**Actual:** First click is ignored, second click works
**Repro:**
1. Open a note
2. Click "Classify" Quick Action
3. Nothing happens
4. Click again
5. Agent triggers

### UAT-003: UI crashes after agent triggers

**Discovered:** 2026-01-11
**Phase/Plan:** 00-01
**Severity:** Blocker
**Feature:** Agent execution
**Description:** After agent finally triggers (on second click), the entire Obsidian UI crashes/becomes unresponsive.
**Expected:** Agent runs in background, UI stays responsive
**Actual:** Whole application crashes
**Repro:**
1. Click Classify twice to trigger agent
2. Observe system becoming unresponsive
3. UI crashes

## Resolved Issues

[None yet]

---

*Phase: 00-foundation-repair*
*Plan: 01*
*Tested: 2026-01-11*
