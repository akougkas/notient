# Complete Note Journey Through Notient

**Visual Guide:** How notes flow through Notient's AI-powered pipelines

---

## Overview: The Life of a Note

```
┌─────────────────────────────────────────────────────────────────┐
│                   USER CREATES/EDITS NOTE                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
           ┌─────────────────────────────────────┐
           │   PHASE 1: INDEXING & EMBEDDING     │
           │  ┌──────────────────────────────┐   │
           │  │ File Watcher (debounced 5s) │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Tiered Semantic Chunking    │   │
           │  │ (TSI v2)                     │   │
           │  │ • Tier 0: Note (1 chunk)     │   │
           │  │ • Tier 1: Sections (H1-H3)   │   │
           │  │ • Tier 2: Blocks (¶,list,etc)│   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Batch Embedding (Ollama)    │   │
           │  │ • Model: nomic-embed-text    │   │
           │  │ • Batch size: 4 chunks       │   │
           │  │ • Dimension: 768             │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Vector Store (JSON file)     │   │
           │  │ • Index per model            │   │
           │  │ • Flat array (fast search)   │   │
           │  └──────────────────────────────┘   │
           └─────────────────────────────────────┘
                             │
                             ▼
           ┌─────────────────────────────────────┐
           │   PHASE 2: INTELLIGENCE GENERATION  │
           │         (Background Queue)           │
           │  ┌──────────────────────────────┐   │
           │  │ Note Summary (LLM)           │   │
           │  │ • Short summary (1-2 sent)   │   │
           │  │ • Key points (bullets)       │   │
           │  │ • Purpose statement          │   │
           │  │ Temp: 0.2, Tokens: 500       │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Entity & Tag Extraction      │   │
           │  │ • People, projects, tools    │   │
           │  │ • Suggested tags             │   │
           │  │ Temp: 0.1, Tokens: 800       │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Link Intelligence (Vector)   │   │
           │  │ • Semantic similarity        │   │
           │  │ • Shared tags                │   │
           │  │ • Direct links               │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Health Score (Heuristic)     │   │
           │  │ • Freshness (25%)            │   │
           │  │ • Connectivity (35%)         │   │
           │  │ • Structure (20%)            │   │
           │  │ • Metadata (20%)             │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Inbox Triage (LLM, optional) │   │
           │  │ • Move/tag/status            │   │
           │  │ Temp: 0.1, Tokens: 300       │   │
           │  └──────────┬───────────────────┘   │
           │             ▼                        │
           │  ┌──────────────────────────────┐   │
           │  │ Intelligence DB              │   │
           │  │ • JSON file per model        │   │
           │  │ • Updated on content change  │   │
           │  └──────────────────────────────┘   │
           └─────────────────────────────────────┘
                             │
                             ▼
           ┌─────────────────────────────────────┐
           │      USER INTERACTION PATHWAYS       │
           │                                      │
           │  ┌──────────────┐  ┌─────────────┐  │
           │  │   SEARCH     │  │    CHAT     │  │
           │  │              │  │   (Agent)   │  │
           │  └──────┬───────┘  └──────┬──────┘  │
           │         │                 │         │
           │         ▼                 ▼         │
           │  ┌──────────────────────────────┐  │
           │  │    PHASE 3: RETRIEVAL        │  │
           │  │  (Search & RAG Pipeline)     │  │
           │  └──────────┬───────────────────┘  │
           │             ▼                       │
           │  ┌──────────────────────────────┐  │
           │  │ PHASE 4: REASONING (Agent)   │  │
           │  │  (Chat + Action Generation)  │  │
           │  └──────────┬───────────────────┘  │
           │             ▼                       │
           │  ┌──────────────────────────────┐  │
           │  │ PHASE 5: ACTION EXECUTION    │  │
           │  │  (User-approved changes)     │  │
           │  └──────────────────────────────┘  │
           └─────────────────────────────────────┘
```

---

## Phase 3: Retrieval (Search & RAG)

**Triggered by:** User search OR Agent needs context

```
┌───────────────────────────────────────────────────────────────────┐
│                      USER QUERY / SEARCH                           │
│                   "machine learning techniques"                    │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
                ┌───────────────────────────────┐
                │  Query Embedding (Ollama)     │
                │  • Model: nomic-embed-text    │
                │  • Cached for 5min            │
                └───────────────┬───────────────┘
                                │
                                ▼
        ┌───────────────────────────────────────────┐
        │   HIERARCHICAL VECTOR SEARCH              │
        │                                           │
        │   ┌─────────────────────────────────┐    │
        │   │ Stage 1: Note-Level Candidates  │    │
        │   │ • tier=note                     │    │
        │   │ • topK=80 (wide net)            │    │
        │   │ • Cosine similarity             │    │
        │   │ → [note-abc, note-def, ...]     │    │
        │   └──────────────┬──────────────────┘    │
        │                  ▼                        │
        │   ┌─────────────────────────────────┐    │
        │   │ Stage 2: Block-Level Chunks     │    │
        │   │ • tier=block                    │    │
        │   │ • noteIds=stage1_results        │    │
        │   │ • topK=120, maxPerNote=5        │    │
        │   │ → [chunk1, chunk2, ...]         │    │
        │   └──────────────┬──────────────────┘    │
        │                  │                        │
        └──────────────────┼────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  Optional: LLM Reranking     │
            │  (if enableReranking=true)   │
            │                              │
            │  • Top 10 chunks             │
            │  • Temp: 0.3, Tokens: 500    │
            │  • JSON output validation    │
            │  • Fallback to vector scores │
            └──────────────┬───────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  Aggregate Chunks → Notes    │
            │                              │
            │  • Group by noteId           │
            │  • bestScore = max(chunk)    │
            │  • Sort by score DESC        │
            │  • Limit to topK             │
            └──────────────┬───────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │         SEARCH RESULTS               │
        │                                      │
        │  [                                   │
        │    {                                 │
        │      noteId: "note-abc",             │
        │      path: "ml/basics.md",           │
        │      title: "ML Basics",             │
        │      bestScore: 0.87,                │
        │      chunks: [                       │
        │        {                             │
        │          text: "...",                │
        │          headingPath: ["Intro"],     │
        │          blockRef: "abc123",         │
        │          score: 0.87                 │
        │        }                             │
        │      ]                               │
        │    },                                │
        │    ...                               │
        │  ]                                   │
        └──────────────┬───────────────────────┘
                       │
                       ├─ If USER SEARCH → Display in UI
                       │
                       └─ If AGENT QUERY → Continue to Phase 4
```

---

## Phase 4: Reasoning (Agent Pipeline)

**Triggered by:** User chat message (especially "Enhance", "Link", "Move" buttons)

```
┌──────────────────────────────────────────────────────────────────┐
│                  USER CHAT MESSAGE                                │
│        "Enrich and expand 'Project Alpha' with insights"          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────┐
                │  Task Inference               │
                │                               │
                │  query.includes("enrich")     │
                │  → TaskType: "enrich"         │
                │                               │
                │  Other types:                 │
                │  • link, classify, analyze    │
                │  • null (generic chat)        │
                └────────────┬──────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────────┐
        │  Load Current Note                     │
        │                                        │
        │  • Read file content (full)            │
        │  • Extract frontmatter, metadata       │
        │  • NoteContext { title, path, content }│
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │  Search for Related Context (RAG)      │
        │                                        │
        │  searchQuery = query + noteTitle       │
        │  searchResults = await search({        │
        │    topK: 7,                            │
        │    enableReranking: true               │
        │  })                                    │
        │                                        │
        │  Filter: Exclude current note          │
        │  Limit: Top 5 related notes            │
        │                                        │
        │  Build citations:                      │
        │  [[Note#Heading#SubHeading]]           │
        │  [[Note#^blockRef]]                    │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────────────────────┐
        │  Build System Prompt                                   │
        │                                                        │
        │  ┌──────────────────────────────────────────────────┐ │
        │  │ BASE PROMPT:                                     │ │
        │  │ "You are Notient, an AI assistant..."           │ │
        │  │ "CRITICAL RULES: Always ground responses..."    │ │
        │  └──────────────────────────────────────────────────┘ │
        │                                                        │
        │  ┌──────────────────────────────────────────────────┐ │
        │  │ CURRENT NOTE (FOCUS):                            │ │
        │  │ Title: Project Alpha                             │ │
        │  │ Path: projects/alpha.md                          │ │
        │  │                                                  │ │
        │  │ <content up to 3000 chars>                       │ │
        │  └──────────────────────────────────────────────────┘ │
        │                                                        │
        │  ┌──────────────────────────────────────────────────┐ │
        │  │ TASK INSTRUCTIONS:                               │ │
        │  │ "Analyze the current note and suggest..."        │ │
        │  └──────────────────────────────────────────────────┘ │
        │                                                        │
        │  ┌──────────────────────────────────────────────────┐ │
        │  │ RELATED NOTES FROM VAULT:                        │ │
        │  │ ### [[Project Beta#Budget]] (projects/beta.md)   │ │
        │  │ Similar project with detailed budget...          │ │
        │  │                                                  │ │
        │  │ ### [[Budget Template#Q1]] (templates/...)       │ │
        │  │ Standard template for quarterly...               │ │
        │  │ ...                                              │ │
        │  └──────────────────────────────────────────────────┘ │
        │                                                        │
        │  Total size: 500-2000 chars                            │
        └────────────┬───────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │  Stream LLM Response (LM Studio)       │
        │                                        │
        │  POST /v1/chat/completions             │
        │  {                                     │
        │    model: "ministral-3b-instruct",     │
        │    messages: [                         │
        │      { role: "system", content: "..." },│
        │      { role: "user", content: "..." }  │
        │    ],                                  │
        │    temperature: 0.7,                   │
        │    max_tokens: 1500,                   │
        │    stream: true                        │
        │  }                                     │
        │                                        │
        │  Response: SSE stream                  │
        │  → "Based on the current note..."      │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────────────────────┐
        │  Generate Action Plan (if agentic task)                │
        │  Only for: enrich, link, classify                      │
        │                                                        │
        │  POST /v1/chat/completions (non-streaming)             │
        │  {                                                     │
        │    model: "ministral-3b-instruct",                     │
        │    messages: [                                         │
        │      {                                                 │
        │        role: "system",                                 │
        │        content: "You are an AI assistant..."           │
        │                 "Output ONLY valid JSON..."            │
        │      },                                                │
        │      {                                                 │
        │        role: "user",                                   │
        │        content: "Based on request 'Enrich...' ..."     │
        │                 "propose specific actions..."          │
        │      }                                                 │
        │    ],                                                  │
        │    temperature: 0.7,                                   │
        │    max_tokens: 1500                                    │
        │  }                                                     │
        │                                                        │
        │  Expected response:                                    │
        │  {                                                     │
        │    "actions": [                                        │
        │      {                                                 │
        │        "type": "frontmatter_add_tags",                 │
        │        "title": "Add project tags",                    │
        │        "reason": "Categorize as active project",       │
        │        "target": "projects/alpha.md",                  │
        │        "payload": { "tags": ["project", "alpha"] }     │
        │      }                                                 │
        │    ]                                                   │
        │  }                                                     │
        └────────────┬───────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────────────────────┐
        │  Validate & Sanitize Actions                           │
        │                                                        │
        │  For each action:                                      │
        │  ✅ Check type is supported                            │
        │  ✅ Check required fields present                      │
        │  ✅ Override target to current note (security!)        │
        │  ✅ Reject non-.md files                               │
        │  ✅ Override risk level (don't trust LLM)              │
        │  ✅ Validate payload structure                         │
        │  ✅ Truncate strings to max lengths                    │
        │  ✅ Generate unique action ID                          │
        │                                                        │
        │  Risk levels (enforced by code):                       │
        │  • frontmatter_set → LOW                               │
        │  • frontmatter_add_tags → LOW                          │
        │  • append_section → LOW                                │
        │  • append_related_links → MEDIUM                       │
        │  • move_note → MEDIUM                                  │
        └────────────┬───────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │  AGENT RESULT                          │
        │                                        │
        │  {                                     │
        │    type: "action_plan",                │
        │    data: "<LLM response text>",        │
        │    citations: [                        │
        │      "projects/beta.md",               │
        │      "templates/budget.md"             │
        │    ],                                  │
        │    actions: [                          │
        │      {                                 │
        │        id: "action-123",               │
        │        type: "frontmatter_add_tags",   │
        │        risk: "low",                    │
        │        title: "Add project tags",      │
        │        reason: "Categorize...",        │
        │        target: "projects/alpha.md",    │
        │        payload: { ... }                │
        │      }                                 │
        │    ]                                   │
        │  }                                     │
        └────────────┬───────────────────────────┘
                     │
                     └─→ Display in UI with Action Review Cards
```

---

## Phase 5: Action Execution

**Triggered by:** User approves action from review queue

```
┌──────────────────────────────────────────────────────────────────┐
│                   USER APPROVES ACTION                            │
│              (clicks checkmark on action card)                    │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────┐
                │  Action Applier                │
                │                                │
                │  switch (action.type) {        │
                │    case "frontmatter_set":     │
                │    case "frontmatter_add_tags":│
                │    case "append_section":      │
                │    case "append_related_links":│
                │    case "move_note":           │
                │  }                             │
                └────────────┬───────────────────┘
                             │
                             ▼
        ┌─────────────────────────────────────────────────────┐
        │  Example: frontmatter_add_tags                      │
        │                                                     │
        │  1. Read current file content                       │
        │     const content = await readFile(action.target)   │
        │                                                     │
        │  2. Parse frontmatter (YAML)                        │
        │     const fm = parseYAML(content)                   │
        │                                                     │
        │  3. Merge tags (avoid duplicates)                   │
        │     fm.tags = [...new Set([...fm.tags, ...new])]   │
        │                                                     │
        │  4. Rebuild file content                            │
        │     const newContent = buildYAML(fm) + body         │
        │                                                     │
        │  5. Write file                                      │
        │     await writeFile(action.target, newContent)      │
        │                                                     │
        │  6. Record in action history                        │
        │     await actionHistory.record({                    │
        │       action,                                       │
        │       status: "applied",                            │
        │       timestamp: Date.now()                         │
        │     })                                              │
        └─────────────────────┬───────────────────────────────┘
                              │
                              ▼
                ┌──────────────────────────────┐
                │  Trigger Re-indexing         │
                │                              │
                │  File modified               │
                │  → File watcher detects      │
                │  → Debounce 5s               │
                │  → Re-chunk                  │
                │  → Re-embed                  │
                │  → Update index              │
                │  → Regenerate intelligence   │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  ✅ ACTION COMPLETE           │
                │                              │
                │  Note updated                │
                │  Index refreshed             │
                │  Intelligence regenerated    │
                └──────────────────────────────┘
```

---

## Complete Flow: "Enhance" Button Click

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

---

## Request Count Analysis

### "Enhance" Button Click (Full Journey)

**Phase 4: Agent Execution**
1. Query embedding (Ollama): 1 request
2. LLM reranking (LM Studio, optional): 1 request
3. Chat response (LM Studio, streaming): 1 request
4. Action plan generation (LM Studio): 1 request

**Total: 3-4 LLM requests**

**Phase 5: Action Execution**
- 0 LLM requests (pure file operations)

**Phase 1: Re-indexing (triggered automatically)**
- ~10-20 embedding requests (Ollama, batched by 4)

**Phase 2: Intelligence Regeneration (triggered automatically)**
- Summary generation (LM Studio): 1 request
- Entity & tag extraction (LM Studio): 1 request
- Link suggestions (vector search only): 0 requests
- Triage (if inbox note, LM Studio): 0-1 request

**Total: 2-3 LLM requests**

### Grand Total Per "Enhance" Click
- **Immediate (user sees):** 3-4 requests (~16-42s)
- **Background (automatic):** 2-3 requests (~30-60s)
- **Embeddings:** ~10-20 requests (~2-5s)

**Overall:** ~15-27 LLM/embedding requests per "Enhance" click

---

## Data Privacy Summary

### What Stays Local
✅ 100% of processing happens on your machine
✅ No external API calls
✅ No telemetry
✅ No cloud services

### What Goes to Localhost
⚠️ Note content → Ollama (localhost:11434)
⚠️ Prompts + context → LM Studio (localhost:1234)

### What NEVER Leaves
✅ File paths stay within Notient
✅ Metadata stays within Notient
✅ User queries stay within Notient

**Privacy Guarantee:** Your vault never touches the internet for AI processing.

---

## Performance Characteristics

### Latencies (Typical Hardware: M2 MacBook, 16GB RAM)

**Indexing (1000 notes):**
- Chunking: ~20s
- Embedding: ~3min
- Total: ~3.5min

**Search:**
- Query embedding: ~100ms
- Vector search: ~50ms
- Reranking: ~1.5s
- Total: ~1.7s

**Agent ("Enhance"):**
- Load note: ~10ms
- RAG search: ~1.7s
- Chat response: ~20s (streaming)
- Action plan: ~8s
- Total: ~30s

**Background Intelligence:**
- Summary: ~5s
- Extraction: ~8s
- Links: ~1s
- Health: <1s
- Total: ~15s per note

---

**Document Version:** 1.0
**Last Updated:** 2026-01-07
**Companion to:** AI_ARCHITECTURE.md
**License:** MIT
