# Complete Flow: Task Modal Apply Action

**End-to-end journey from task modal to action application**

```
User views task in TaskModal
    ↓
TaskModal displays proposed actions
    ↓
User clicks "Apply" button on an action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ CONFIRMATION CHECK                                           │
│                                                             │
│ 1. Check action risk level                                  │
│    ├─ LOW: No confirmation needed                            │
│    ├─ MEDIUM: Show confirmation dialog                       │
│    └─ HIGH: Show danger confirmation dialog                  │
│                                                             │
│ 2. If confirmation needed:                                   │
│    ├─ Show dialog: "Apply this action?"                      │
│    ├─ Display action details                                │
│    └─ Wait for user confirmation                            │
│                                                             │
│ 3. If user cancels: Return early                             │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION APPLICATION                                           │
│                                                             │
│ 1. Call actionApplier.applyConfirmed(action, taskId)        │
│    ├─ Skip trust evaluation (user confirmed)                 │
│    ├─ Validate action                                        │
│    ├─ Apply action to note                                   │
│    └─ Record in action history                               │
│                                                             │
│ 2. Handle result                                             │
│    ├─ If success:                                            │
│    │  ├─ Show notice: "Applied: <action title>"              │
│    │  ├─ Track recordId for undo                             │
│    │  ├─ Update action UI (mark as applied)                  │
│    │  └─ Emit event: "agent:task-update"                     │
│    │                                                        │
│    └─ If failure:                                           │
│       ├─ Show notice: "Failed: <error>"                     │
│       └─ Keep action available for retry                     │
└─────────────────────────────────────────────────────────────┘
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
│ 5. Recalculate health score                                 │
│ 6. Update intelligence DB                                   │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Action applied and note updated
```
