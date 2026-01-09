# Complete Flow: Metric Click (Health/Links/Freshness)

**End-to-end journey from metric click to agent analysis**

```
User views note vitals in sidebar
    ↓
User clicks on metric (Health/Links/Freshness)
    ↓
┌─────────────────────────────────────────────────────────────┐
│ METRIC CLICK HANDLER                                         │
│                                                             │
│ 1. Determine metric type                                    │
│    ├─ "health" → Analyze health                             │
│    ├─ "links" → Show connections                            │
│    └─ "freshness" → Review changes                          │
│                                                             │
│ 2. Build prompt based on metric                             │
│    ├─ Health: "Analyze the health of my note..."            │
│    ├─ Links: "Show me all the connections..."               │
│    └─ Freshness: "What has changed in..."                    │
│                                                             │
│ 3. Call prefillChatAndSwitch(prompt)                        │
│    ├─ Switch to agents view                                 │
│    └─ Enqueue chat task                                      │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT TASK ENQUEUE                                           │
│                                                             │
│ 1. Create AgentTask                                         │
│    {                                                        │
│      agent: "chat",                                         │
│      notePath: "projects/alpha.md",                          │
│      noteTitle: "Project Alpha",                            │
│      chatHistory: [                                         │
│        {                                                    │
│          role: "user",                                      │
│          content: "Analyze the health of my note..."        │
│        }                                                    │
│      ]                                                      │
│    }                                                        │
│                                                             │
│ 2. Add to AgentTaskQueue                                    │
│ 3. Switch sidebar view to "agents"                           │
│ 4. Render agents view                                       │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (Phase 4)                                   │
│                                                             │
│ 1. Task inference → "analyze" (for health)                 │
│ 2. Load current note → { title, path, content }            │
│ 3. Search for context (RAG)                                  │
│    ├─ Embed query → [0.234, -0.567, ...]                    │
│    ├─ Stage 1: Note-level candidates                        │
│    ├─ Stage 2: Block-level chunks                           │
│    └─ Return top 7 related notes                           │
│                                                             │
│ 4. Build system prompt                                      │
│    ├─ Base: "You are Notient..."                            │
│    ├─ Current note: (3000 chars)                            │
│    ├─ Task instructions: "Analyze health and suggest..."     │
│    ├─ Note vitals: { health, links, freshness }             │
│    └─ Related notes: 7 notes × 400 chars                    │
│                                                             │
│ 5. Stream LLM response (LM Studio)                          │
│    POST /v1/chat/completions                                │
│    ├─ System prompt (~2000 chars)                            │
│    ├─ User message ("Analyze the health...")                 │
│    ├─ Temperature: 0.7                                     │
│    ├─ Max tokens: 2000                                     │
│    └─ Stream: true                                         │
│                                                             │
│    Response (streaming):                                    │
│    → "Your note 'Project Alpha' has a health score of 65..." │
│    → "Here are the key areas for improvement:"               │
│    → "1. Freshness: Last updated 3 months ago..."           │
│    → "2. Connectivity: Only 2 links, suggest 5 more..."     │
│    → User sees tokens appear in real-time                    │
│                                                             │
│ 6. Generate action plan (if applicable)                     │
│    ├─ For "analyze" tasks: Usually no actions               │
│    ├─ For "links" tasks: May suggest link actions           │
│    └─ For "freshness" tasks: May suggest update actions     │
│                                                             │
│ 7. Return result                                            │
│    {                                                        │
│      type: "chat_response",                                 │
│      data: "<LLM analysis>",                                 │
│      citations: ["projects/beta.md"],                      │
│      actions: [] (or suggested actions)                     │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS RESULT                                           │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 💬 Chat Response:                                     │   │
│ │ "Your note 'Project Alpha' has a health score of 65." │   │
│ │                                                       │   │
│ │ Key areas for improvement:                            │   │
│ │ 1. Freshness: Last updated 3 months ago. Consider...   │   │
│ │ 2. Connectivity: Only 2 links. Suggested links:       │   │
│ │    - [[Project Beta]]                                  │   │
│ │    - [[Project Gamma]]                                 │   │
│ │                                                       │   │
│ │ 📚 Citations:                                          │   │
│ │ • [[Project Beta#Status]]                              │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ ⚡ Proposed Actions (if any):                        │   │
│ │                                                       │   │
│ │ [Actions displayed if LLM suggested improvements]     │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
User can:
├─ Continue conversation
├─ Apply suggested actions
└─ Switch back to note view
    ↓
✅ COMPLETE - Metric analyzed and insights provided
```
