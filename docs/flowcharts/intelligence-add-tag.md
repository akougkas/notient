# Complete Flow: Intelligence "Add Tag" Suggestion Click

**End-to-end journey from intelligence suggestion to tag addition**

```
User views note in sidebar
    ↓
Intelligence service displays suggested tags
    ↓
User clicks "+ #project" button
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION VALIDATION                                            │
│                                                             │
│ 1. Create ProposedAction                                    │
│    {                                                        │
│      id: crypto.randomUUID(),                              │
│      type: "frontmatter_add_tags",                          │
│      target: "projects/alpha.md",                           │
│      payload: { tags: ["project"] },                        │
│      risk: "low",                                            │
│      title: "Add tag #project",                             │
│      reason: "AI suggested tag with 85% confidence",         │
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
│    ├─ Risk: LOW                                             │
│    ├─ Auto-apply: Based on user settings                    │
│    └─ Decision: ALLOWED (no confirmation needed)            │
│                                                             │
│ 3. Validate action                                          │
│    ├─ Check target file exists                               │
│    ├─ Validate payload structure                            │
│    └─ Check tag format                                       │
│                                                             │
│ 4. Read file: projects/alpha.md                             │
│ 5. Parse frontmatter (YAML)                                 │
│    ├─ Current tags: ["alpha", "q1"]                         │
│    └─ Merge with new tags: ["alpha", "q1", "project"]       │
│                                                             │
│ 6. Write updated file                                       │
│    ---                                                      │
│    tags: [alpha, q1, project]                              │
│    ---                                                      │
│                                                             │
│ 7. Record in action history                                 │
│    ├─ Action ID: uuid                                       │
│    ├─ Timestamp: now                                         │
│    ├─ Undo data: { oldTags: [...], newTags: [...] }         │
│    └─ Store in ActionHistory                                │
└─────────────────────────────────────────────────────────────┘
    ↓
Success notice: "Added #project"
    ↓
Button removed from UI (suggestion consumed)
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
│    ├─ Note: Tag already exists, confidence updated           │
│    └─ Remove from suggestions (already applied)             │
│ 4. Regenerate link suggestions (vector search)              │
│ 5. Recalculate health score                                │
│    ├─ Metadata score improved (tag added)                    │
│    └─ Health score updated                                  │
│ 6. Update intelligence DB                                   │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Tag added and intelligence updated
```
