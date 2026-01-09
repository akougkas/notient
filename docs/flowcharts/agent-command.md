# Complete Flow: Agent Command Execution (@chat, @search)

**End-to-end journey from agent command to task execution**

```
User types "@chat summarize this note" in omnibar
    ↓
User presses Enter
    ↓
┌─────────────────────────────────────────────────────────────┐
│ COMMAND PARSING                                              │
│                                                             │
│ 1. Detect agent command                                     │
│    ├─ Input: "@chat summarize this note"                    │
│    ├─ Pattern: /^@(\w+)\s*(.*)/                            │
│    └─ Match: ["@chat", "chat", "summarize this note"]       │
│                                                             │
│ 2. Extract agent type and task                              │
│    ├─ Agent type: "chat"                                    │
│    ├─ Task description: "summarize this note"              │
│    └─ Valid agents: ["chat", "search", "context", ...]     │
│                                                             │
│ 3. Validate agent type                                      │
│    ├─ If invalid: Default to "chat"                         │
│    └─ If no task: Show error notice                          │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ TASK ENQUEUE                                                 │
│                                                             │
│ 1. Create AgentTask                                         │
│    {                                                        │
│      agent: "chat",                                         │
│      notePath: "projects/alpha.md" (current note),          │
│      noteTitle: "Project Alpha",                            │
│      chatHistory: [                                         │
│        {                                                    │
│          role: "user",                                      │
│          content: "summarize this note"                     │
│        }                                                    │
│      ]                                                      │
│    }                                                        │
│                                                             │
│ 2. Enqueue to AgentTaskQueue                                │
│    ├─ Add task to queue                                      │
│    ├─ If queue empty: Start processing                       │
│    └─ Emit event: "agent:task-update"                       │
│                                                             │
│ 3. Show notice: "Task sent to chat agent"                   │
│ 4. Clear omnibar input                                       │
│ 5. Switch to agents view                                    │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (Phase 4)                                    │
│                                                             │
│ 1. Process task from queue                                  │
│    ├─ Update status: "running"                              │
│    ├─ Set progress: 0%                                      │
│    └─ Emit update event                                    │
│                                                             │
│ 2. Task inference                                           │
│    ├─ Query: "summarize this note"                           │
│    ├─ Infer task type: "chat" (general)                      │
│    └─ No specific action plan needed                         │
│                                                             │
│ 3. Load current note                                        │
│    ├─ Read file: projects/alpha.md                          │
│    └─ Extract: { title, path, content }                       │
│                                                             │
│ 4. Search for context (RAG)                                  │
│    ├─ Embed query → [0.234, -0.567, ...]                    │
│    ├─ Stage 1: Note-level candidates                          │
│    ├─ Stage 2: Block-level chunks                           │
│    └─ Return top 7 related notes                            │
│                                                             │
│ 5. Build system prompt                                      │
│    ├─ Base: "You are Notient..."                            │
│    ├─ Current note: (3000 chars)                            │
│    ├─ Task instructions: General chat instructions            │
│    └─ Related notes: 7 notes × 400 chars                  │
│                                                             │
│ 6. Stream LLM response (LM Studio)                          │
│    POST /v1/chat/completions                                │
│    ├─ System prompt (~1500 chars)                            │
│    ├─ User message ("summarize this note")                  │
│    ├─ Temperature: 0.7                                     │
│    ├─ Max tokens: 2000                                      │
│    └─ Stream: true                                         │
│                                                             │
│    Response (streaming):                                    │
│    → "Here's a summary of 'Project Alpha':"                │
│    → "This note describes an active project..."            │
│    → User sees tokens appear in real-time                  │
│                                                             │
│ 7. Update progress during streaming                        │
│    ├─ Progress: 40% → 90% (based on response length)        │
│    └─ Emit progress events                                 │
│                                                             │
│ 8. Complete task                                            │
│    ├─ Add assistant response to chat history                 │
│    ├─ Update status: "completed"                            │
│    ├─ Set progress: 100%                                    │
│    ├─ Persist to ConversationStore                           │
│    └─ Emit update event                                    │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS RESULT                                           │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ Agent Activity Log                                     │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ 💬 Chat Assistant                                │   │   │
│ │ │ Project Alpha                                    │   │   │
│ │ │ Just now                                         │   │   │
│ │ │                                                   │   │   │
│ │ │ Status: completed                                 │   │   │
│ │ └─────────────────────────────────────────────────┘   │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ User clicks task → Opens TaskModal                           │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ Task Modal                                             │   │
│ │                                                       │   │
│ │ User: summarize this note                              │   │
│ │                                                       │   │
│ │ Assistant:                                            │   │
│ │ Here's a summary of 'Project Alpha':                   │   │
│ │                                                       │   │
│ │ This note describes an active project focused on...   │   │
│ │                                                       │   │
│ │ 📚 Citations:                                         │   │
│ │ • [[Project Beta#Overview]]                           │   │
│ │                                                       │   │
│ │ [Continue conversation...]                            │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
User can:
├─ Continue conversation in TaskModal
├─ Apply any proposed actions
└─ Close modal
    ↓
✅ COMPLETE - Agent task executed and displayed
```
