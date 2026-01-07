# Phase 2: AGENTIC — Trust Levels, Bulk Operations, Undo, Persistence (Implementation Prompt)
 
> **For Cursor / AI Coding Agent**
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
 
Important Phase 1 behavior that must remain true:
- **Local-only**: no cloud model APIs, no telemetry.
- **Sequential execution**: one agent task at a time.
- **Streaming**: token-by-token streaming for assistant responses.
- **Cancel discards partial**: if cancelled, do not keep partial assistant content.
- **LLM context window**: last ~10 messages sent to LLM.
 
## Problem Statement (What Phase 2 Adds)
 
Phase 2 turns Notient from “chat about notes” into “agentic operations with user control”:
- **Trust levels**: low/medium/high risk actions with appropriate gating.
- **Action application**: agent can propose edits and (when allowed) apply them to notes/folders.
- **Universal undo**: every applied action is reversible (within practical limits).
- **Bulk operations**: omnibar slash commands to run workflows on a folder or the vault.
- **Workflow runner**: note/folder/vault scope runs with progress + cancel.
- **Conversation persistence across sessions**: chats survive restart (without persisting the whole activity stream, unless explicitly chosen).
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
 
### 1) Trust model (action-level, not “agent-level”)
Risk is determined per proposed action:
 
| Risk | Example actions | Default behavior |
|------|------------------|------------------|
| **Low** | Add tags, set frontmatter fields, append section | **Auto-apply allowed** (user setting) + always undoable |
| **Medium** | Move notes, create links across notes | **Requires confirmation** (1-click approve) |
| **High** | Merge notes, archive/trash/delete | **Requires explicit confirm** (extra friction) |
 
### 2) Undo philosophy
- Do **not** rely on Obsidian editor undo.
- Maintain an **Action History** with enough “before” data to revert.
- Undo should be **single-click** for low/medium actions and **extra-confirmed** for high-risk.
 
### 3) “Propose → Review → Apply”
- The LLM produces **structured proposed actions** (JSON) plus a human-readable explanation.
- The UI shows:
  - assistant explanation (streaming)
  - proposed actions list (structured)
  - apply controls gated by trust settings + write-lock availability
 
### 4) Persistence scope
- Persist **conversations** (chat) across sessions.
- Keep **activity stream/tasks** session-only by default (Phase 1 decision), unless Phase 2 explicitly introduces optional persistence later.
 
### 5) Bulk operations
- Bulk is driven by omnibar **slash commands** (e.g. `/enrich folder:inbox`).
- Bulk runs are represented as **Workflows** that enqueue many tasks but still execute **sequentially**.
- Bulk workflows must support:
  - progress + ETA-ish feedback
  - cancel workflow (cancels current task + clears remaining)
  - post-run review queue for medium/high actions
 
## Current Code Reality (Audit Highlights)
 
- `NotientAgent` currently **always returns** `TaskResult.type = "chat"` and `TaskResult.data = string`.
- `AgentTaskQueue` stores per-task `chatHistory: ChatMessage[]` and pushes the assistant response into it.
- `TaskModal` uses `ChatSession`, but renders from `task.chatHistory` and currently only persists in memory.
- `ObsidianFacade` lacks write methods (no modify/process/rename/trash/frontmatter ops).
- `Kernel` already has: `storagePaths`, `vaultLock`, `obsidian`, `eventBus`, and service registry.
 
Phase 2 must work within these seams.
 
---
 
## Target Phase 2 Architecture Additions
 
Add **agentic services** while keeping Phase 1.8 boundaries:
 
```
src/core/
├── agent/                 # LLM harness (extend to produce action plans)
├── chat/                  # ChatSession (add persistence)
├── agentic/               # NEW: trust, actions, workflows
│   ├── types.ts
│   ├── trustLevelManager.ts
│   ├── actionPlanner.ts
│   ├── actionApplier.ts
│   ├── actionHistory.ts
│   ├── workflowRunner.ts
│   └── commandParser.ts
└── ...
```
 
### Storage layout (plugin folder)
Under `{vaultRoot}/.obsidian/plugins/notient/`:
 
```
conversations.json          # Per-note chat history (persisted)
actions.json                # Action history + undo records
workflows.json              # Optional: persisted workflow run summaries (optional in Phase 2)
```
 
Use `Plugin.loadData()/saveData()` for settings, but for larger stores prefer explicit files under `StoragePaths.pluginRoot` (same pattern as indexing state). Keep schemas versioned.
 
---
 
## Data Model (Define These Types First)
 
Create `src/core/agentic/types.ts`:
 
### Trust & gating
- `export type RiskLevel = "low" | "medium" | "high";`
- `export interface TrustPolicy { autoApplyLowRisk: boolean; requireConfirmMediumRisk: boolean; requireConfirmHighRisk: boolean; }`
- `export interface TrustDecision { allowed: boolean; requiresConfirmation: boolean; requiresDangerConfirm: boolean; reason?: string }`
 
### Proposed actions (LLM output)
Keep actions small and composable; prefer file-scoped operations.
 
- `export type ProposedActionType =`
  - `"frontmatter_set"`
  - `"frontmatter_add_tags"`
  - `"append_markdown_section"`
  - `"insert_wikilinks"`
  - `"move_note"`
  - *(defer merge/trash/delete to later, but reserve types for schema stability)*
 
- `export interface ProposedActionBase {`
  - `id: string;`
  - `type: ProposedActionType;`
  - `risk: RiskLevel;`
  - `title: string;` *(short)*
  - `reason: string;`
  - `targets: { paths: string[] };`
  - `preview?: { beforeSnippet?: string; afterSnippet?: string };`
  - `confidence?: number;` *(0–1, optional)*
  - `requiresWriteLock: boolean;`
`}`
 
Define payloads per action type with discriminated unions (e.g., `frontmatter_set` has `{ key, value }`; `move_note` has `{ from, to }`).
 
### Action results / undo records
- `export interface AppliedActionRecord {`
  - `id: string;`
  - `timestamp: number;`
  - `workflowId?: string;`
  - `taskId?: string;`
  - `action: ProposedAction;`
  - `changedPaths: string[];`
  - `undo: UndoPayload;` *(type-specific, must be sufficient to revert)*
`}`
 
`UndoPayload` should at minimum support:
- **file content restore**: `{ type: "restore_files"; files: Array<{ path: string; before: string; after?: string }> }`
- **move revert**: `{ type: "rename"; from: string; to: string }` (or included in restore_files if you prefer)
 
### Workflow primitives
- `export type WorkflowScope = "note" | "folder" | "vault";`
- `export interface WorkflowSpec { id: string; command: string; scope: WorkflowScope; targets: string[]; createdAt: number; }`
- `export interface WorkflowRun { id: string; spec: WorkflowSpec; status: "queued"|"running"|"paused_for_review"|"completed"|"cancelled"|"failed"; progress: { total: number; completed: number }; startedAt?: number; completedAt?: number; }`
 
---
 
## Settings Changes (Add to Schema + UI)
 
### Settings schema
Extend `src/types/settings.ts` (and migrate in `src/settings.ts`) with:
 
1) `agent` settings
- `trustPolicy` (auto apply low risk, confirm medium/high, default confirm text for high risk)
- `history` (max entries, prune strategy)
- `bulk` (max notes per workflow default, pause-on-medium/high behavior)
 
2) `chat` settings
- `persistenceEnabled: true` *(no opt-in toggle; keep always-on)*
- `perNoteRetention: { maxMessages: number; maxDays?: number }`
 
### Settings UI
Add an “Agentic” section in `src/settings.ts`:
- Trust level behavior toggles
- History retention limits
- Bulk workflow defaults
- Chat retention controls (max messages per note)
 
---
 
## Core Implementation Plan (Phased Milestones)
 
### Milestone 2.0 — Foundations (types, persistence scaffolding, facade write ops)
**Goal:** land the minimum infrastructure without changing user-visible behavior.
 
Deliverables:
1) `src/core/agentic/types.ts`
2) `src/core/chat/persistence.ts` (or `src/services/conversationStore.ts` if you must, but prefer `core/chat/`)
   - keyed by `notePath`
   - uses `StoragePaths.pluginRoot` to read/write `conversations.json`
   - exposes: `load()`, `flush()`, `getSession(notePath): ChatSession`, `append(notePath, msg)`, `prune()`
3) Extend `src/adapters/obsidianFacade.ts` with safe write operations:
   - `processFile(path, (data)=>string)` via `vault.process`
   - `modifyFile(path, content)` via `vault.modify` (only when you already have the content)
   - `renameFile(from, to)` via `vault.rename`
   - `trashFile(path, localTrash?: boolean)` via vault trash
   - `processFrontMatter(path, updater)` via `app.fileManager.processFrontMatter`
4) Extend `Kernel` service registry for new services:
   - `conversationStore`
   - `actionHistory`
   - `workflowRunner`
   - `trustLevelManager`
 
Acceptance:
- Build/typecheck/lint pass.
- No UX changes yet.
 
### Milestone 2.1 — Structured “Proposed Actions” (LLM → JSON → UI)
**Goal:** the agent can produce and display a structured plan of actions, but does not apply them yet.
 
Steps:
1) Extend `src/core/agent/types.ts`
   - Add `TaskResult.type = "action_plan"` with `data: { explanation: string; actions: ProposedAction[] }`
   - Extend `AgentStreamEvent` with:
     - `{ type: "actions"; actions: ProposedAction[] }`
2) Update `src/core/agent/promptBuilder.ts` to support a second “planner prompt”
   - Add helper: `buildActionPlanPrompt(params): string` instructing **JSON-only output**
   - Reuse current note + related notes + vault context.
3) Update `src/core/agent/agentLoop.ts`
   - Keep current streaming for explanation.
   - After streaming completes (and not aborted), call `llm.complete(...)` with a **JSON-only** prompt to generate actions.
   - Parse JSON robustly (copy the rerank parser strategy: strip code fences, extract `{...}`, attempt fix-up).
   - Emit `actions` event and finalize `TaskResult` as `action_plan`.
4) Update `src/views/taskModal.ts`
   - Render a new section below chat:
     - “Proposed actions” list with risk badges
     - For now: buttons are disabled or “Coming in Phase 2.2: Apply”
   - Ensure assistant explanation remains readable (do not show raw JSON to user).
 
Acceptance:
- For enrich/link/classify tasks, modal shows a non-empty Proposed Actions list when LM Studio is available.
- If parsing fails, degrade gracefully: show explanation only + an error message (“Couldn’t parse action plan”).
 
### Milestone 2.2 — Apply Low-Risk Actions + Record History + Undo
**Goal:** low-risk actions can be applied automatically or with one click, and always undoable.
 
Steps:
1) Implement `src/core/agentic/actionHistory.ts`
   - Load/flush `actions.json`
   - Append applied records
   - Provide `undo(recordId)` that reverts via stored undo payload
   - Prune by max entries / max age
2) Implement `src/core/agentic/actionApplier.ts`
   - Validate:
     - targets exist
     - markdown files only
     - within vault
   - Enforce write-lock:
     - if `!kernel.hasWriteLock`, refuse applying (but still allow planning)
   - Apply using `ObsidianFacade`:
     - use `Vault.process` for content edits
     - use `processFrontMatter` for tags/frontmatter
   - Record `AppliedActionRecord` with before snapshots sufficient to undo
3) Implement `src/core/agentic/trustLevelManager.ts`
   - Decide gating based on action risk + settings + write lock
4) Wire UI in `TaskModal`
   - “Apply” button for low-risk actions
   - After apply, show “Undo” button and emit `agent:task-update`
5) Add minimal UI to `Dashboard` (temporary) to list last 20 actions and undo (full command center comes later).
 
Acceptance:
- A low-risk action (e.g., add tags/frontmatter) applies correctly and shows up in history.
- Undo restores exact previous state.
- If lock is not held, apply is disabled with an explanation.
 
### Milestone 2.3 — Medium/High Confirmations + Review UX
**Goal:** medium/high actions require explicit user approval with good previews.
 
Steps:
1) Add a “Review” mode in `TaskModal`:
   - Per action: checkbox, preview, risk explanation
   - “Apply selected” button
2) Confirmation gates:
   - Medium: confirm via modal button (“Apply”)
   - High: require user to type a short phrase (e.g., `APPLY`) before enabling apply
3) Expand `ActionApplier` to support medium actions:
   - `move_note` using `vault.rename`
   - `insert_wikilinks` as file content edits (store full before/after for undo)
4) High-risk actions are still **proposal-only** unless you implement strong safeguards and undo payloads.
 
Acceptance:
- Medium actions cannot be applied without confirmation UI.
- Undo works for move + link insertion.
 
### Milestone 2.4 — Bulk Omnibar Commands + Workflow Runner
**Goal:** `/command` in the sidebar omnibar triggers multi-note workflows with progress/cancel and review queue.
 
Steps:
1) Implement `src/core/agentic/commandParser.ts`
   - Parse:
     - `/enrich scope:folder path:1-projects`
     - `/classify scope:vault`
     - `/link scope:folder path:0-inbox`
   - Support shorthand:
     - `/enrich folder:0-inbox`
     - `/enrich vault`
2) Implement `src/core/agentic/workflowRunner.ts`
   - Resolve targets (folder/vault) into note paths using `ObsidianFacade.getMarkdownFiles()`
   - Enqueue tasks into `AgentTaskQueue` sequentially with `workflowId`
   - Track run progress; emit events for UI updates
   - Cancel: cancel current + mark remaining as cancelled
   - Review queue: collect medium/high proposed actions and pause workflow when needed (configurable)
3) Update `src/views/sidebar.ts`
   - Detect omnibar input starting with `/`
   - Render a small inline command suggestion/help (optional)
   - On Enter, start workflow instead of semantic search
   - Show workflow cards in Agent Streams view (status/progress/cancel)
 
Acceptance:
- `/enrich folder:<path>` runs across all notes sequentially, shows progress, and can be cancelled.
- Medium/high actions land in a review queue (even if not applied).
 
### Milestone 2.5 — Dashboard as Command Center (Agents + Workflows + History)
**Goal:** `src/views/dashboard.ts` becomes a tabbed command center.
 
Implement:
- Tabs: **Vitals** | **Agent Actions** | **Index Management**
- Agent Actions tab:
  - Active workflows + controls
  - Pending review queue
  - Action history list with undo
  - Filters: risk level, note, time window
 
Acceptance:
- A user can manage workflows and undo from the dashboard without hunting through task cards.
 
### Milestone 2.6 — Hardening (Safety, performance, migration)
**Goal:** make Phase 2 shippable.
 
Checklist:
- Schema versioning for `actions.json` + `conversations.json`
- Pruning and size bounds (avoid large unbounded plugin data)
- Path normalization and validation
- Robust JSON parsing and failure handling
- Ensure all apply operations are lock-gated and errors are surfaced in UI
- Biome lint / TS strict passes
 
---
 
## Implementation Notes & Pitfalls (Read Before Coding)
 
1) **LLM JSON reliability**
- Always instruct “output ONLY JSON”.
- Implement resilient parsing (strip code fences, extract object, try fix-up).
- Put a hard cap on `actions.length` (e.g., 25 per task, configurable).
 
2) **Undo data size**
- Storing full “before” file content is simplest and most reliable.
- Apply pruning limits (e.g., keep last 200 records) and compress later only if needed.
 
3) **Write lock**
- Kernel already tracks a multi-window lock (`Kernel.hasWriteLock`).
- Applying actions must be disabled without the lock.
 
4) **Don’t break streaming UX**
- Keep streaming for the assistant explanation.
- Generate action JSON via a second non-streaming call after streaming completes.
 
5) **Keep views UI-only**
- Put logic in `core/agentic/*` services; views call into kernel services.
 
---
 
## Manual Test Script (Must Pass Before Calling Phase 2 “Done”)
 
1) **Single-note low-risk**
- Open a note → Quick Action “Enrich” → open TaskModal
- See explanation + proposed actions
- Apply low-risk → verify note updated
- Undo → verify note restored exactly
 
2) **Medium-risk move**
- Trigger classify → proposed move action
- Confirm → note moved
- Undo → note moved back
 
3) **Bulk**
- In omnibar: `/enrich folder:0-inbox`
- Observe workflow progress and ability to cancel
- Ensure medium/high proposals are reviewed, not auto-applied
 
4) **Persistence**
- Chat with a note, close Obsidian, reopen
- Trigger a new task for same note
- Previous conversation context is present (and last 10 are used for LLM)
 
---
 
## Deliverable for This Phase
 
Implement the milestones in order. After each milestone:
- run `bun run build`
- run `bun run lint`
- verify the manual test script items that apply
 
When Phase 2 is complete, update `planning/PRD.md` + `planning/prompts/bootstrap.md` decision logs only if you changed scope/decisions (otherwise leave them).

