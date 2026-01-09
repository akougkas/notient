# Complete Flow: Intelligence "Link to Note" Suggestion Click

**End-to-end journey from intelligence suggestion to note linking**

```
User views note in sidebar
    ↓
Intelligence service displays suggested links
    ↓
User clicks "Link" button next to "Link to [[Project Beta]]?"
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION VALIDATION                                            │
│                                                             │
│ 1. Create ProposedAction                                    │
│    {                                                        │
│      id: crypto.randomUUID(),                              │
│      type: "append_related_links",                          │
│      target: "projects/alpha.md",                           │
│      payload: { links: ["Project Beta"] },                  │
│      risk: "medium",                                         │
│      title: "Link to [[Project Beta]]",                     │
│      reason: "High semantic similarity (0.87)",            │
│      requiresWriteLock: true                                │
│    }                                                        │
│                                                             │
│ 2. Disable button (prevent double-click)                    │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION EXECUTION (Phase 5)                                  │
│                                                             │
│ 1. Check write lock (kernel.hasWriteLock)                   │
│ 2. Trust evaluation (TrustLevelManager)                     │
│    ├─ Risk: MEDIUM                                          │
│    ├─ Require confirmation: true                            │
│    └─ Decision: REQUIRES_CONFIRMATION                       │
│                                                             │
│ 3. Validate action                                          │
│    ├─ Check target file exists                               │
│    ├─ Validate payload structure                            │
│    ├─ Check linked note exists ("Project Beta")             │
│    └─ Check link doesn't already exist                       │
│                                                             │
│ 4. Read file: projects/alpha.md                             │
│ 5. Check for "## Related Notes" section                     │
│    ├─ If exists: Append link to section                     │
│    └─ If not: Create new section at end                     │
│                                                             │
│ 6. Append link                                              │
│    ## Related Notes                                          │
│    - [[Project Beta]]                                        │
│                                                             │
│ 7. Write updated file                                       │
│                                                             │
│ 8. Record in action history                                 │
│    ├─ Action ID: uuid                                       │
│    ├─ Timestamp: now                                         │
│    ├─ Undo data: { section: "...", position: end }         │
│    └─ Store in ActionHistory                                │
└─────────────────────────────────────────────────────────────┘
    ↓
Success notice: "Linked to [[Project Beta]]"
    ↓
Suggestion row removed from UI
    ↓
File modified → Triggers file watcher
    ↓
┌─────────────────────────────────────────────────────────────┐
│ RE-INDEXING (Phase 1, automatic)                            │
│                                                             │
│ 1. Debounce 5s                                              │
│ 2. Re-chunk note (TSI v2)                                   │
│ 3. Re-embed chunks (Ollama)                                 │
│ 4. Update vector store                                      │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE REGENERATION (Phase 2, background queue)       │
│                                                             │
│ 1. Detect content change (contentHash mismatch)             │
│ 2. Regenerate summary (LLM)                                 │
│ 3. Regenerate entities & tags (LLM)                         │
│ 4. Regenerate link suggestions (vector search)              │
│    ├─ Note: Link already exists, remove from suggestions     │
│    └─ Update connectivity score                             │
│ 5. Recalculate health score                                │
│    ├─ Connectivity score improved (link added)                │
│    └─ Health score updated                                  │
│ 6. Update intelligence DB                                   │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Link added and intelligence updated
```
