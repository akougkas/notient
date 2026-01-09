# Complete Flow: Dashboard Review Queue Actions

**End-to-end journey from review queue to action application/dismissal**

```
User opens Dashboard view
    ↓
Dashboard shows "Review Queue" tab
    ↓
Review queue displays actions from workflows
    ↓
┌─────────────────────────────────────────────────────────────┐
│ REVIEW QUEUE DISPLAY                                          │
│                                                             │
│ 1. Get all review items from workflows                      │
│    ├─ Query WorkflowRunner for all workflows                │
│    ├─ Collect reviewQueue from each workflow                 │
│    └─ Flatten into single list                               │
│                                                             │
│ 2. Display actions (up to 20)                               │
│    ├─ Risk badge (LOW/MEDIUM/HIGH)                          │
│    ├─ Action title                                          │
│    ├─ Target note path                                       │
│    ├─ Reason for action                                      │
│    └─ Action buttons: [Apply] [Dismiss]                     │
└─────────────────────────────────────────────────────────────┘
    ↓
User clicks "Apply" on an action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION APPLICATION                                           │
│                                                             │
│ 1. Disable button                                            │
│ 2. Update button text: "Applying..."                         │
│                                                             │
│ 3. Call actionApplier.applyConfirmed(action)                │
│    ├─ Skip trust evaluation (already reviewed)              │
│    ├─ Validate action                                        │
│    ├─ Apply action to note                                  │
│    └─ Record in action history                               │
│                                                             │
│ 4. Handle result                                             │
│    ├─ If success:                                            │
│    │  ├─ Show notice: "Applied: <action title>"              │
│    │  ├─ Remove from review queue                            │
│    │  └─ Re-render dashboard                                 │
│    │                                                        │
│    └─ If failure:                                           │
│       ├─ Show notice: "Failed: <error>"                     │
│       └─ Re-enable button                                    │
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

```
User clicks "Dismiss" on an action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION DISMISSAL                                             │
│                                                             │
│ 1. Call workflowRunner.dismissReviewItem(actionId)          │
│                                                             │
│ 2. Find action in workflows                                  │
│    ├─ Check current workflow reviewQueue                     │
│    └─ Check queued workflows reviewQueue                     │
│                                                             │
│ 3. Remove action from queue                                  │
│    ├─ Splice from reviewQueue array                         │
│    └─ Emit event: "workflow:reviewDismissed"                │
│                                                             │
│ 4. Re-render dashboard                                       │
│    ├─ Action removed from display                            │
│    └─ Update queue count                                     │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Action dismissed from queue
```
