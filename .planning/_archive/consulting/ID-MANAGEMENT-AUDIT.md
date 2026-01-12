# ID Management Audit & Design

**Date**: 2026-01-12
**Status**: Analysis Complete, Design Proposed

---

## Executive Summary

ID management is fragmented across 10+ locations with inconsistent formats and ownership violations. The core problem: **agents generate IDs when they should only receive and respond**.

---

## Current State: ID Generation Points

### Task Layer
| Location | ID Type | Format | Issue |
|----------|---------|--------|-------|
| `taskQueue.ts:96` | Task ID | `crypto.randomUUID()` | OK - orchestrator owns |
| `chiefOfStaff.ts:706` | Session ID | `crypto.randomUUID()` | OK - orchestrator owns |
| `workflowRunner.ts:89` | Workflow ID | `crypto.randomUUID()` | OK - orchestrator owns |
| `migrationService.ts:68` | Migration ID | `crypto.randomUUID()` | OK - service owns |

### Action Layer (PROBLEMATIC)
| Location | ID Type | Format | Issue |
|----------|---------|--------|-------|
| `noteEditorAgent.ts:182` | Action ID | `action-${Date.now()}-${random}` | **WRONG** - Agent generates |
| `actionPipeline.ts:599` | Action ID | `${prefix}-${Date.now()}-${random}` | **WRONG** - Converter generates |
| `taskQueue.ts:594` | Action ID | `action-${task.id}-${uuid.slice(0,8)}` | Fallback (my fix) |
| `actionHistory.ts:132` | Record ID | `action-${Date.now()}-${random}` | **Creates NEW ID** |

### UI Layer
| Location | ID Type | Format | Issue |
|----------|---------|--------|-------|
| `appHandlers.ts:208` | User msg ID | `user-${Date.now()}` | UI-only, OK |
| `appHandlers.ts:248` | Assistant msg ID | `assistant-${Date.now()}` | UI-only, OK |
| `useAppEvents.ts:154` | Activity ID | `activity-${Date.now()}` | UI-only, OK |
| `ActivityTrail.tsx:121` | Activity ID | `crypto.randomUUID()` | Inconsistent format |

---

## ID Flow Diagram (Current - Broken)

```
┌─────────────────────────────────────────────────────────────────┐
│                        QUICK ACTION CLICK                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  taskQueue.enqueue()                                             │
│  → Generates: task.id = crypto.randomUUID()  ✓ CORRECT           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ChiefOfStaff.execute()                                          │
│  → Creates session.id = crypto.randomUUID()  ✓ CORRECT           │
│  → Routes to expert agent                                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  NoteEditorAgent.execute()                                       │
│  → LLM generates JSON without IDs                                │
│  → validateActions() GENERATES action.id  ✗ WRONG                │
│    Format: action-${Date.now()}-${random}                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  taskQueue.handleCompleteEvent()                                 │
│  → Receives actions WITH IDs already set                         │
│  → My fix: if (!action.id) generate fallback  ✗ REDUNDANT        │
│  → Emits action:proposed event                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  UI receives action:proposed                                     │
│  → Stores ProposedAction with action.id                          │
│  → User clicks Apply                                             │
│  → Emits action:apply-requested { actionId, action }             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ActionApplier.apply()                                           │
│  → Executes action                                               │
│  → Calls actionHistory.addRecord()                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  ActionHistory.addRecord()                                       │
│  → Creates NEW record.id = action-${Date.now()}-${random}        │
│  → record.action = original ProposedAction (keeps action.id)     │
│  ✗ NOW WE HAVE TWO IDs: record.id ≠ record.action.id             │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Problem

### 1. Agent Generates IDs (Violates Orchestration Principle)

**Current**: `noteEditorAgent.ts:182`
```typescript
const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
```

**Why Wrong**:
- Agents should be pure transformers: input → output
- Agents don't know about task context, workflow context, session context
- ID generation is orchestration responsibility

### 2. AppliedActionRecord Has Different ID Than ProposedAction

```typescript
// ProposedAction (from agent)
{ id: "action-1736123456789-xyz", type: "frontmatter_add_tags", ... }

// AppliedActionRecord (from actionHistory)
{
  id: "action-1736123456999-abc",  // NEW ID!
  action: { id: "action-1736123456789-xyz", ... }  // Original action inside
}
```

**Why Wrong**:
- UI references `action.id` to apply
- UI references `record.id` to undo
- These are DIFFERENT IDs → confusion

### 3. No Provenance Chain

```
Which task produced this action?
Which workflow triggered this task?
Which session started this workflow?
```

Currently impossible to trace without searching logs.

### 4. Inconsistent ID Formats

- `crypto.randomUUID()` → `"12e561b8-7c3a-4d5e-9f1a-2b3c4d5e6f7a"`
- `action-${Date.now()}-${random}` → `"action-1736123456789-xyz123"`
- `activity-${Date.now()}` → `"activity-1736123456789"`

---

## Proposed Design: Hierarchical ID System

### Principle: Orchestrator Owns All IDs

```
Session (ChiefOfStaff)
  └── Task (taskQueue)
        └── Action (taskQueue, NOT agent)
              └── Record (actionHistory, references action.id)
```

### ID Format: Structured, Traceable

```typescript
// Session ID
`ses_${crypto.randomUUID().slice(0,8)}`  // ses_12e561b8

// Task ID (includes session)
`tsk_${sessionId}_${crypto.randomUUID().slice(0,8)}`  // tsk_ses_12e561b8_7c3a4d5e

// Action ID (includes task)
`act_${taskId.slice(4)}_${index}`  // act_ses_12e561b8_7c3a4d5e_0

// Record ID (references action)
`rec_${actionId}_${timestamp}`  // rec_act_ses_12e561b8_7c3a4d5e_0_1736123456789
```

### Implementation Changes

#### 1. Create Central ID Factory

```typescript
// src/core/ids.ts
export class IdFactory {
  private sessionId: string | null = null;

  startSession(): string {
    this.sessionId = `ses_${crypto.randomUUID().slice(0, 8)}`;
    return this.sessionId;
  }

  createTaskId(): string {
    if (!this.sessionId) throw new Error("No active session");
    return `tsk_${this.sessionId}_${crypto.randomUUID().slice(0, 8)}`;
  }

  createActionId(taskId: string, index: number): string {
    return `act_${taskId.replace("tsk_", "")}_${index}`;
  }

  createRecordId(actionId: string): string {
    return `rec_${actionId}_${Date.now()}`;
  }

  // Parse helpers
  parseActionId(actionId: string): { sessionId: string; taskId: string; index: number } | null { ... }
}

export const ids = new IdFactory();
```

#### 2. Remove ID Generation from Agents

```typescript
// noteEditorAgent.ts - REMOVE line 182
// BEFORE:
const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// AFTER: Return action WITHOUT id, let orchestrator assign
validActions.push({
  // id: REMOVED - orchestrator will assign
  type: actionType,
  risk: RISK_MAP[actionType] || "medium",
  ...
} as ProposedAction);
```

#### 3. Orchestrator Assigns Action IDs

```typescript
// taskQueue.ts - handleCompleteEvent or emitProposedActions
private emitProposedActions(actions: ProposedAction[], task: AgentTask): void {
  actions.forEach((action, index) => {
    // Orchestrator assigns ID with provenance
    action.id = ids.createActionId(task.id, index);

    this.eventBus.emit("action:proposed", {
      action,
      noteContext: { ... },
      source: `task:${task.id}`,
    });
  });
}
```

#### 4. Record References Original Action ID

```typescript
// actionHistory.ts
addRecord(action: ProposedAction, ...): AppliedActionRecord {
  return {
    id: ids.createRecordId(action.id),  // Derived from action ID
    timestamp: Date.now(),
    taskId: ids.parseActionId(action.id)?.taskId,  // Extract provenance
    action,  // Original action preserved
    ...
  };
}
```

---

## Migration Path

### Phase 1: Add IdFactory (Non-Breaking)
- Create `src/core/ids.ts`
- Register in Kernel
- Start using for new ID generation points

### Phase 2: Migrate Task/Session IDs
- Update `taskQueue.enqueue()` to use `ids.createTaskId()`
- Update `chiefOfStaff.createSession()` to use `ids.startSession()`

### Phase 3: Fix Action ID Ownership
- Remove ID generation from `noteEditorAgent.ts`
- Remove ID generation from `actionPipeline.ts`
- Consolidate in `taskQueue.emitProposedActions()`

### Phase 4: Update ActionHistory
- Change `addRecord()` to derive ID from action ID
- Add `taskId` field extraction

### Phase 5: UI Alignment
- Ensure UI uses consistent ID references
- Add provenance display in Agent Streams view

---

## Immediate Fix (Revert My Patch)

My earlier fix added ID generation in `taskQueue.ts:594`. This is wrong because:
1. It duplicates logic that exists in agents
2. It masks the real problem (agents generating IDs)

**Recommendation**:
- Remove my fix (`action.id = ...` in emitProposedActions)
- Keep the event emission (that part is correct)
- The agent-generated IDs will work for now
- Implement proper fix in Phase 3

---

## Summary

| What | Current Owner | Should Be |
|------|---------------|-----------|
| Session ID | ChiefOfStaff | ChiefOfStaff via IdFactory |
| Task ID | taskQueue | taskQueue via IdFactory |
| Action ID | **Agent (wrong)** | taskQueue via IdFactory |
| Record ID | actionHistory | actionHistory derived from action.id |
| UI IDs | UI components | UI components (separate namespace) |

**Core Principle**: Agents receive context, produce output. Orchestrator handles identity.
