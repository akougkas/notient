# Deferred Issues

Issues discovered during development that are out of scope for current phase.

---

## ISSUE-001: IndexManager fails to save large indices

**Discovered:** 2026-01-11 (Phase 1, Plan 03 testing)
**Severity:** Critical
**Component:** IndexManager / JSON serialization

### Symptom
```
[IndexManager] Failed to save index: RangeError: Invalid string length
    at JSON.stringify (<anonymous>)
    at _IndexManager.saveIndex
```

### Context
- Vault has 895 notes, 24917 chunks
- Index file grows during sync (was 22313 docs, adding 424 more)
- JavaScript has maximum string length limit (~512MB in V8)
- JSON.stringify fails when serialized output exceeds this limit

### Impact
- Index saves fail during vault sync
- Progress may be lost on restart
- Incomplete index state (471/895 notes)

### Potential Fixes
1. **Chunked JSON writing:** Write index in chunks using streaming JSON
2. **Split index files:** Store chunks separately from HNSW graph
3. **Binary format:** Use MessagePack or CBOR instead of JSON
4. **Compression:** Compress before save (but still hits memory limit during stringify)

### Priority
High - Blocks indexing completion for large vaults

---

## ISSUE-002: IntelligenceDb null reference in getTopicForNote

**Discovered:** 2026-01-11 (Phase 1, Plan 03 testing)
**Severity:** Medium
**Component:** IntelligenceDb / NoteIntelligenceService

### Symptom
```
Uncaught (in promise) TypeError: Cannot read properties of null (reading 'replace')
    at IntelligenceDb.getTopicForNote (plugin:notient:19624:36)
    at IntelligenceDb.upsert
    at NoteIntelligenceService.processNote
```

### Context
- Occurs during `enqueueStaleFromIndex` processing
- `getTopicForNote` receives null for a path parameter
- Called from background intelligence processing queue

### Impact
- Silent failure for some notes
- Intelligence records may not be generated
- Does not crash the UI (caught in promise)

### Potential Fixes
1. Add null guard in `getTopicForNote`
2. Validate note path before enqueueing to intelligence service
3. Trace why null path is being passed (deleted note? race condition?)

### Priority
Medium - Causes silent failures but doesn't block UI

---

## ISSUE-003: Slow initialization and indexing

**Discovered:** 2026-01-11 (Phase 1, Plan 03 testing)
**Severity:** Medium
**Component:** Startup / SimpleIndexer

### Symptom
User reports:
- "Heavy initialization protocols, indexing protocols and reindexing protocols"
- "Prevents me to start agents because the index hasn't been completed"
- "Makes me wait and wait and wait"

### Context
- 895 note vault
- Incomplete index (471/895) triggers auto-resume on every load
- HNSW library load and index parse takes noticeable time

### Impact
- Poor user experience on startup
- Delays access to agent features
- May cause users to think app is frozen

### Potential Fixes
1. **Progressive loading:** Allow agent use before full index ready
2. **Background indexing:** Lower priority, don't block UI
3. **Index caching:** Store HNSW graph in binary format for faster load
4. **Incremental sync:** Only index changed files, not full sync

### Priority
Medium - UX issue, not a crash

---

## ISSUE-004: Agent execution doesn't appear in Agent Streams

**Discovered:** 2026-01-11 (Phase 1, Plan 03 testing)
**Severity:** High
**Component:** AgentTaskQueue / AgentStreamsView

### Symptom
User reports:
- "Clicking agents... just pop up a notification on the top, a toast notification"
- "Nothing really happens... they don't even go to the agent dashboard"

### Context
- Quick Actions trigger agents via taskQueue
- Toast notification shows but agent card doesn't appear in Agent Streams
- Possibly related to incomplete index blocking agent execution

### Impact
- Users can't see agent progress
- Unclear if agents are running or failed
- Breaks the Agent Command Center concept

### Potential Fixes
1. Wire AgentStreamsView to AgentTaskQueue events
2. Show agent cards even when waiting for prerequisites
3. Add error state cards for blocked agents

### Priority
High - Core feature not working

---

## ISSUE-005: UI crashes on multiple simultaneous agent triggers

**Discovered:** 2026-01-11 (Phase 1, Plan 03 testing)
**Severity:** High
**Component:** Sidebar / Error handling

### Symptom
User reports:
- "Crashes the UI when you do multiple things at the same time"
- "Launch a bunch of agents"

### Context
- Multiple rapid Quick Action clicks
- Possibly concurrent state updates causing React/Preact errors
- May be related to signal updates racing

### Impact
- UI becomes unresponsive or crashes
- Requires Obsidian restart

### Potential Fixes
1. Debounce Quick Action clicks
2. Queue agent requests instead of parallel execution
3. Add error boundaries around agent execution paths
4. Review signal update patterns for race conditions

### Priority
High - Crashes UI

---

*Last updated: 2026-01-11*
