# Phase Universe Fix Plan

## Parallel Agent Assignments

### Wave 1: Critical Backend (Archie x2 tasks)

**Task A1: Vector Persistence + Reranker**
- E4: Add save mutex to HNSWVectorStore (prevent "Save already in progress")
- E1: Wire SearchPipeline balanced strategy to use OllamaReranker (SCORE format)
- Remove/bypass LMStudioProvider.rerank() path

**Task A2: JSON Extraction + Payload Normalization**
- E2: Harden WorkerAgent/NoteEditor JSON extraction (strip {{templates}}, handle reasoning blocks)
- E3: Add frontmatter payload normalization (accept `{status: "active"}` → `{key: "status", value: "active"}`)
- B3: Better error messages when validation fails (explain to user why)

### Wave 2: Pipeline Unification (Archie)

**Task A3: Quick Actions + Slash Command Routing**
- [REVIEWER HIGH] Fix classify/connect tasks running wrong workflow
  - taskQueue maps "classifier"/"connection" to "worker" correctly
  - BUT chiefOfStaff.executePrimaryAgent() defaults to "enhance" workflow
  - Fix: Pass targetWorkflow from taskType through to getWorkerAgent()
  - Files: src/core/agent/taskQueue.ts, src/core/agents/chiefOfStaff.ts

- [REVIEWER HIGH] Fix chat slash commands not routed
  - ChatService detects /atomize, /synthesize, /challenge, /extract-tasks
  - BUT planAction() only handles /enhance, /edit, /improve, /classify, /organize, /para, /connect, /link
  - Fix: Extend planAction() to recognize all delegated commands
  - Align: /extract-tasks should map to /tasks workflow
  - Files: src/core/agents/chiefOfStaff.ts

- A2: Remove direct ActionOrchestrator dispatches from context menu
- Route all triggers through ChiefOfStaff/TaskQueue
- E5: Ensure only ChiefOfStaff/TaskQueue emits insight:created

### Wave 3: Agent Output + Error Handling (Archie)

**Task A4: Fix Agent Output Issues** [REVIEWER MEDIUM x4]
- WorkerAgent agentType mislabel: Change `agentType: "note-editor"` → `agentType: "worker"` in parseOutput()
- WorkerAgent silent failure: If JSON parse fails, emit error event (don't return empty data)
- LM Studio reasoning-only: When structured output requested but content empty, try extracting from reasoning
- NoteEditor verification: Decide if executeWithVerification() should be wired or removed

**Task A5: Progressive Search Events** [REVIEWER LOW]
- search:progressive-instant and search:progressive-evolving emitted but no subscribers
- Add handlers in useAppEvents() or remove dead code

### Wave 4: UI Result Flow (Faye)

**Task F1: Result Presentation**
- E6: Verify InsightStream receives insight:created from all paths
- Add "Result ready" notice when agent produces actions
- A5: Wire capability signals to AgentStreamsView (if time permits)

---

## Dependency Graph

```
Wave 1 (parallel):
  [A1: Vector + Reranker] ──┐
                            ├── Wave 2: [A3: Pipeline Unify] ── Wave 3: [F1: UI Flow]
  [A2: JSON + Payloads]  ───┘
```

Wave 1 tasks are independent. Wave 2 depends on Wave 1 (clean foundation). Wave 3 depends on Wave 2 (unified pipeline).

---

## Files by Task

### A1: Vector + Reranker
- src/services/hnswVectorStore.ts (save mutex)
- src/core/search/strategies/balanced.ts (use OllamaReranker)
- src/core/search/pipeline.ts (wire reranker)

### A2: JSON + Payloads
- src/core/agents/base.ts (JSON extraction hardening)
- src/core/agents/workerAgent.ts (template stripping)
- src/core/agents/noteEditorAgent.ts (payload normalization + error messages)

### A3: Pipeline Unify
- src/main.ts (context menu handlers)
- src/core/agentic/actionOrchestrator.ts (deprecate or remove)
- src/core/agents/chiefOfStaff.ts (ensure insight:created emission)
- src/core/agent/taskQueue.ts (verify event source)

### F1: UI Flow
- src/ui/sidebar/components/InsightStream.tsx (already fixed)
- src/ui/sidebar/components/AgentStreamsView.tsx (capability signals)
- src/ui/sidebar/state/appHandlers.ts (result notices)
