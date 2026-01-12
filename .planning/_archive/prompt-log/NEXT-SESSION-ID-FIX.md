# Next Session: ID Architecture Implementation

**Priority**: P0 - Foundation for all agent features
**Estimated Effort**: 4-6 hours
**Prerequisites**: Read this entire document

---

## Context from CEO Interview

### Terminology Clarified

| Term | Meaning | ID Persistence |
|------|---------|----------------|
| **Task** | User trigger (Quick Action click) | **Ephemeral** - runtime only |
| **Insight** | Container: Actions + Suggestions + reasoning | **Persistent** |
| **Action** | Edit to a note (frontmatter, append) | **Persistent** - for undo |
| **Suggestion** | Agent's idea (not applied) | **Persistent** - for history |
| **Insight Stream 1-liner** | Summary in Note Vitals UI | **Own ID** |

### Two History Systems (CRITICAL)

1. **Undo History (User-facing)**
   - Purpose: Reverse actions
   - Scope: **Minimal** - only what's needed to undo
   - Storage: `actions/hot/current.json`

2. **Provenance History (Developer)**
   - Purpose: Debugging, research, AI improvement
   - Scope: **Full context** - reasoning, inputs, everything
   - Storage: Logs / intelligence DB

### Key Principle

> "For undo, users only see undo - minimal. Developers see history of everything."

---

## Current State (from Codebase Audit)

### ID Generation Points Found

| ID Type | Location | Pattern | Issue |
|---------|----------|---------|-------|
| Task ID | `agent/taskQueue.ts:96` | `crypto.randomUUID()` | ✓ OK |
| Note ID | `indexer/simpleChunker.ts:14` | `SHA256(path)` | ✓ OK |
| Chunk ID | `indexer/tieredSemanticChunker.ts:74` | `{noteId}-{tier}-{hash}` | ✓ OK |
| Workflow ID | `agentic/workflowRunner.ts:89` | `crypto.randomUUID()` | ✓ OK (ephemeral) |
| Message ID | `chat/session.ts:36,57,77` | `crypto.randomUUID()` | ✓ OK |
| Action ID | `agents/noteEditorAgent.ts:182` | `action-${Date.now()}-...` | ⚠️ Agent generates |
| Action ID | `intelligence/actionPipeline.ts:599` | `${prefix}-${Date.now()}-...` | ⚠️ Agent generates |
| Record ID | `agentic/actionHistory.ts:132` | `action-${Date.now()}-...` | ⚠️ Different from action.id |
| Search ID | `search/progressiveSearch.ts:181` | `deep-${timestamp}-...` | ✓ OK (ephemeral) |

### Identified Gaps

1. **No Insight container type** - Actions/Suggestions not grouped with reasoning
2. **Provenance history doesn't exist** - Only undo history stored
3. **Insight Stream has no ID** - Just UI display, not tracked
4. **Inconsistent ID formats** - Mix of UUID, Date.now, SHA256

---

## Target Architecture

### Data Model

```typescript
// NEW: Insight container (holds agent's complete output)
interface Insight {
  id: string;                    // "ins_{uuid8}"
  timestamp: number;
  agentType: string;

  noteContext: {
    path: string;
    title: string;
  };

  // Agent's output
  reasoning: string;             // Why agent made these decisions
  actions: ProposedAction[];     // Edits (each has own ID)
  suggestions: Suggestion[];     // Ideas (each has own ID)

  // For InsightStream
  summary: string;               // 1-liner displayed in UI
}

// NEW: Suggestion type
interface Suggestion {
  id: string;                    // "sug_{uuid8}"
  content: string;
  relatedNotes?: string[];
  confidence: number;
}

// EXISTING (update): ProposedAction keeps id
interface ProposedAction {
  id: string;                    // "act_{uuid8}" - agent generates
  type: ProposedActionType;
  // ... rest unchanged
}

// EXISTING (update): AppliedActionRecord derives ID
interface AppliedActionRecord {
  id: string;                    // "rec_{actionId}_{timestamp}" - DERIVED
  insightId?: string;            // NEW: link to parent insight
  // ... rest unchanged
}
```

### ID Format Standard

```
{type}_{uuid8}

Prefixes:
- tsk_ = Task (ephemeral)
- ins_ = Insight
- act_ = Action
- sug_ = Suggestion
- rec_ = Undo Record (derived: rec_{actionId}_{timestamp})
- stm_ = Stream line (UI only)
```

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ TASK (ephemeral: tsk_12e561b8)                                  │
│ - User clicks Quick Action                                      │
│ - Runtime lifecycle only                                        │
│ - Discarded after completion                                    │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION                                                 │
│                                                                 │
│ Agent produces INSIGHT (ins_7c3a4d5e):                         │
│ {                                                               │
│   reasoning: "Based on content analysis...",                    │
│   actions: [                                                    │
│     { id: "act_9f1a2b3c", type: "frontmatter_add_tags", ... }  │
│   ],                                                            │
│   suggestions: [                                                │
│     { id: "sug_4d5e6f7a", content: "Consider linking..." }     │
│   ],                                                            │
│   summary: "Added 3 tags, found 2 connections"                  │
│ }                                                               │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
                    ▼                 ▼                 ▼
┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ INSIGHT STREAM       │ │ PENDING ACTIONS  │ │ PROVENANCE LOG       │
│ (stm_8a9b0c1d)      │ │ (act_9f1a2b3c)  │ │ (Developer only)     │
│                      │ │                  │ │                      │
│ Shows: summary       │ │ User: Apply/     │ │ Full context:        │
│ Links to insight     │ │ Dismiss          │ │ - Input              │
│                      │ │                  │ │ - Prompt             │
└──────────────────────┘ └────────┬─────────┘ │ - Reasoning          │
                                  │           │ - Everything         │
                                  │           └──────────────────────┘
                                  │ Apply clicked
                                  ▼
                    ┌─────────────────────────────────────┐
                    │ UNDO HISTORY (User-facing)          │
                    │                                     │
                    │ record.id = rec_act_9f1a2b3c_1736.. │
                    │ Minimal undo data only              │
                    │ Recent Activity shows this          │
                    └─────────────────────────────────────┘
```

---

## Implementation Tasks

### Task 1: Add Insight Type (30 min)

**File**: `src/core/agentic/types.ts`

```typescript
// Add after ProposedAction union

export interface Suggestion {
  id: string;
  content: string;
  relatedNotes?: string[];
  confidence: number;
}

export interface Insight {
  id: string;
  timestamp: number;
  agentType: string;
  noteContext: {
    path: string;
    title: string;
  };
  reasoning: string;
  actions: ProposedAction[];
  suggestions: Suggestion[];
  summary: string;
}
```

### Task 2: Standardize ID Generation (1 hour)

**File**: Create `src/core/ids.ts`

```typescript
/**
 * Centralized ID generation with consistent format
 */

type IdPrefix = "tsk" | "ins" | "act" | "sug" | "rec" | "stm";

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function deriveRecordId(actionId: string): string {
  return `rec_${actionId}_${Date.now()}`;
}

export function parseId(id: string): { prefix: IdPrefix; uuid: string } | null {
  const match = id.match(/^(tsk|ins|act|sug|rec|stm)_(.+)$/);
  if (!match) return null;
  return { prefix: match[1] as IdPrefix, uuid: match[2] };
}
```

**Update agents to use `generateId("act")`**:
- `src/core/agents/noteEditorAgent.ts:182`
- `src/core/intelligence/actionPipeline.ts:599`

### Task 3: Update Agents to Produce Insights (2 hours)

**Principle**: Agent wraps output in Insight container

**File**: `src/core/agents/noteEditorAgent.ts`

```typescript
// In execute() method, wrap output:
const insight: Insight = {
  id: generateId("ins"),
  timestamp: Date.now(),
  agentType: "note-editor",
  noteContext: { path: context.notePath, title: context.noteTitle },
  reasoning: output.reasoning || "",
  actions: validatedActions.map(a => ({ ...a, id: generateId("act") })),
  suggestions: [],
  summary: this.generateSummary(validatedActions),
};

yield { type: "insight", insight };
```

### Task 4: Update Event System (1 hour)

**File**: `src/types/events.ts`

```typescript
// Add new event types
export type EventType =
  // ... existing
  | "insight:created"      // NEW
  | "insight:displayed";   // NEW

export interface InsightCreatedEvent {
  insight: Insight;
  source: string;  // "task:{taskId}" or "workflow:{workflowId}"
}
```

**File**: `src/core/agent/taskQueue.ts`

```typescript
// Replace action:proposed emission with insight:created
private emitInsight(insight: Insight, task: AgentTask): void {
  this.eventBus.emit("insight:created", {
    insight,
    source: `task:${task.id}`,
  });
}
```

### Task 5: Update UI Handlers (1 hour)

**File**: `src/ui/sidebar/hooks/useAppEvents.ts`

```typescript
// Replace action:proposed handler with insight:created
useEventBus("insight:created", (data) => {
  const { insight } = data;

  // Add to InsightStream
  const streamLine = {
    id: generateId("stm"),
    insightId: insight.id,
    text: insight.summary,
    timestamp: new Date(),
  };
  insightStreamLines.value = [streamLine, ...insightStreamLines.value.slice(0, 9)];

  // Add actions to pending
  for (const action of insight.actions) {
    pendingActions.value = [...pendingActions.value, {
      id: action.id,
      insightId: insight.id,
      actionType: action.type,
      targetNote: insight.noteContext.title,
      summary: action.title,
      riskLevel: action.risk,
    }];
    pendingActionSources.value.set(action.id, action);
  }
});
```

### Task 6: Update ActionHistory (30 min)

**File**: `src/core/agentic/actionHistory.ts`

```typescript
// In addRecord(), derive ID from action
addRecord(
  action: ProposedAction,
  insightId: string | undefined,
  ...
): AppliedActionRecord {
  return {
    id: deriveRecordId(action.id),  // Derived, not new
    insightId,                       // Link to parent
    timestamp: Date.now(),
    action,
    // ... rest
  };
}
```

### Task 7: Add Provenance Log (Optional, 1 hour)

**File**: Create `src/core/intelligence/provenanceLog.ts`

```typescript
/**
 * Full audit trail for developers/researchers
 * NOT used for undo - that's ActionHistory
 */
export interface ProvenanceEntry {
  insightId: string;
  timestamp: number;

  trigger: {
    type: "quick-action" | "chat" | "workflow";
    taskId?: string;
  };

  context: {
    notePath: string;
    noteContent?: string;  // Optional snapshot
  };

  execution: {
    agentType: string;
    modelUsed: string;
    promptUsed?: string;
    durationMs: number;
  };

  output: Insight;
}

export class ProvenanceLog {
  async record(entry: ProvenanceEntry): Promise<void> {
    // Append to log file
    // data/logs/provenance-{YYYY-MM}.jsonl
  }
}
```

---

## Validation Checklist

After implementation, verify:

- [ ] Click Quick Action → Agent produces Insight
- [ ] Insight has ID format `ins_{uuid8}`
- [ ] Actions inside Insight have ID format `act_{uuid8}`
- [ ] InsightStream shows summary with its own ID `stm_{uuid8}`
- [ ] Pending Actions shows actions from Insight
- [ ] Apply action → Undo record ID is `rec_{actionId}_{timestamp}`
- [ ] Undo works using action ID
- [ ] Task IDs are NOT persisted anywhere (search logs for `tsk_`)
- [ ] (Optional) Provenance log captures full context

---

## Files to Modify

### Must Change
- `src/core/agentic/types.ts` - Add Insight, Suggestion types
- `src/core/ids.ts` - NEW: Centralized ID generation
- `src/core/agents/noteEditorAgent.ts` - Produce Insight
- `src/core/intelligence/actionPipeline.ts` - Use standardized IDs
- `src/core/agent/taskQueue.ts` - Emit insight:created
- `src/types/events.ts` - Add insight events
- `src/ui/sidebar/hooks/useAppEvents.ts` - Handle insight:created
- `src/core/agentic/actionHistory.ts` - Derive record ID

### Optional
- `src/core/intelligence/provenanceLog.ts` - NEW: Full audit trail

---

## What NOT to Change

1. **Note IDs** (`SHA256(path)`) - Working correctly
2. **Chunk IDs** (`{noteId}-{tier}-{hash}`) - Working correctly
3. **Message IDs** (`crypto.randomUUID()`) - Working correctly
4. **Search IDs** (ephemeral) - Working correctly
5. **Workflow IDs** (ephemeral) - Working correctly

---

## Reference Documents

- `.planning/ID-ARCHITECTURE-SPEC.md` - Full design spec
- `.planning/ID-MANAGEMENT-AUDIT.md` - Initial audit (has wrong assumption about agent IDs)
- `.planning/ANALYSIS-claude.md` - Codebase archaeology

---

## Summary for Next Session

> **Your mission**: Implement the Insight container pattern with standardized IDs.
>
> **Key insight**: Agents DO generate Action IDs (for history/undo). The problem was not having an Insight container to group related outputs, and inconsistent ID formats.
>
> **Two history systems**: Undo (minimal, user-facing) vs Provenance (full, developer).
>
> **ID format**: `{type}_{uuid8}` - `ins_`, `act_`, `sug_`, `rec_`, `stm_`
