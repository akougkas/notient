# Complete Flow: "Enhance" Button Click

**End-to-end journey from button click to note modification**

```
User clicks "Enhance" button
    ↓
Prefill chat: "Enrich and expand 'Project Alpha' with insights"
    ↓
User presses Enter
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (Phase 4)                                   │
│                                                             │
│ 1. Infer task type → "enrich"                               │
│ 2. Load current note → { title, path, content }             │
│ 3. Search for context (RAG)                                 │
│    ├─ Embed query → [0.234, -0.567, ...]                    │
│    ├─ Stage 1: Note-level candidates (80 notes)             │
│    ├─ Stage 2: Block-level chunks (120 chunks)              │
│    ├─ Optional: LLM reranking (top 10)                      │
│    └─ Return top 5 related notes                            │
│                                                             │
│ 4. Build system prompt                                      │
│    ├─ Base: "You are Notient..."                            │
│    ├─ Current note: (3000 chars)                            │
│    ├─ Task instructions: "Analyze and suggest..."           │
│    └─ Related notes: 5 notes × 400 chars                    │
│                                                             │
│ 5. Stream LLM response (LM Studio)                          │
│    POST /v1/chat/completions                                │
│    ├─ System prompt (~1500 chars)                           │
│    ├─ User message ("Enrich and expand...")                 │
│    ├─ Temperature: 0.7                                      │
│    ├─ Max tokens: 1500                                      │
│    └─ Stream: true                                          │
│                                                             │
│    Response (streaming):                                    │
│    → "Based on the current note, I suggest..."              │
│    → User sees tokens appear in real-time                   │
│                                                             │
│ 6. Generate action plan (non-streaming)                     │
│    POST /v1/chat/completions                                │
│    ├─ System: "Output ONLY valid JSON..."                   │
│    ├─ User: "Based on request, propose actions..."          │
│    ├─ Temperature: 0.7                                      │
│    └─ Max tokens: 1500                                      │
│                                                             │
│    Response:                                                │
│    {                                                        │
│      "actions": [                                           │
│        {                                                    │
│          "type": "frontmatter_add_tags",                    │
│          "title": "Add project tags",                       │
│          "payload": { "tags": ["project", "alpha", "q1"] }  │
│        },                                                   │
│        {                                                    │
│          "type": "append_related_links",                    │
│          "title": "Link to related projects",               │
│          "payload": { "links": ["Project Beta"] }           │
│        }                                                    │
│      ]                                                      │
│    }                                                        │
│                                                             │
│ 7. Validate actions                                         │
│    ├─ Override target to current note                       │
│    ├─ Override risk levels (LOW/MEDIUM)                     │
│    ├─ Validate payload structure                            │
│    └─ Generate unique IDs                                   │
│                                                             │
│ 8. Return result                                            │
│    {                                                        │
│      type: "action_plan",                                   │
│      data: "<LLM response>",                                │
│      citations: ["projects/beta.md"],                       │
│      actions: [2 validated actions]                         │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS RESULT                                          │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 💬 Chat Response:                                     │   │
│ │ "Based on the current note, I suggest adding tags..." │   │
│ │                                                       │   │
│ │ 📚 Citations:                                         │   │
│ │ • [[Project Beta#Budget]]                             │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ ⚡ Proposed Actions (2):                              │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ ✓ LOW   Add project tags                        │   │   │
│ │ │         Tags: project, alpha, q1                 │   │   │
│ │ │         Reason: Categorize as active project     │   │   │
│ │ │         [✓ Apply] [✗ Reject]                     │   │   │
│ │ └─────────────────────────────────────────────────┘   │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ ⚠ MEDIUM Link to related projects               │   │   │
│ │ │         Links: [[Project Beta]]                  │   │   │
│ │ │         Reason: Connect to similar projects      │   │   │
│ │ │         [✓ Apply] [✗ Reject]                     │   │   │
│ │ └─────────────────────────────────────────────────┘   │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
User clicks [✓ Apply] on first action
    ↓
┌─────────────────────────────────────────────────────────────┐
│ ACTION EXECUTION (Phase 5)                                  │
│                                                             │
│ 1. Read file: projects/alpha.md                             │
│ 2. Parse frontmatter (YAML)                                 │
│ 3. Merge tags: [...existing, "project", "alpha", "q1"]      │
│ 4. Write updated file                                       │
│ 5. Record in action history                                 │
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
✅ COMPLETE - Note fully updated and re-indexed
```
