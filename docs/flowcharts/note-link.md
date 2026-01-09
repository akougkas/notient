# Complete Flow: "Link" Button Click

**End-to-end journey from button click to note linking**

```
User clicks "Link" button
    ↓
Prefill chat: "Find notes that should be linked to 'Project Alpha'"
    ↓
User presses Enter
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (Phase 4)                                   │
│                                                             │
│ 1. Infer task type → "link"                                 │
│ 2. Load current note → { title, path, content }             │
│ 3. Search for context (RAG)                                 │
│    ├─ Embed query → [0.234, -0.567, ...]                    │
│    ├─ Stage 1: Note-level candidates (80 notes)             │
│    ├─ Stage 2: Block-level chunks (120 chunks)              │
│    ├─ Optional: LLM reranking (top 10)                      │
│    └─ Return top 7 related notes                            │
│                                                             │
│ 4. Build system prompt                                      │
│    ├─ Base: "You are Notient..."                            │
│    ├─ Current note: (3000 chars)                            │
│    ├─ Task instructions: "Find notes that should be..."    │
│    └─ Related notes: 7 notes × 400 chars                   │
│                                                             │
│ 5. Stream LLM response (LM Studio)                          │
│    POST /v1/chat/completions                                │
│    ├─ System prompt (~1500 chars)                           │
│    ├─ User message ("Find notes that should be linked...")  │
│    ├─ Temperature: 0.7                                    │
│    ├─ Max tokens: 1500                                      │
│    └─ Stream: true                                          │
│                                                             │
│    Response (streaming):                                    │
│    → "Based on the content, I found these related notes..." │
│    → User sees tokens appear in real-time                   │
│                                                             │
│ 6. Generate action plan (non-streaming)                     │
│    POST /v1/chat/completions                                │
│    ├─ System: "Output ONLY valid JSON..."                   │
│    ├─ User: "Based on request, propose link actions..."     │
│    ├─ Temperature: 0.7                                    │
│    └─ Max tokens: 1500                                      │
│                                                             │
│    Response:                                                │
│    {                                                        │
│      "actions": [                                           │
│        {                                                    │
│          "type": "append_related_links",                     │
│          "title": "Link to related projects",               │
│          "payload": { "links": ["Project Beta", "Project Gamma"] } │
│        }                                                    │
│      ]                                                      │
│    }                                                        │
│                                                             │
│ 7. Validate actions                                         │
│    ├─ Override target to current note                       │
│    ├─ Override risk levels (MEDIUM for links)               │
│    ├─ Validate payload structure                            │
│    └─ Generate unique IDs                                   │
│                                                             │
│ 8. Return result                                            │
│    {                                                        │
│      type: "action_plan",                                   │
│      data: "<LLM response>",                                │
│      citations: ["projects/beta.md", "projects/gamma.md"], │
│      actions: [1 validated action]                         │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS RESULT                                          │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 💬 Chat Response:                                     │   │
│ │ "Based on the content, I found these related notes:" │   │
│ │ • [[Project Beta]] - Similar project scope           │   │
│ │ • [[Project Gamma]] - Related technology stack       │   │
│ │                                                       │   │
│ │ 📚 Citations:                                         │   │
│ │ • [[Project Beta#Overview]]                           │   │
│ │ • [[Project Gamma#Tech Stack]]                        │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ ⚡ Proposed Actions (1):                              │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ ⚠ MEDIUM Link to related projects               │   │   │
│ │ │         Links: [[Project Beta]], [[Project Gamma]] │   │
│ │ │         Reason: Connect to similar projects      │   │
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
│ 1. Read file: projects/alpha.md                             │
│ 2. Check if "## Related Notes" section exists               │
│ 3. If exists: Append links to existing section              │
│ 4. If not: Create new "## Related Notes" section           │
│ 5. Append links: [[Project Beta]], [[Project Gamma]]       │
│ 6. Write updated file                                       │
│ 7. Record in action history                                 │
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
│ INTELLIGENCE REGENERATION (Phase 2, background queue)     │
│                                                             │
│ 1. Detect content change (contentHash mismatch)             │
│ 2. Regenerate summary (LLM)                                 │
│ 3. Regenerate entities & tags (LLM)                         │
│ 4. Regenerate link suggestions (vector search)              │
│ 5. Recalculate health score                                 │
│ 6. Update intelligence DB                                   │
└─────────────────────────────────────────────────────────────┘
    ↓
✅ COMPLETE - Note linked and re-indexed
```
