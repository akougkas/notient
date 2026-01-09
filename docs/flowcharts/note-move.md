# Complete Flow: "Move" Button Click

**End-to-end journey from button click to note reorganization**

```
User clicks "Move" button
    ↓
Prefill chat: "Suggest the best folder/category for 'Project Alpha' based on its content"
    ↓
User presses Enter
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (Phase 4)                                   │
│                                                             │
│ 1. Infer task type → "classify"                             │
│ 2. Load current note → { title, path, content }             │
│ 3. Search for context (RAG)                                 │
│    ├─ Embed query → [0.234, -0.567, ...]                    │
│    ├─ Stage 1: Note-level candidates (80 notes)             │
│    ├─ Stage 2: Block-level chunks (120 chunks)            │
│    ├─ Optional: LLM reranking (top 10)                      │
│    └─ Return top 7 related notes                            │
│                                                             │
│ 4. Build system prompt                                      │
│    ├─ Base: "You are Notient..."                            │
│    ├─ Current note: (3000 chars)                            │
│    ├─ Task instructions: "Suggest PARA category..."         │
│    └─ Related notes: 7 notes × 400 chars                    │
│                                                             │
│ 5. Stream LLM response (LM Studio)                          │
│    POST /v1/chat/completions                                │
│    ├─ System prompt (~1500 chars)                           │
│    ├─ User message ("Suggest the best folder...")           │
│    ├─ Temperature: 0.7                                    │
│    ├─ Max tokens: 1500                                      │
│    └─ Stream: true                                          │
│                                                             │
│    Response (streaming):                                    │
│    → "Based on the content, this note belongs in..."        │
│    → User sees tokens appear in real-time                   │
│                                                             │
│ 6. Generate action plan (non-streaming)                     │
│    POST /v1/chat/completions                                │
│    ├─ System: "Output ONLY valid JSON..."                   │
│    ├─ User: "Based on request, propose move action..."      │
│    ├─ Temperature: 0.7                                    │
│    └─ Max tokens: 1500                                      │
│                                                             │
│    Response:                                                │
│    {                                                        │
│      "actions": [                                           │
│        {                                                    │
│          "type": "move_note",                               │
│          "title": "Move to Projects folder",                │
│          "payload": {                                       │
│            "from": "inbox/project-alpha.md",               │
│            "to": "1-projects/project-alpha.md"              │
│          }                                                  │
│        }                                                    │
│      ]                                                      │
│    }                                                        │
│                                                             │
│ 7. Validate actions                                         │
│    ├─ Override target to current note                       │
│    ├─ Override risk levels (MEDIUM for move)               │
│    ├─ Validate payload structure                            │
│    ├─ Check destination folder exists                       │
│    └─ Generate unique IDs                                   │
│                                                             │
│ 8. Return result                                            │
│    {                                                        │
│      type: "action_plan",                                   │
│      data: "<LLM response>",                                │
│      citations: ["1-projects/project-beta.md"],            │
│      actions: [1 validated action]                         │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS RESULT                                          │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 💬 Chat Response:                                     │   │
│ │ "Based on the content, this note belongs in:"        │   │
│ │ • Folder: 1-projects/                                  │   │
│ │ • Reason: Active project with ongoing work            │   │
│ │ • Similar notes: Project Beta, Project Gamma           │   │
│ │                                                       │   │
│ │ 📚 Citations:                                         │   │
│ │ • [[Project Beta#Status]]                             │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ ⚡ Proposed Actions (1):                              │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ ⚠ MEDIUM Move to Projects folder                │   │   │
│ │ │         From: inbox/project-alpha.md            │   │
│ │ │         To: 1-projects/project-alpha.md         │   │
│ │ │         Reason: Active project categorization   │   │
│ │ │         [✓ Apply] [✗ Reject]                     │   │
│ │ └─────────────────────────────────────────────────┘   │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
User clicks [✓ Apply] on action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION EXECUTION (Phase 5)                                  │
│                                                             │
│ 1. Read file: inbox/project-alpha.md                        │
│ 2. Check destination folder exists (create if needed)      │
│ 3. Check destination file doesn't exist (prevent overwrite)│
│ 4. Move file: inbox/project-alpha.md → 1-projects/project-alpha.md │
│ 5. Update all internal links in moved file                  │
│ 6. Update backlinks in other notes                          │
│ 7. Record in action history                                 │
└─────────────────────────────────────────────────────────────┘
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
│ 2. Update intelligence DB with new path                    │
│ 3. Regenerate summary (LLM)                                 │
│ 4. Regenerate entities & tags (LLM)                         │
│ 5. Regenerate link suggestions (vector search)              │
│ 6. Recalculate health score                                 │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Note moved and re-indexed
```
