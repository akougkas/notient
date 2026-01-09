# Complete Flow: "Generate Summary" Button Click

**End-to-end journey from button click to summary generation**

```
User views note in sidebar
    ↓
Intelligence section shows: "No AI summary yet..."
    ↓
User clicks "Generate summary" button
    ↓
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE REGENERATION                                    │
│                                                             │
│ 1. Call intelligence.regenerate(path)                       │
│    ├─ Path: "projects/alpha.md"                             │
│    └─ Enqueue note for processing                           │
│                                                             │
│ 2. Show notice: "Generating note summary…"                 │
│                                                             │
│ 3. Background queue processing                              │
│    ├─ Check note exists                                     │
│    ├─ Read note content (max 12,000 chars)                  │
│    └─ Check content hash changed                            │
│                                                             │
│ 4. Generate summary (LLM)                                   │
│    POST /v1/chat/completions                                │
│    ├─ System: "You are a note summarization assistant..."   │
│    ├─ User: "Summarize this note: <content>"                │
│    ├─ Temperature: 0.2                                      │
│    ├─ Max tokens: 500                                       │
│    └─ Stream: false                                        │
│                                                             │
│    Response:                                                │
│    {                                                        │
│      "choices": [{                                          │
│        "message": {                                         │
│          "content": "This note describes Project Alpha..."  │
│        }                                                    │
│      }]                                                     │
│    }                                                        │
│                                                             │
│ 5. Parse structured summary                                 │
│    ├─ Extract short summary (1-2 sentences)                  │
│    ├─ Extract key points (bullets)                          │
│    └─ Extract purpose statement                              │
│                                                             │
│ 6. Generate entities & tags (LLM)                          │
│    POST /v1/chat/completions                                │
│    ├─ System: "Extract entities and tags..."                │
│    ├─ User: "Extract entities from: <content>"              │
│    ├─ Temperature: 0.1                                      │
│    └─ Max tokens: 800                                       │
│                                                             │
│    Response:                                                │
│    {                                                        │
│      "entities": [                                          │
│        { "name": "Project Alpha", "type": "project" },      │
│        { "name": "Q1 2024", "type": "timeframe" }           │
│      ],                                                     │
│      "tags": ["project", "active", "q1"]                   │
│    }                                                        │
│                                                             │
│ 7. Generate link suggestions (Vector Search)                │
│    ├─ Embed note content                                    │
│    ├─ Search similar notes (top 5)                          │
│    └─ Calculate confidence scores                            │
│                                                             │
│ 8. Calculate health score                                  │
│    ├─ Freshness: 25% (based on mtime)                       │
│    ├─ Connectivity: 35% (based on links)                   │
│    ├─ Structure: 20% (based on headings)                   │
│    └─ Metadata: 20% (based on tags/frontmatter)            │
│                                                             │
│ 9. Update intelligence DB                                  │
│    ├─ Save summaryShort                                     │
│    ├─ Save summaryStructured                                │
│    ├─ Save entities                                         │
│    ├─ Save suggestedTags                                    │
│    ├─ Save suggestedLinks                                   │
│    ├─ Save health score                                     │
│    └─ Update contentHash                                    │
│                                                             │
│ 10. Emit event: "intelligence:updated"                     │
│     ├─ Path: "projects/alpha.md"                            │
│     └─ Trigger UI refresh                                   │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI UPDATES                                                    │
│                                                             │
│ 1. Sidebar receives "intelligence:updated" event            │
│ 2. Check if current note matches path                       │
│ 3. Re-render intelligence section                            │
│    ├─ Show summary text                                      │
│    ├─ Show entities                                          │
│    ├─ Show suggested tags                                    │
│    ├─ Show suggested links                                    │
│    └─ Show health score                                       │
│                                                             │
│ 4. Remove "Generate summary" button                           │
│    (summary now exists)                                       │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Summary generated and displayed
```
