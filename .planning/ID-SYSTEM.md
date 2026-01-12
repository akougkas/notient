# ID System Architecture

**Status**: Implemented
**Location**: `src/core/ids.ts`

---

## Overview

All entity IDs in Notient follow a standardized format for consistency, traceability, and debugging. The centralized ID generation module ensures all components use the same patterns.

## ID Format

```
{prefix}_{uuid8}
```

- **prefix**: 3-letter type identifier
- **uuid8**: First 8 characters of a UUID v4

Example: `act_9f1a2b3c`, `tsk_12e561b8`, `msg_a7b8c9d0`

---

## ID Prefixes

| Prefix | Type | Persistence | Purpose |
|--------|------|-------------|---------|
| `tsk_` | Task | Ephemeral | User-triggered agent task (Quick Action click) |
| `ins_` | Insight | Persistent | Container grouping actions + suggestions + reasoning |
| `act_` | Action | Persistent | Edit to a note (frontmatter, append, etc.) |
| `sug_` | Suggestion | Persistent | Agent's idea (not yet applied) |
| `rec_` | Record | Derived | Undo record (format: `rec_{actionId}_{timestamp}`) |
| `stm_` | Stream | UI-only | InsightStream line item |
| `msg_` | Message | Persistent | Chat message |
| `wfl_` | Workflow | Ephemeral | Batch operation across multiple notes |
| `ses_` | Session | Ephemeral | Agent execution context |
| `mig_` | Migration | Ephemeral | Data migration operation |

---

## API

### `generateId(prefix: IdPrefix): string`

Generate a new ID with the specified prefix.

```typescript
import { generateId } from "../core/ids";

const taskId = generateId("tsk");     // "tsk_12e561b8"
const actionId = generateId("act");   // "act_9f1a2b3c"
const messageId = generateId("msg");  // "msg_a7b8c9d0"
```

### `deriveRecordId(actionId: string): string`

Derive an undo record ID from an action ID. Used by ActionHistory.

```typescript
import { deriveRecordId } from "../core/ids";

const recordId = deriveRecordId("act_9f1a2b3c");
// "rec_act_9f1a2b3c_1704067200000"
```

### `parseId(id: string): { prefix: IdPrefix; uuid: string } | null`

Parse an ID to extract its components. Returns null if invalid.

```typescript
import { parseId } from "../core/ids";

const parsed = parseId("act_9f1a2b3c");
// { prefix: "act", uuid: "9f1a2b3c" }
```

---

## Usage by Component

### TaskQueue (`src/core/agent/taskQueue.ts`)
- `generateId("tsk")` - Task IDs on enqueue
- `generateId("msg")` - Message IDs for chat history
- `generateId("act")` - Fallback if agent doesn't provide action ID

### Agents (`src/core/agents/*.ts`)
- `generateId("act")` - Action IDs when proposing changes
- Agents SHOULD generate IDs; TaskQueue provides fallback

### ActionHistory (`src/core/agentic/actionHistory.ts`)
- `deriveRecordId(action.id)` - Undo record IDs

### ChatSession (`src/core/chat/session.ts`)
- `generateId("msg")` - All chat message IDs

### WorkflowRunner (`src/core/agentic/workflowRunner.ts`)
- `generateId("wfl")` - Workflow IDs

### ChiefOfStaff (`src/core/agents/chiefOfStaff.ts`)
- `generateId("ses")` - Agent session IDs

### MigrationService (`src/core/importer/migrationService.ts`)
- `generateId("mig")` - Migration operation IDs

### UI Components (`src/ui/sidebar/`)
- `generateId("stm")` - Stream line IDs (useAppEvents.ts, ActivityTrail.tsx)
- `generateId("msg")` - Chat message IDs (appHandlers.ts)

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ TASK (ephemeral: tsk_12e561b8)                                  │
│ - User clicks Quick Action                                      │
│ - Discarded after completion                                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ AGENT produces ACTION (act_9f1a2b3c)                            │
│ - Agent generates ID via generateId("act")                      │
│ - TaskQueue ensures ID exists (fallback)                        │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
          ┌─────────────────┐         ┌─────────────────────┐
          │ UI: Pending     │         │ User Applies        │
          │ Actions         │         │                     │
          └─────────────────┘         └──────────┬──────────┘
                                                 │
                                                 ▼
                              ┌───────────────────────────────────┐
                              │ UNDO RECORD (rec_act_9f1a2b3c_...) │
                              │ - Derived from action.id          │
                              │ - Links back for undo             │
                              └───────────────────────────────────┘
```

---

## Two History Systems

### 1. Undo History (User-facing)
- **Purpose**: Reverse applied actions
- **Scope**: Minimal - only undo data
- **Storage**: `data/actions/hot/current.json`
- **ID**: `rec_` prefix (derived from action)

### 2. Provenance History (Developer)
- **Purpose**: Debugging, research, AI improvement
- **Scope**: Full context - reasoning, inputs, everything
- **Storage**: Logs / intelligence DB
- **ID**: `ins_` prefix (Insight container)

---

## What NOT to Use generateId() For

These use different ID schemes by design:

| Type | ID Pattern | Reason |
|------|------------|--------|
| Note ID | `SHA256(path)` | Content-addressable, deterministic |
| Chunk ID | `{noteId}-{tier}-{hash}` | Hierarchical, deterministic |
| Search ID | `deep-{timestamp}-{random}` | Ephemeral, debugging only |
| File names | `{desc}-{timestamp}.json` | Human-readable, not entity IDs |

---

## Adding New ID Types

1. Add prefix to `IdPrefix` type in `src/core/ids.ts`
2. Update regex in `parseId()` function
3. Document in this file
4. Use `generateId("prefix")` in code

---

## Migration Notes

- All `crypto.randomUUID()` calls for entity IDs migrated to `generateId()`
- File names and temporary identifiers intentionally use different patterns
- Batch IDs in actionPipeline.ts (`batch-create`, etc.) are intentional static identifiers for dependency resolution
