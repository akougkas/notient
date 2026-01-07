# Phase 2: AGENTIC — Trust Levels, Bulk Operations, Undo, Persistence (Implementation Prompt)

> **AI Coding Agent**
> You are implementing **Notient Phase 2** in `/home/akougkas/projects/notient`.
> **Do not redesign Phase 1.8 architecture. Extend it.**

## Context (Current State — Phase 1 Complete)

Notient is a **local-only** Obsidian community plugin (desktop/Electron) written in **TypeScript (strict)** and built with **Bun + esbuild + Biome**.

Phase 1 delivered:
- **LLM abstraction** (`src/core/llm/`) using an OpenAI-compatible API (LM Studio).
- **Agent harness** (`src/core/agent/NotientAgent`) that builds prompts + streams responses.
- **Sequential task queue** (`src/core/agent/AgentTaskQueue`) that executes **one task at a time** with cancellation.
- **UI**:
  - `src/views/sidebar.ts`: tabbed sidebar (Note Vitals + Agent Streams) + omnibar semantic search.
  - `src/views/taskModal.ts`: popup modal on activity card click, with chat bubbles and streaming.
  - `src/views/dashboard.ts`: Vault Vitals dashboard (Phase 1).
- **Vault ops wrapper**: `src/adapters/obsidianFacade.ts` (currently **read/open/notice** focused).
- **Session-only activity stream**: tasks live in memory only.
- **Kernel** with `hasWriteLock` getter (line 126-128) that delegates to `VaultLock.isHeld()`.
- **Indexer** with `onFileModify` and `onFileRename` event subscriptions for incremental reindexing.

Important Phase 1 behavior that must remain true:
- **Local-only**: no cloud model APIs, no telemetry.
- **Sequential execution**: one agent task at a time.
- **Streaming**: token-by-token streaming for assistant responses.
- **Cancel discards partial**: if cancelled, do not keep partial assistant content.
- **LLM context window**: last ~10 messages sent to LLM.

## Problem Statement (What Phase 2 Adds)

Phase 2 turns Notient from "chat about notes" into "agentic operations with user control":
- **Trust levels**: low/medium/high risk actions with appropriate gating.
- **Action application**: agent can propose edits and (when allowed) apply them to notes/folders.
- **Universal undo**: every applied action is reversible (within practical limits).
- **Bulk operations**: omnibar slash commands to run workflows on a folder or the vault.
- **Workflow runner**: note/folder/vault scope runs with progress + cancel.
- **Conversation persistence across sessions**: chats survive restart (keyed by note path, with rename handling).
- **Dashboard as command center**: a dedicated UI surface for workflows, review queues, and action history/undo.

## Non‑Negotiables (Constraints)

### Runtime & privacy
- **No cloud APIs**. Only local LM Studio + local/remote-on-LAN Ollama.
- **Desktop-only** (`FileSystemAdapter` is assumed; see `src/services/storagePaths.ts`).

### Engineering constraints
- **Bun-only workflows**: use `bun run build`, `bun run typecheck`, `bun run lint`.
- **No debug cruft**: console-only logging; keep code clean.

### Obsidian API best practices (verify as you implement)
- Prefer **`Vault.process(file, fn)`** for background edits (atomic read→transform→write).
- Avoid manual YAML frontmatter parsing; prefer **`FileManager.processFrontMatter(file, fn)`**.
- Prefer **`trashFile` / vault trash** over hard delete for destructive ops.
- Normalize user paths (`normalizePath`) when accepting folder paths.

## Phase 2 Design Decisions (Follow Exactly)

### 1) Trust model (action-level, not "agent-level")
Risk is determined per proposed action:

| Risk | Example actions | Default behavior |
|------|------------------|------------------|
| **Low** | Add tags, set frontmatter fields, append section | **Auto-apply allowed** (user setting) + always undoable |
| **Medium** | Move notes, append link sections | **Requires confirmation** (1-click approve) |
| **High** | Merge notes, archive/trash/delete | **Requires explicit confirm** (extra friction) |

### 2) Undo philosophy
- Do **not** rely on Obsidian editor undo.
- Maintain an **Action History** with enough "before" data to revert.
- Undo should be **single-click** for low/medium actions and **extra-confirmed** for high-risk.

### 3) "Propose → Review → Apply"
- The LLM produces **structured proposed actions** (JSON) plus a human-readable explanation.
- The UI shows:
  - assistant explanation (streaming)
  - proposed actions list (structured)
  - apply controls gated by trust settings + write-lock availability

### 4) Persistence scope
- Persist **conversations** (chat) across sessions, keyed by **note path**.
- Handle note renames: listen to `obsidian.onFileRename()` and update conversation keys.
- Keep **activity stream/tasks** session-only by default (Phase 1 decision).
- **Always-on**: no toggle for persistence; just retention settings.

### 5) Bulk operations (simplified)
- Bulk is driven by omnibar **slash commands** (e.g. `/enrich folder:inbox`).
- Bulk runs are represented as **Workflows** that enqueue many tasks but still execute **sequentially**.
- Bulk workflows support:
  - progress feedback (X of Y complete)
  - cancel workflow (cancels current task + clears remaining)
  - **continue-on-error** by default (skip failed tasks, log error, keep going)
  - configurable delay between tasks (default: 500ms)
  - **one active workflow at a time** (additional workflows queue)
- Medium/high-risk proposed actions from bulk runs land in a **review queue** (not auto-applied).

### 6) Index consistency
- After applying edits or moves, the existing indexer hooks (`onFileModify`, `onFileRename`) should trigger incremental reindexing.
- Verify this is wired up; if not, emit a `file:modified` event or call `indexer.markDirty(path)`.

## Current Code Reality (Audit Highlights)

- `NotientAgent` currently **always returns** `TaskResult.type = "chat"` and `TaskResult.data = string`.
- `AgentTaskQueue` stores per-task `chatHistory: ChatMessage[]` and pushes the assistant response into it (lines 186-189 in `taskQueue.ts`).
- `TaskModal` uses `ChatSession`, but renders from `task.chatHistory` and currently only persists in memory.
- `ObsidianFacade` lacks write methods (no modify/process/rename/trash/frontmatter ops).
- `Kernel` already has: `storagePaths`, `vaultLock`, `obsidian`, `eventBus`, `hasWriteLock` getter, and service registry.
- Current `AgentStreamEvent` types: `progress`, `chunk`, `citations`, `complete`, `error`.
- `LLMProvider.complete()` currently has **no AbortSignal** support (timeout deferred to Phase 2.5).

Phase 2 must work within these seams.

---

## Target Phase 2 Architecture Additions

Add **agentic services** while keeping Phase 1.8 boundaries:

```
src/core/
├── agent/                 # LLM harness (extend to produce action plans)
├── chat/                  # ChatSession + persistence
│   └── conversationStore.ts   # NEW
├── agentic/               # NEW: trust, actions, workflows
│   ├── types.ts
│   ├── trustLevelManager.ts
│   ├── actionApplier.ts
│   ├── actionHistory.ts
│   ├── workflowRunner.ts
│   └── commandParser.ts
└── ...
```

### Storage layout (plugin folder)
Under `{vaultRoot}/.obsidian/plugins/notient/`:

```
conversations.json          # Per-note chat history (persisted, keyed by note path)
actions.json                # Action history + undo records
```

Use `Plugin.loadData()/saveData()` for settings, but for larger stores prefer explicit files under `StoragePaths.pluginRoot` (same pattern as indexing state). Keep schemas versioned.

---

## Data Model (Define These Types First)

Create `src/core/agentic/types.ts`:

### Trust & gating
```typescript
export type RiskLevel = "low" | "medium" | "high";

export interface TrustPolicy {
  autoApplyLowRisk: boolean;      // Default: false
  requireConfirmMediumRisk: boolean;  // Default: true (always true in Phase 2)
  requireConfirmHighRisk: boolean;    // Default: true (always true)
}

export interface TrustDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresDangerConfirm: boolean;
  reason?: string;
}
```

### Proposed actions (LLM output)
Keep actions small and composable; prefer file-scoped operations.

```typescript
export type ProposedActionType =
  | "frontmatter_set"
  | "frontmatter_add_tags"
  | "append_section"
  | "append_related_links"   // Safe: appends "## Related Notes" section
  | "move_note"
  // Reserved for Phase 3 (schema stability):
  | "merge_notes"
  | "trash_note";

export interface ProposedActionBase {
  id: string;
  type: ProposedActionType;
  risk: RiskLevel;
  title: string;       // Short description (max 50 chars)
  reason: string;      // Why this helps
  target: string;      // Primary note path
  requiresWriteLock: boolean;
}

// Discriminated union for type-specific payloads
export interface FrontmatterSetAction extends ProposedActionBase {
  type: "frontmatter_set";
  payload: { key: string; value: unknown };
}

export interface FrontmatterAddTagsAction extends ProposedActionBase {
  type: "frontmatter_add_tags";
  payload: { tags: string[] };
}

export interface AppendSectionAction extends ProposedActionBase {
  type: "append_section";
  payload: { heading?: string; content: string };
}

export interface AppendRelatedLinksAction extends ProposedActionBase {
  type: "append_related_links";
  payload: { links: string[] };  // Note names to link (appended as "## Related Notes" section)
}

export interface MoveNoteAction extends ProposedActionBase {
  type: "move_note";
  payload: { from: string; to: string };
}

export type ProposedAction =
  | FrontmatterSetAction
  | FrontmatterAddTagsAction
  | AppendSectionAction
  | AppendRelatedLinksAction
  | MoveNoteAction;
```

### Action results / undo records
```typescript
export type UndoPayloadType = "restore_content" | "rename_back";

export interface RestoreContentUndo {
  type: "restore_content";
  files: Array<{ path: string; before: string }>;
}

export interface RenameBackUndo {
  type: "rename_back";
  from: string;  // Current path (after the move)
  to: string;    // Original path (restore to this)
}

export type UndoPayload = RestoreContentUndo | RenameBackUndo;

export interface AppliedActionRecord {
  id: string;
  timestamp: number;
  workflowId?: string;
  taskId?: string;
  action: ProposedAction;
  changedPaths: string[];
  undo: UndoPayload;
}
```

### Workflow primitives (simplified)
```typescript
export type WorkflowScope = "note" | "folder" | "vault";

export interface WorkflowSpec {
  id: string;
  command: string;
  scope: WorkflowScope;
  targets: string[];
  createdAt: number;
  delayBetweenTasksMs: number;  // Default: 500
}

export type WorkflowStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface WorkflowRun {
  id: string;
  spec: WorkflowSpec;
  status: WorkflowStatus;
  progress: { total: number; completed: number; failed: number };
  startedAt?: number;
  completedAt?: number;
  reviewQueue: ProposedAction[];  // Medium/high actions awaiting review
  errors: Array<{ taskId: string; error: string }>;
}
```

### LLM Response Schema (for prompt engineering)
```typescript
// Expected JSON output from action plan prompt
export interface ActionPlanResponse {
  actions: Array<{
    type: ProposedActionType;
    risk: RiskLevel;
    title: string;
    reason: string;
    target: string;
    payload: Record<string, unknown>;
  }>;
}
```

### EventBus events (new)
```typescript
// Add to src/types/events.ts
export interface WorkflowEvents {
  "workflow:started": { workflow: WorkflowRun };
  "workflow:progress": { workflow: WorkflowRun };
  "workflow:completed": { workflow: WorkflowRun };
  "workflow:cancelled": { workflow: WorkflowRun };
  "workflow:failed": { workflow: WorkflowRun; error: string };
}

export interface ActionEvents {
  "action:applied": { record: AppliedActionRecord };
  "action:undone": { recordId: string };
}
```

---

## LLM Output Validation Rules

When parsing LLM action plan output, the `actionApplier` **must enforce**:

1. **Path validation**:
   - All paths normalized via `normalizePath()`
   - Reject paths outside vault root
   - Reject non-`.md` files
   - Reject paths in excluded folders (from settings)

2. **Override untrusted fields**:
   - For `MoveNoteAction`: override `payload.from` with the actual current note path (LLM could hallucinate)
   - For all actions: override `target` with the task's `notePath` if it doesn't match

3. **Constraints**:
   - Max 10 actions per response (reject extras, log warning)
   - Reject unknown action types (fail gracefully, skip action)
   - Reject actions with missing required payload fields

4. **Risk verification**:
   - Verify declared `risk` matches action type (e.g., `move_note` is always medium)
   - Override if LLM declares wrong risk level

---

## LLM Prompt Templates

### Action Plan Prompt (JSON-only mode)

Use this prompt after the streaming explanation completes:

```text
You are an AI assistant analyzing an Obsidian note. Based on the user's request and note content, output ONLY a valid JSON object with proposed actions.

Output format:
{
  "actions": [
    {
      "type": "frontmatter_set" | "frontmatter_add_tags" | "append_section" | "append_related_links" | "move_note",
      "risk": "low" | "medium" | "high",
      "title": "Short description (max 50 chars)",
      "reason": "Why this action helps the user",
      "target": "path/to/note.md",
      "payload": { /* type-specific, see below */ }
    }
  ]
}

Payload formats by type:
- frontmatter_set: { "key": "string", "value": "any" }
- frontmatter_add_tags: { "tags": ["tag1", "tag2"] }
- append_section: { "heading": "Optional Heading", "content": "markdown content" }
- append_related_links: { "links": ["Note Name", "Other Note"] }
- move_note: { "from": "current/path.md", "to": "new/folder/path.md" }

Risk levels (enforced):
- low: frontmatter changes, appending content
- medium: moving notes, appending links
- high: reserved for future (merge, trash)

Rules:
- Output ONLY valid JSON, no explanation or markdown code fences
- Maximum 10 actions per response
- Use note names (not paths) in append_related_links payload
- Paths must be relative to vault root
- If no actions are appropriate, return { "actions": [] }
```

---

## Conversation Persistence Wiring

**Critical**: This section specifies exactly how persistence connects to task execution.

### ConversationStore interface
```typescript
// src/core/chat/conversationStore.ts
interface ConversationStore {
  load(): Promise<void>;                    // Load from disk on startup
  flush(): Promise<void>;                   // Save to disk (debounced)
  
  getHistory(notePath: string): ChatMessage[];
  appendMessage(notePath: string, msg: ChatMessage): void;
  
  handleRename(oldPath: string, newPath: string): void;  // Update key on rename
  prune(): void;                            // Enforce retention limits
}
```

### Wiring into task flow

1. **On task enqueue** (in `AgentTaskQueue.enqueue()`):
   ```typescript
   // Seed chatHistory from persisted conversation
   const persistedHistory = conversationStore.getHistory(task.notePath);
   task.chatHistory = [...persistedHistory, ...task.chatHistory];
   ```

2. **On user message** (when user sends in TaskModal):
   ```typescript
   // After adding to task.chatHistory
   conversationStore.appendMessage(notePath, userMessage);
   ```

3. **On assistant response complete** (in `AgentTaskQueue.executeTask()`):
   ```typescript
   // After pushing assistant message to task.chatHistory
   conversationStore.appendMessage(notePath, assistantMessage);
   ```

4. **On note rename** (via `obsidian.onFileRename()` subscription):
   ```typescript
   conversationStore.handleRename(oldPath, newPath);
   ```

5. **On plugin unload**:
   ```typescript
   await conversationStore.flush();  // Ensure final save
   ```

### Retention settings
```typescript
interface ChatRetention {
  maxMessagesPerNote: number;  // Default: 50
  maxAgeDays: number;          // Default: 30
}
```

---

## Settings Changes (Add to Schema + UI)

### Settings schema
Extend `src/types/settings.ts`:

```typescript
interface AgentSettings {
  trustPolicy: TrustPolicy;
  history: {
    maxEntries: number;      // Default: 200
    maxAgeDays: number;      // Default: 30
  };
  bulk: {
    maxNotesPerWorkflow: number;     // Default: 100
    delayBetweenTasksMs: number;     // Default: 500
  };
}

interface ChatRetention {
  maxMessagesPerNote: number;  // Default: 50
  maxAgeDays: number;          // Default: 30
}
```

### Settings UI
Add an "Agentic" section in `src/settings.ts`:
- Trust level behavior toggle (auto-apply low-risk: yes/no)
- History retention limits (max entries, max age)
- Bulk workflow defaults (max notes, delay)
- Chat retention controls (max messages per note)

---

## Core Implementation Plan (Phased Milestones)

### Milestone 2.0 — Foundations (types, persistence, facade write ops)
**Goal:** land the minimum infrastructure without changing user-visible behavior.

Deliverables:
1) `src/core/agentic/types.ts` — all types defined above
2) `src/core/chat/conversationStore.ts`
   - Keyed by `notePath` (normalized)
   - Uses `StoragePaths.pluginRoot` to read/write `conversations.json`
   - Schema version field for future migrations
   - **Handle note renames**: subscribe to `obsidian.onFileRename()` and update keys
   - Debounced flush (500ms) to avoid excessive writes
3) Extend `src/adapters/obsidianFacade.ts` with safe write operations:
   ```typescript
   interface WriteResult { success: boolean; error?: string }
   
   async processFile(path: string, fn: (data: string) => string): Promise<WriteResult>;
   async modifyFile(path: string, content: string): Promise<WriteResult>;
   async renameFile(from: string, to: string): Promise<WriteResult>;
   async trashFile(path: string, useSystemTrash?: boolean): Promise<WriteResult>;
   async processFrontMatter(path: string, updater: (fm: any) => void): Promise<WriteResult>;
   async createFolderIfNeeded(path: string): Promise<WriteResult>;  // For move_note
   ```
4) Extend `Kernel` service registry for new services:
   - `conversationStore`
   - `actionHistory`
   - `workflowRunner`
   - `trustLevelManager`
5) Wire conversation persistence into task flow (see "Conversation Persistence Wiring" section)

Acceptance:
- Build/typecheck/lint pass.
- Conversations persist across Obsidian restart.
- No other UX changes yet.

### Milestone 2.1 — Structured "Proposed Actions" (LLM → JSON → UI)
**Goal:** the agent can produce and display a structured plan of actions, but does not apply them yet.

Steps:
1) Extend `src/core/agent/types.ts`
   - Add to `TaskResult.type`: `"action_plan"`
   - Add to `TaskResult`: `actions?: ProposedAction[]`
   - Extend `AgentStreamEvent` union with:
     ```typescript
     | { type: "actions"; actions: ProposedAction[] }
     ```
2) Update `src/core/agent/promptBuilder.ts` to support a second "planner prompt"
   - Add helper: `buildActionPlanPrompt(params): string` using the JSON-only template above
   - Reuse current note + related notes + vault context.
3) Update `src/core/agent/agentLoop.ts`
   - Keep current streaming for explanation.
   - After streaming completes (and not aborted), call `llm.complete(...)` with the JSON-only prompt.
   - Parse JSON robustly:
     - Strip markdown code fences if present
     - Extract first `{...}` object
     - Validate against expected schema (see "LLM Output Validation Rules")
     - On parse failure: log error, return empty actions array
   - Emit `{ type: "actions", actions }` event and finalize `TaskResult` as `action_plan`.
4) Update `src/views/taskModal.ts`
   - Render a new section below chat: "Proposed Actions"
   - Each action shows: risk badge (color-coded), title, target path
   - For now: buttons are disabled with tooltip "Coming soon"
   - Ensure assistant explanation remains readable (do not show raw JSON to user).

Acceptance:
- For enrich/link/classify tasks, modal shows a non-empty Proposed Actions list when LM Studio is available.
- If parsing fails, degrade gracefully: show explanation only + an info message ("No actions generated").

### Milestone 2.2 — Apply Low-Risk Actions + Record History + Undo
**Goal:** low-risk actions can be applied automatically or with one click, and always undoable.

Steps:
1) Implement `src/core/agentic/actionHistory.ts`
   - Load/flush `actions.json` (with schema version)
   - Append applied records
   - Provide `undo(recordId)` that reverts via stored undo payload
   - Prune by max entries / max age
2) Implement `src/core/agentic/actionApplier.ts`
   - **Validate** per "LLM Output Validation Rules" section
   - **Enforce write-lock**: if `!kernel.hasWriteLock`, refuse applying
   - Apply using `ObsidianFacade`:
     - `frontmatter_set`/`frontmatter_add_tags`: use `processFrontMatter`
     - `append_section`/`append_related_links`: use `processFile`
   - Record `AppliedActionRecord` with full "before" content for undo
   - Emit `action:applied` event
3) Implement `src/core/agentic/trustLevelManager.ts`
   - Decide gating based on action risk + settings + write lock
4) Wire UI in `TaskModal`
   - "Apply" button for low-risk actions (enabled based on trust policy)
   - After apply, show "Undo" button
   - Emit `agent:task-update` to refresh UI
5) Add minimal UI to `Dashboard` (temporary) to list last 20 actions with undo buttons.

Acceptance:
- A low-risk action (e.g., add tags) applies correctly and shows up in history.
- Undo restores exact previous state.
- If lock is not held, apply is disabled with tooltip explanation.

### Milestone 2.3 — Medium-Risk Confirmations + Move Support
**Goal:** medium-risk actions require explicit user approval with good previews.

Steps:
1) Add confirmation UI in `TaskModal`:
   - Per action: preview (before/after or description), risk badge
   - "Apply" button requires explicit click for medium-risk
2) Expand `ActionApplier` to support medium actions:
   - `move_note`: call `createFolderIfNeeded(parentPath)` then `renameFile(from, to)`
   - `append_related_links`: append `## Related Notes\n- [[Link1]]\n- [[Link2]]` section
   - Store undo payloads (rename_back for moves, restore_content for appends)
3) High-risk actions remain **proposal-only** (shown but not applicable) until Phase 3.

Acceptance:
- Medium actions cannot be applied without confirmation click.
- Undo works for move (note moves back) + link append (content restored).

### Milestone 2.4 — Bulk Omnibar Commands + Workflow Runner
**Goal:** `/command` in the sidebar omnibar triggers multi-note workflows with progress/cancel.

Steps:
1) Implement `src/core/agentic/commandParser.ts`
   - Parse:
     - `/enrich folder:1-projects`
     - `/classify vault`
     - `/link folder:0-inbox`
   - Validate folder exists, vault scope allowed
2) Implement `src/core/agentic/workflowRunner.ts`
   - Resolve targets into note paths via `ObsidianFacade.getMarkdownFiles()` + folder filter
   - Enforce `maxNotesPerWorkflow` limit
   - Enqueue tasks into `AgentTaskQueue` sequentially with `workflowId`
   - Track run progress; emit `workflow:*` events
   - **Delay between tasks**: `setTimeout(delayBetweenTasksMs)` before next enqueue
   - Cancel: abort current task + clear remaining
   - **Continue-on-error**: log failures, keep going
   - Collect medium/high proposed actions into `reviewQueue`
   - **One workflow at a time**: queue additional workflows
3) Update `src/views/sidebar.ts`
   - Detect omnibar input starting with `/`
   - On Enter, start workflow instead of semantic search
   - Show workflow card in Agent Streams view (status/progress/cancel button)

Acceptance:
- `/enrich folder:0-inbox` runs across all notes sequentially, shows progress, and can be cancelled.
- Medium/high actions land in review queue (shown in UI, not auto-applied).
- 500ms delay between tasks is observable.

### Milestone 2.5 — Dashboard as Command Center
**Goal:** `src/views/dashboard.ts` becomes a tabbed command center.

Implement:
- Tabs: **Vitals** | **Agent Actions** | **Index Management**
- Agent Actions tab:
  - Active workflow status + cancel button
  - Review queue (medium/high actions from bulk runs)
  - Action history list with undo buttons
  - Simple filters: by note, by time

Acceptance:
- A user can manage workflows and undo from the dashboard.

### Milestone 2.6 — Hardening
**Goal:** make Phase 2 shippable.

Checklist:
- [ ] Schema versioning for `actions.json` + `conversations.json`
- [ ] Pruning enforced (max entries, max age)
- [ ] Path normalization everywhere
- [ ] Robust JSON parsing with all edge cases handled
- [ ] All apply operations are lock-gated
- [ ] Errors surfaced in UI (not silent failures)
- [ ] Biome lint / TS strict passes
- [ ] Edge cases handled:
  - Note deleted while action pending
  - Note renamed while conversation open (should update key)
  - Workflow cancelled mid-task
  - LLM returns malformed JSON

---

## Implementation Notes & Pitfalls (Read Before Coding)

1) **LLM JSON reliability**
- Always instruct "output ONLY JSON".
- Implement resilient parsing (strip code fences, extract object).
- Cap at 10 actions (reject extras).
- Note: per-task timeout deferred to Phase 2.5+ (requires `LLMProvider` interface changes).

2) **Undo data size**
- Storing full "before" file content is simplest and most reliable.
- Apply pruning limits (200 records default).

3) **Write lock**
- `Kernel.hasWriteLock` already exists.
- Applying actions must be disabled without the lock.

4) **Don't break streaming UX**
- Keep streaming for the assistant explanation.
- Generate action JSON via a second non-streaming call after streaming completes.

5) **Keep views UI-only**
- Put logic in `core/agentic/*` services; views call into kernel services.

6) **Index consistency**
- Existing indexer should already subscribe to `onFileModify`/`onFileRename`.
- Verify this works after apply operations; if not, manually emit event or call `indexer.markDirty()`.

7) **Folder creation**
- `vault.rename()` fails if destination folder doesn't exist.
- Always call `createFolderIfNeeded()` before `renameFile()` for move operations.

---

## Manual Test Script (Must Pass Before Calling Phase 2 "Done")

1) **Conversation persistence**
- Chat with a note, close Obsidian, reopen
- Open TaskModal for same note → previous messages visible
- Last 10 messages sent to LLM for context

2) **Single-note low-risk**
- Open a note → Quick Action "Enrich" → open TaskModal
- See explanation + proposed actions
- Apply low-risk (e.g., add tags) → verify note updated
- Undo → verify note restored exactly

3) **Medium-risk move**
- Trigger classify → proposed move action
- Confirm → note moved (folder created if needed)
- Undo → note moved back

4) **Bulk workflow**
- In omnibar: `/enrich folder:0-inbox`
- Observe workflow progress and ability to cancel
- Verify delay between tasks (should not spam LLM)
- Medium/high proposals land in review queue

5) **Note rename handling**
- Chat with a note, rename the note in Obsidian
- Reopen TaskModal → conversation still there

6) **Error resilience**
- Start bulk workflow, mid-run: LLM returns invalid JSON
- Verify: task fails, workflow continues to next note, error logged

---

## Deliverable for This Phase

Implement the milestones in order. After each milestone:
- run `bun run build`
- run `bun run lint`
- verify the manual test script items that apply

When Phase 2 is complete, update `planning/PRD.md` + `planning/prompts/bootstrap.md` to mark Phase 2 complete and add any new decisions to the decision log.
