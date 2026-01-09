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
