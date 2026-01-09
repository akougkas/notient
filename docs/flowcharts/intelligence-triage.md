# Complete Flow: Intelligence "Triage Action" Apply Click

**End-to-end journey from triage suggestion to note organization**

```
User views note in sidebar
    ↓
Intelligence service detects note in inbox
    ↓
Triage action displayed: "Move to '1-projects'? Reason: Active project"
    ↓
User clicks "Apply" button
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION VALIDATION                                            │
│                                                             │
│ 1. Parse triage action                                      │
│    ├─ Type: "move"                                           │
│    ├─ Target: "1-projects"                                  │
│    └─ Reason: "Active project"                              │
│                                                             │
│ 2. Create ProposedAction                                    │
│    {                                                        │
│      id: crypto.randomUUID(),                              │
│      type: "move_note",                                     │
│      target: "inbox/project-alpha.md",                       │
│      payload: {                                             │
│        from: "inbox/project-alpha.md",                      │
│        to: "1-projects/project-alpha.md"                    │
│      },                                                      │
│      risk: "medium",                                         │
│      title: "Move to 1-projects",                            │
│      reason: "Active project",                              │
│      requiresWriteLock: true                                │
│    }                                                        │
│                                                             │
│ 3. Disable button (prevent double-click)                    │
│ 4. Update button text: "Applying..."                        │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION EXECUTION (Phase 5)                                  │
│                                                             │
│ 1. Check write lock (kernel.hasWriteLock)                   │
│ 2. Trust evaluation (TrustLevelManager)                     │
│    ├─ Risk: MEDIUM                                          │
│    ├─ Require confirmation: true                            │
│    └─ Decision: ALLOWED (user clicked Apply)                 │
│                                                             │
│ 3. Validate action                                          │
│    ├─ Check source file exists                               │
│    ├─ Check destination folder exists (create if needed)    │
│    ├─ Check destination file doesn't exist                   │
│    └─ Validate path format                                   │
│                                                             │
│ 4. Read file: inbox/project-alpha.md                        │
│ 5. Move file                                                │
│    ├─ Copy content to new location                          │
│    ├─ Delete old file                                        │
│    └─ Update file system                                     │
│                                                             │
│ 6. Update internal links                                    │
│    ├─ Scan moved file for relative links                     │
│    └─ Update paths if needed                                 │
│                                                             │
│ 7. Update backlinks                                         │
│    ├─ Find all notes linking to old path                     │
│    └─ Update link references                                 │
│                                                             │
│ 8. Record in action history                                 │
│    ├─ Action ID: uuid                                       │
│    ├─ Timestamp: now                                         │
│    ├─ Undo data: { oldPath: "...", newPath: "..." }         │
│    └─ Store in ActionHistory                                 │
└─────────────────────────────────────────────────────────────┘
    ↓
Success notice: "Applied triage action"
    ↓
Triage box removed from UI
    ↓
File moved → Triggers file watcher
    ↓
┌─────────────────────────────────────────────────────────────┐
│ RE-INDEXING (Phase 1, automatic)                            │
│                                                             │
│ 1. Debounce 5s                                              │
│ 2. Remove old path from index                               │
│ 3. Add new path to index                                    │
│ 4. Re-chunk note (TSI v2)                                   │
│ 5. Re-embed chunks (Ollama)                                 │
│ 6. Update vector store                                      │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE REGENERATION (Phase 2, background queue)       │
│                                                             │
│ 1. Detect path change (pathHash mismatch)                   │
│ 2. Update intelligence DB                                  │
│    ├─ Remove old path record                                 │
│    ├─ Create new path record                                 │
│    └─ Migrate intelligence data                              │
│ 3. Regenerate summary (LLM)                                 │
│ 4. Regenerate entities & tags (LLM)                         │
│ 5. Regenerate link suggestions (vector search)              │
│ 6. Recalculate health score                                 │
│ 7. Clear triage action (note no longer in inbox)            │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Note triaged and re-indexed
```
