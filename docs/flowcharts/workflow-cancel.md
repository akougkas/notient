# Complete Flow: Workflow Cancel Button Click

**End-to-end journey from cancel click to workflow termination**

```
User views active workflow in agents view
    ↓
Workflow card shows: "/enrich on vault - running"
    ↓
User clicks "Cancel" button
    ↓
┌─────────────────────────────────────────────────────────────┐
│ CANCEL REQUEST                                               │
│                                                             │
│ 1. Get workflow ID from card                                 │
│ 2. Call workflowRunner.cancel(workflowId)                    │
│ 3. Find workflow in queue                                    │
│    ├─ Check if current workflow                              │
│    └─ Check if queued workflow                               │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ WORKFLOW CANCELLATION                                        │
│                                                             │
│ If current workflow:                                         │
│ ├─ 1. Abort current task execution                           │
│ │   ├─ Signal abort controller                              │
│ │   ├─ Stop streaming LLM response                          │
│ │   └─ Cancel in-flight requests                            │
│ │                                                            │
│ ├─ 2. Update workflow status                                │
│ │   ├─ Status: "cancelled"                                  │
│ │   └─ Preserve progress: completed/total                   │
│ │                                                            │
│ ├─ 3. Clean up resources                                    │
│ │   ├─ Release write locks                                  │
│ │   ├─ Clear abort controllers                              │
│ │   └─ Cancel pending tasks                                 │
│ │                                                            │
│ └─ 4. Process next workflow                                  │
│     └─ If queue has items, start next                       │
│                                                             │
│ If queued workflow:                                          │
│ ├─ 1. Remove from queue                                      │
│ ├─ 2. Update status: "cancelled"                            │
│ └─ 3. Emit event: "workflow:cancelled"                       │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI UPDATES                                                    │
│                                                             │
│ 1. Show notice: "Workflow cancelled"                         │
│ 2. Re-render agents view                                     │
│    ├─ Update workflow card status                           │
│    ├─ Remove progress bar                                   │
│    └─ Show "cancelled" badge                                │
│                                                             │
│ 3. Update workflow card                                      │
│    ┌─────────────────────────────────────────────────────┐   │
│    │ ⚡ /enrich on vault                                 │   │
│    │ Status: cancelled                                    │   │
│    │                                                       │   │
│    │ Progress: 23/50 (cancelled)                          │   │
│    └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Workflow cancelled and UI updated
```
