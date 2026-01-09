# Complete Flow: Slash Command Execution (/enrich, /link, /classify)

**End-to-end journey from slash command to bulk workflow**

```
User types "/enrich vault" in omnibar
    ↓
User presses Enter
    ↓
┌─────────────────────────────────────────────────────────────┐
│ COMMAND PARSING                                              │
│                                                             │
│ 1. Parse slash command                                      │
│    ├─ Input: "/enrich vault"                                │
│    ├─ Parse: parseSlashCommand(input)                       │
│    └─ Result:                                              │
│       {                                                     │
│         command: "enrich",                                  │
│         scope: "vault",                                     │
│         target: ""                                          │
│       }                                                     │
│                                                             │
│ 2. Validate command                                         │
│    ├─ Valid commands: ["enrich", "link", "classify"]        │
│    └─ Valid scopes: ["vault", "folder"]                     │
│                                                             │
│ 3. Resolve target notes                                     │
│    ├─ Scope: "vault" → All markdown files                   │
│    ├─ Scope: "folder" → Files in folder                     │
│    └─ Filter: Only .md files                               │
│                                                             │
│ 4. Apply limits                                             │
│    ├─ Max notes per workflow: 50 (configurable)              │
│    └─ If exceeded: Limit and warn                           │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ WORKFLOW CREATION                                            │
│                                                             │
│ 1. Create WorkflowSpec                                     │
│    {                                                        │
│      id: crypto.randomUUID(),                              │
│      command: "enrich",                                     │
│      scope: "vault",                                        │
│      targets: ["note1.md", "note2.md", ...],                │
│      createdAt: Date.now(),                                 │
│      delayBetweenTasksMs: 1000                              │
│    }                                                        │
│                                                             │
│ 2. Create WorkflowRun                                       │
│    {                                                        │
│      id: spec.id,                                          │
│      spec,                                                  │
│      status: "queued",                                      │
│      progress: {                                            │
│        total: 50,                                           │
│        completed: 0,                                        │
│        failed: 0                                            │
│      },                                                     │
│      reviewQueue: [],                                       │
│      errors: []                                             │
│    }                                                        │
│                                                             │
│ 3. Add to workflow queue                                    │
│ 4. Emit event: "workflow:started"                          │
│ 5. Show notice: "Started enrich workflow on vault (50 notes)"│
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ WORKFLOW PROCESSING                                          │
│                                                             │
│ 1. Process next workflow                                    │
│    ├─ Check if workflow queue has items                     │
│    └─ Start processing first workflow                        │
│                                                             │
│ 2. Update status: "running"                                 │
│ 3. For each target note:                                    │
│    ├─ Create AgentTask                                      │
│    │  {                                                     │
│    │    agent: "chat",                                      │
│    │    notePath: "note1.md",                               │
│    │    noteTitle: "Note 1",                                │
│    │    chatHistory: [                                      │
│    │      {                                                 │
│    │        role: "user",                                   │
│    │        content: "Enrich and expand 'Note 1'..."         │
│    │      }                                                 │
│    │    ]                                                   │
│    │  }                                                     │
│    │                                                        │
│    ├─ Execute agent task                                    │
│    │  ├─ Task inference → "enrich"                          │
│    │  ├─ Load note content                                  │
│    │  ├─ Search for context                                 │
│    │  ├─ Build system prompt                                │
│    │  ├─ Stream LLM response                                │
│    │  └─ Generate action plan                               │
│    │                                                        │
│    ├─ Collect proposed actions                              │
│    ├─ Validate actions                                      │
│    ├─ Check trust levels                                    │
│    │                                                        │
│    ├─ If actions require confirmation:                      │
│    │  └─ Add to reviewQueue                                 │
│    │                                                        │
│    ├─ If actions auto-apply (LOW risk):                     │
│    │  └─ Apply immediately                                  │
│    │                                                        │
│    ├─ Update progress                                       │
│    │  ├─ completed++                                        │
│    │  └─ Emit "workflow:progress"                           │
│    │                                                        │
│    └─ Delay between tasks (1000ms)                          │
│                                                             │
│ 4. Handle errors                                            │
│    ├─ If task fails:                                        │
│    │  ├─ failed++                                           │
│    │  ├─ Log error                                          │
│    │  └─ Continue to next note                            │
│                                                             │
│ 5. Complete workflow                                        │
│    ├─ Update status: "completed"                            │
│    ├─ Emit event: "workflow:completed"                      │
│    └─ Show notice: "Workflow complete: 48/50 processed"     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI DISPLAYS PROGRESS                                         │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ Active Workflows                                       │   │
│ │                                                       │   │
│ │ ┌─────────────────────────────────────────────────┐   │   │
│ │ │ ⚡ /enrich on vault                              │   │   │
│ │ │ Status: running                                  │   │   │
│ │ │                                                   │   │   │
│ │ │ Progress: ████████████░░░░░░░░ 48/50            │   │   │
│ │ │                                                   │   │   │
│ │ │ [Cancel]  [2 pending review]                     │   │   │
│ │ └─────────────────────────────────────────────────┘   │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
    ↓
If review queue has items:
├─ User clicks "X pending review"
├─ Opens Dashboard view
└─ User reviews and applies actions
    ↓
✅ COMPLETE - Workflow executed on all notes
```
