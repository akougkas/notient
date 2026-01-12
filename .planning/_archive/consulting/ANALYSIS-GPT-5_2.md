# Notient Beta — Planning + Codebase Archaeology (GPT-5.2)
**Generated:** 2026-01-12  
**Scope:** Exhaustive `.planning/` audit (excluding `__archived_DONT_READ/`) + targeted `src/` verification of implemented reality  
**Primary goal:** Extract historical context (features, decisions, evolution, priorities) and translate it into an **actionable cleanup guide** anchored in what the code actually does today.

---

## Executive summary (what’s true right now)

### The product vision is unusually clear
Across interviews + specs, Notient’s identity and success criteria are consistent:

- **Identity:** “Sentient Notes Platform” delivered as an **Obsidian plugin**, experienced as a **Research Chief of Staff** (White House model).
- **Local-only is non‑negotiable** (Ollama embeddings + LM Studio reasoning; no cloud).
- **Success metric:** CEO’s personal trust to run it on a real vault (not test vault).
- **Priority stack:** Reliability → Context awareness → Personal validation → Community/Research.

### The project is stalled for a very specific reason: “last‑mile integration failures” in the critical loop
The critical loop is:

**Quick Actions / workflows → TaskQueue → agent execution → proposed actions → user review → apply → action history/undo → insights**

The codebase contains most of the pieces, but the **glue between them is inconsistent**, causing the user-visible “it looks wired but doesn’t work” feeling.

The largest concrete breakpoints (verified in `src/`):

1. **Applying actions from Agent Streams is currently broken by design mismatch**
   - UI emits `action:apply-requested` (good), but plugin handler uses `ActionApplier.apply()` instead of `applyConfirmed()`:
     - `src/main.ts` registers handlers and calls `this.actionApplier.apply(actionToApply)` (around L1235).
     - `ActionApplier.apply()` is explicitly a trust-gated preflight; it returns `requiresConfirmation` for low/medium risk by default.
     - Result: clicking “Apply” often yields “Failed: Action requires user confirmation” even though the click *is* the confirmation.

2. **Undo event handling is also incorrect**
   - `ActionHistory.undo()` returns an `UndoResult` object, but `src/main.ts` treats it as boolean (around L1260).
   - This produces wrong notices + optimistic UI drift (UI marks undone even if undo failed).

3. **There are multiple “pending actions” ingestion paths, not one contract**
   - `action:proposed` is emitted by `TaskQueue` (good) and handled by UI to populate `pendingActions` **and** `pendingActionSources`.
   - Separately, UI also injects pending actions when `agent:task-update` completes (double-entry), but does **not** populate `pendingActionSources`.
   - This creates duplication, inconsistent counts, and makes it easy to surface actions that can’t be applied (because the original action object isn’t retained).

4. **Index persistence will hit the V8 string limit on large vaults**
   - `IndexManager.saveIndex()` does `JSON.stringify(data)` on the full persisted index object (embedding arrays included).
   - This is exactly the `RangeError: Invalid string length` failure mode documented in `.planning/ISSUES.md`.

5. **Indexing throughput is still artificially slow**
   - `SimpleIndexer.embedChunks()` batches embeddings but awaits each batch sequentially (no concurrency window).
   - This matches the “8x slower than necessary” Phase 0 issue.

6. **Service health UX is noisy and may cause avoidable UI churn**
   - `HealthMonitor` sets status to `"checking"` each interval then back to `"healthy"`; kernel emits on status changes.
   - UI (`useAppEvents.ts`) treats “not healthy” as “disconnected”, so it flickers connected indicators.

7. **“Capability cards” in Agent Streams are not wired**
   - `AgentStreamsView` supports `capabilities?: Signal<CapabilityStatus[]>`.
   - `App.tsx` doesn’t pass it, so cards always render the default “healthy”.

### The deeper architectural tension: two orchestrators and two “agent systems”
Planning repeatedly asserts “ChiefOfStaff is the brain; agents are tools.” The codebase has:

- **`src/core/agents/*`**: White House multi-agent system (ChiefOfStaff + 3 expert agents + context-builder).
- **`src/core/agent/*`**: the TaskQueue + types + older “agent module” concepts.
- **`src/core/intelligence/*`**: ActionOrchestrator + ActionPipeline + prompt registry (“Intelligence 2.0”).

This isn’t inherently wrong, but it increases integration risk. Right now, **some of this is not wired at all**, e.g. `ActionOrchestrator` is constructed in `main.ts` but not used elsewhere.

---

## Method (what I read and what I verified)

### Planning sources (read exhaustively)
All files under `.planning/` were read, excluding only `.planning/__original_plans/__archived_DONT_READ/*` per instruction.

Key anchors:
- `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/ISSUES.md`
- `.planning/phases/00-foundation-repair/*` and archives
- `.planning/phases/01-agent-architecture/*` and archives
- Interview series under `.planning/interviews/*` (Beta vision, input flow, wiring/UX, Code Red decisions)
- `.planning/ID-MANAGEMENT-AUDIT.md`, `.planning/EVENT_HANDLER_ANALYSIS.md`
- External consultant workflow (`.planning/consulting/*`)

### Source code verification (selected “truth tests”)
I traced the actual runtime chain for:

- Quick Actions → `triggerAgenticAction()` → `taskQueue.enqueue()` → `TaskQueue` execution → emitted events → UI state updates → apply/undo.
- Reranker parsing path (`LLMProvider.rerank` → `lmstudio-sdk.ts`).
- Indexing + persistence (`SimpleIndexer` + `IndexManager` + `HNSWVectorStore`).
- Service health emission + UI interpretation.
- “Insights Stream” implementation vs spec.

---

## Decision timeline (documents + commits)

### 2026‑01‑10: Wiring/UX interview sets concrete UX expectations
Source: `.planning/interviews/interview-notient-wiring-ux-1768077411/*`

- **Quick Actions**: “All 6 should behave the same” (Agent Streams), not mixed chat vs agent.
- **Progressive search**: streaming tiers (instant→evolving), deep opt-in (button + Shift+Enter), deep results mixed chronologically into Insights Stream.
- **Reranker**: model is fine; failures are wiring/integration + parsing.

### 2026‑01‑11: Beta vision “constitution”
Source: `.planning/interviews/notient-beta-vision-1736617200/*`, `.planning/__original_plans/BETA-SPEC.md`

- **Layered identity** and **sequential** tagline as a process.
- **Agents are capabilities, not personas** (explicit correction mid-interview).
- **One codebase** (explicit correction vs earlier “branch split” discussion).
- **Reliability first** (CODE RED justified).

### 2026‑01‑11: CODE RED architecture decisions (parallel fixes)
Source: `.planning/interviews/__past/code-red-architecture-1768122230/decisions.md`

- WASM-only vector store (no Docker sidecar).
- Hooks-based split for App (reject class/controller pattern).
- Error boundaries + App.tsx breakup + vector store migration in parallel.

### 2026‑01‑11 → 2026‑01‑12: Emergency stop → debugging spiral → breakthrough
Source: git history + `.planning/phases/00-foundation-repair/_archive/.continue-here.md`

- `840b176`: EMERGENCY STOP (CPU 100%, UI freeze).
- `eff6f21`: root cause fixed (TaskQueue scheduling loop); **also** SDK migration performed in same commit.
- Multiple “phase-0 paused” commits: reactive debugging cycles with intermittent consolidation.

### 2026‑01‑12: Phase 0 consolidation and planning cleanup
Source: `.planning/phases/00-foundation-repair/PLAN.md`, git commits `f8bc3f6`, `0554894`

- Phase 0 becomes the gate for everything.
- Phase 1 is explicitly paused / re-scoped.

---

## Feature evolution: planned → changed → deferred/cut (grounded in docs + code)

### Agents & orchestration
- **Planned**
  - White House model with ChiefOfStaff orchestrator and a larger roster of capabilities.
  - Chat as UI layer (not a peer agent).
- **Changed**
  - “LinkFinder” renamed/deprecated → “Connection”.
  - Quick Actions model formalized: 3 pinned + 3 contextual.
- **Reality in code**
  - `src/core/agents/types.ts` defines only:
    - UI: `chat`
    - Experts: `note-editor`, `classifier`, `connection`, `context-builder`
  - Workflow-like “agents” exist as Intelligence prompt types under `src/core/intelligence/prompts/*` (atomic, synthesis, clipping, etc.) but the orchestrator (`ActionOrchestrator`) is not wired into the UI flow yet.
  - **Dead code remains**: `src/core/agents/chatAgent.ts` is exported but unused (contradiction with “chat is UI” decision).

### Quick Actions
- **Planned**
  - 3 pinned + 3 contextual, all routed through agent system, visible in Agent Streams.
- **Reality**
  - UI exists and triggers TaskQueue with note context (`src/ui/sidebar/state/appHandlers.ts`).
  - Downstream apply/undo path is broken (see “Reality check: Action pipeline”).

### Progressive Search
- **Planned**
  - Instant results immediately; evolving results stream; deep results land in Insights Stream; cancellable.
- **Reality**
  - `src/core/search/progressiveSearch.ts` implements instant/evolving generator + deepSearch with events.
  - UI adds deep results as “insights” (top 5) but does not implement a per-note persistent chronological stream.

### Insights Stream
- **Planned**
  - Per-note persistent stream (async deep results, agent completions, proactive suggestions).
- **Reality**
  - UI component exists (`src/ui/sidebar/components/InsightStream.tsx`).
  - Data source is currently:
    - `InsightGenerator.generate(noteVitals)` (static heuristics)
    - `agentInsights` signal (global, capped ~5, not per-note, not persisted)
  - Deep search completion in Omnibar adds a handful of entries to `agentInsights`.
  - Agent completion adds a single “View in Agents” insight.
  - This is closer to a **badge+hint area** than the specified “stream”.

---

## Phase progression (what’s done vs what’s actually blocking)

### Phase 0 — “Foundation Repair”
Planning says “0/8 issues resolved” (because it’s a gating list), but source confirms a more nuanced reality:

| Item (Phase 0 plan) | Planning status | Code reality (verified) | Why it still blocks |
|---|---:|---|---|
| Reranker JSON parsing | “NEXT” | `<think>` stripping exists, but JSON extraction uses greedy brace regex in `src/core/llm/providers/lmstudio-sdk.ts` | Still causes silent fallback or “no rankings array” errors in edge outputs |
| action:proposed not emitted | “not started” | Emitted from `TaskQueue.emitProposedActions()` (`src/core/agent/taskQueue.ts`) | UI still double-adds pending actions; contracts are inconsistent |
| Action applier wiring | “not started” | Handlers registered in `src/main.ts` | Handler calls `apply()` not `applyConfirmed()`; undo handler treats `UndoResult` as boolean |
| Action ID mismatch | “not started” | IDs exist but are generated in multiple layers (agents + taskQueue fallback + actionPipeline + actionHistory) | Provenance is weak; multiple “action-*” IDs increase confusion; workflow review queue integration is incomplete |
| Sequential embeddings | “not started” | Still sequential in `SimpleIndexer.embedChunks()` | Directly harms indexing time and perceived quality |
| FS.syncfs race | “not started” | `IndexManager.saveIndex()` persists native index, no in-flight guard | Potential “syncfs in flight” warnings and unnecessary work |
| Dead ChatAgent | “not started” | `src/core/agents/chatAgent.ts` exists, exported, unused | Architectural confusion persists |
| Capability cards | “not started” | `AgentStreamsView` accepts `capabilities`, `App.tsx` doesn’t pass it | UI reports “healthy” regardless of reality |

### Phase 1 — Agent Architecture
The refactors described in Phase 1 plans are mostly present in source, but Phase 1 is not “complete” in the product sense because Phase 0 pipeline isn’t stable.

Notable mismatch: docs speak in “12 agents” language, but `src/core/agents/types.ts` currently defines 4 expert types; the rest of the “capability roster” exists as prompt-based pipelines and is not integrated end-to-end.

### Phases 2–8
Planning directories exist but are empty in repo. Practically, “Phase 2+” work is blocked because Phase 0’s apply/undo/index persistence are unstable.

---

## Reality check: the action pipeline is the heart of the stall

This section is intentionally concrete: it’s the shortest path from “planning says broken” → “here is the exact break in code”.

### Intended contract (from spec + interviews)
1. Agent proposes `ProposedAction[]`.
2. UI shows pending review (risk levels).
3. User clicks Apply.
4. Action applies reliably and logs to history.
5. Undo works and is obvious.

### Actual contract today (from `src/`)

#### 1) Actions are generated (mostly) correctly
- `NoteEditorAgent` validates actions and assigns IDs itself:
  - `src/core/agents/noteEditorAgent.ts` generates `action-${Date.now()}-${random}` IDs.
- `TaskQueue` builds `TaskResult.actions` and emits `action:proposed` for each action:
  - `src/core/agent/taskQueue.ts` `emitProposedActions()` also assigns a fallback ID if missing.

#### 2) Pending actions are ingested twice
UI ingests proposed actions via:

- **Path A (event-driven)**: `action:proposed` → updates `pendingActions` and `pendingActionSources`.
  - `src/ui/sidebar/hooks/useAppEvents.ts` handler for `action:proposed`.
- **Path B (task completion)**: `agent:task-update` completed → `addPendingActions(task.result.actions, ...)`.
  - This does not populate `pendingActionSources`.

This dual ingestion creates duplication and makes it unclear which path is authoritative.

#### 3) “Apply” is wired, but the handler uses the wrong API
`src/main.ts` handles `action:apply-requested` and calls:

- `this.actionApplier.apply(actionToApply)`

But `ActionApplier.apply()` enforces trust checks and returns `requiresConfirmation` for low/medium risk by default.

What should happen instead:
- clicking “Apply” in the Pending Review UI should invoke `applyConfirmed()` (skip the confirmation check because the click is the confirmation).

#### 4) Undo handler misreads return type
`ActionHistory.undo()` returns `{ success: boolean, ... }` but handler checks `if (success)` where `success` is the object.

This causes:
- wrong notices
- optimistic UI drift (Agent Streams marks undone even on failure)

#### 5) Provenance is lost
Even if apply succeeds, the handler does not pass task/workflow IDs to `ActionApplier.apply*()`.
So ActionHistory records often won’t contain `taskId`/`workflowId`, making debugging and trust auditing harder.

---

## Indexing + persistence (the other major stall driver)

### Sequential embeddings remain a hard performance ceiling
`src/core/indexer/simpleIndexer.ts` `embedChunks()` does:

- chunk into `EMBED_BATCH_SIZE` (4)
- `await` `ollama.embedBatch(texts)` **sequentially** for each batch

This matches the Phase 0 diagnosis: pure latency adds up across tens of thousands of chunks.

### Index persistence is structurally risky for large vaults
`src/services/indexManager.ts` `saveIndex()`:

- exports all docs with embeddings in JS arrays
- calls `JSON.stringify(data)` on the entire object

This is the exact failure mode described in `.planning/ISSUES.md` ISSUE‑001:
V8 has a maximum string length; large vaults can exceed it.

Even before hitting the limit, this is a main-thread and memory pressure hotspot.

### HNSW native persistence has no concurrency guard
`IndexManager.saveIndex()` calls `vectorStore.persistNativeIndex`.
`HNSWVectorStore.persistNativeIndex()` does `syncFS → writeIndex → syncFS` without a lock/queue.

If saves overlap, you can get the “syncfs in flight” warning and do extra work.

---

## Health + UX reliability issues that will block “trust”

### HealthMonitor emits “checking” status every interval
`src/services/healthMonitor.ts` explicitly sets status to `"checking"` before each check, then `"healthy"` afterward.

The kernel correctly emits only on status change; however, this pattern guarantees:
- healthy → checking → healthy every cycle
- UI flicker and avoidable re-renders

### UI treats “not healthy” as “disconnected”
`src/ui/sidebar/hooks/useAppEvents.ts` uses `isHealthy = status === "healthy"` and sets connected false otherwise.

So “checking” appears as disconnected.

---

## Contradictions & conflicts (docs vs docs, docs vs code)

### 1) “One codebase” vs `CEO.md` branch structure
- Interview decisions: one codebase, stop over-engineering branch splits.
- `.planning/__original_plans/CEO.md` suggests a branch/worktree hierarchy.
- Interpretation: `CEO.md` is either outdated or refers to internal workflow conventions; it conflicts with the “one codebase” simplification mandate.

### 2) “12 expert agents” language vs actual agent roster
`src/core/agents/types.ts` claims “12 expert agents” in comments but defines 4 expert types.
The “full roster” exists partly as **prompt-driven pipelines** under `src/core/intelligence/prompts/*` and is not end-to-end integrated.

### 3) Phase documentation mismatch
Planning shows phases 02–08 in the roadmap, but those directories are empty in repo.
This creates ambiguity about what is actually intended vs aspirational.

### 4) PRD references older stack elements
PRD describes OpenAI-compatible provider and certain file structure assumptions that have shifted after SDK migration and refactors.

---

## Why the project keeps stalling (senior-engineer diagnosis)

### The stall is not “lack of vision” — it’s “missing contracts”
This codebase is **event-driven** and **DI/service oriented**. That architecture demands strict contracts:

- What events are emitted (and when)?
- Which handler is authoritative for UI state?
- What IDs are canonical for apply/undo?
- Where is provenance stored?

Right now, several key flows have **two competing implementations** (or 80% complete versions), which causes:

- UI shows “Apply” but apply doesn’t apply.
- Undo UI appears but doesn’t reliably reflect reality.
- Insights exist but aren’t a persistent per-note stream.
- Capability cards exist but are never wired.

### The debugging cycle created “mixed commits” and blurred causality
The timeline shows repeated “paused / awaiting logs / consolidate attempts” commits, and `eff6f21` combined a core bugfix with major SDK migration.
That’s understandable during a firefight, but it increases integration risk and makes it harder to know what regressed what.

### Two orchestrators increases integration surface area
ChiefOfStaff + TaskQueue is one orchestration lane.
ActionOrchestrator + ActionPipeline is another lane.
Both may be valid, but without a clear boundary and wiring plan, this doubles the number of systems that can partially work.

---

## Recommended cleanup sequence (minimize risk, maximize unblock)

This is the order I’d use to regain “CEO trust” fastest.

### 0) Establish one “truth loop” and enforce it
Pick one authoritative path for each of:
- pending review population
- apply/undo execution
- history recording

Then delete/disable the secondary path (or convert it into an adapter feeding the primary contract).

### 1) Fix the apply/undo event handlers (Phase 0 unblocker)
- In `src/main.ts`:
  - Apply: call `ActionApplier.applyConfirmed()` for UI-originated apply events.
  - Undo: interpret `UndoResult.success` (and don’t optimistic-mark UI as undone unless success).
- Ensure `taskId` is preserved when applying actions from TaskQueue (provenance).

### 2) Unify pending action ingestion and guarantee `pendingActionSources`
- Either:
  - make `action:proposed` the only path (preferred), or
  - make `agent:task-update` completion path also store sources + dedupe.
- Add dedupe by `action.id` and correct `pendingReviewCount` accounting.

### 3) Fix reranker JSON extraction robustly (use balanced braces)
`lmstudio-sdk.ts` currently uses greedy `\{[\s\S]*\}`.
Reuse the balanced-brace JSON extraction already implemented in `src/core/intelligence/actionPipeline.ts`.

### 4) Fix large-vault persistence (ISSUE‑001)
Stop serializing all embeddings into a single JSON string.
Options (choose one, in increasing complexity):
- split docs into multiple files (shards) + store meta/state separately
- store embeddings in a binary format and index metadata separately
- compress on disk (but avoid in-memory stringify explosion)

### 5) Fix indexing throughput (sequential embeddings)
Implement a bounded concurrency window for `ollama.embedBatch`.
Target: saturate embedding throughput while respecting local service limits.

### 6) Fix health status flapping + wire capability cards
- Don’t downgrade “checking” to disconnected in UI.
- Only emit “checking” when transitioning out of unknown/unhealthy, not on every poll.
- Create a `capabilities` signal and pass to `AgentStreamsView`.

### 7) Remove dead code & reconcile architecture
- Remove unused `src/core/agents/chatAgent.ts` (or intentionally re-integrate it, but current architecture says not to).
- Decide the boundary between:
  - ChiefOfStaff expert agents
  - Intelligence 2.0 pipelines
- Update planning docs to reflect the chosen boundary (reduce contradictions).

### 8) Rebuild Insights Stream to match spec (after stability)
- Make it per-note and persistent.
- Append deep search results chronologically with other insights.
- Treat it as a first-class “background intelligence output channel”, not a static hint list.

---

## Appendix A — Key “ground truth” code pointers

- **Apply handler uses wrong API:** `src/main.ts` `registerActionEventHandlers()` calls `ActionApplier.apply()` (should be `applyConfirmed()`).
- **Undo handler misreads return type:** `src/main.ts` treats `UndoResult` as boolean.
- **Duplicate pending actions ingestion:**
  - `src/ui/sidebar/hooks/useAppEvents.ts`:
    - listens to `action:proposed` (good) **and**
    - on task completion adds actions again (double-entry)
- **Reranker greedy extraction:** `src/core/llm/providers/lmstudio-sdk.ts` uses `cleaned.match(/\{[\s\S]*\}/)`.
- **Sequential embeddings:** `src/core/indexer/simpleIndexer.ts` `embedChunks()` loops batches sequentially.
- **Large index save risk:** `src/services/indexManager.ts` `saveIndex()` calls `JSON.stringify(data)` with embeddings.
- **Capability cards not wired:** `src/ui/sidebar/components/AgentStreamsView.tsx` supports `capabilities`, `src/ui/sidebar/App.tsx` doesn’t provide it.
- **Dead ChatAgent:** `src/core/agents/chatAgent.ts` exported but unused.
- **Action ID generation points:** `src/core/agents/noteEditorAgent.ts`, `src/core/intelligence/actionPipeline.ts`, `src/core/agent/taskQueue.ts` fallback, `src/core/agentic/actionHistory.ts`.

---

## Appendix B — Open questions to resolve before cleanup implementation

These are not blockers for *analysis*, but they matter for implementation:

1. Should low-risk actions auto-apply by default (trust policy), or should the beta ship conservative (manual apply) to protect trust?
2. Is WorkflowRunner intended to be the source of pending review actions, or is `action:proposed` the universal mechanism?
3. Do you want the “13 agents” to remain conceptual (prompts + pipelines), or do you want explicit class/registry parity in `core/agents`?
4. Should deep search results be persisted per note (likely yes) and how should storage scale?

