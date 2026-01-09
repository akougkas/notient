# Complete Flow: Task Modal Undo Action

**End-to-end journey from undo click to action reversal**

```
User views task in TaskModal
    ↓
TaskModal displays applied actions with undo buttons
    ↓
User clicks "Undo" button on an applied action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UNDO REQUEST                                                 │
│                                                             │
│ 1. Get action recordId from appliedActionRecordIds          │
│    ├─ Lookup: action.id → recordId                          │
│    └─ If not found: Show error                              │
│                                                             │
│ 2. Call actionHistory.undo(recordId)                        │
│    ├─ Find record in history                                │
│    ├─ Extract undo payload                                  │
│    └─ Apply undo operation                                  │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UNDO EXECUTION                                               │
│                                                             │
│ 1. Determine undo type from payload                         │
│    ├─ frontmatter_set → Restore old value                    │
│    ├─ frontmatter_add_tags → Remove tags                     │
│    ├─ append_section → Remove section                        │
│    ├─ append_related_links → Remove links                   │
│    └─ move_note → Move back to original location             │
│                                                             │
│ 2. Read current file                                         │
│ 3. Apply reverse operation                                   │
│    ├─ Restore previous state                                │
│    └─ Write updated file                                     │
│                                                             │
│ 4. Remove record from history                                │
│    ├─ Delete record from ActionHistory                       │
│    ├─ Persist changes                                        │
│    └─ Emit event: "action:undone"                            │
└─────────────────────────────────────────────────────────────┘
    ↓
Success notice: "Undone: <action title>"
    ↓
Update TaskModal UI
├─ Remove recordId from appliedActionRecordIds
└─ Re-render actions (show as available again)
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
✅ COMPLETE - Action undone and note restored
```
