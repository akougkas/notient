# Swarm Architecture Specification

**Status**: APPROVED
**Created**: 2026-01-14
**Decision**: Architectural brainstorm session with CEO

---

## Executive Summary

Simplify Notient's agent architecture from 13+ scattered agents to a clean **4-agent swarm**:

1. **Orchestrator** — The brain (reasoning model, makes plans, delegates)
2. **NoteEditor** — Obsidian I/O specialist (edit, create, move, verify)
3. **ContextBuilder** — Vault awareness specialist (search, relationships, trends)
4. **Worker** — Workflow executor (classify, enhance, connect, etc.)

---

## The Problem

### Current State (Complex)

```
User → ChatService (detects intent)
    OR → TaskQueue → ChiefOfStaff (routes by intent)
         → ClassifierAgent OR ConnectionAgent OR NoteEditorAgent OR WorkflowAgent
         → Each agent builds its own context
         → Each agent has its own prompt building
         → Each agent parses its own output
```

**Issues:**
- 13+ agents with overlapping concerns
- Two entry points (ChatService vs TaskQueue) create confusion
- Each agent does the same thing: build prompt → call LLM → parse output
- Routing logic scattered across multiple files
- No clear separation of "reasoning" vs "execution"

### Target State (Simple)

```
User → Orchestrator (single entry point)
         ↓ (makes plan)
         → NoteEditor (for Obsidian I/O)
         → ContextBuilder (for vault context)
         → Worker (for workflow execution)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR (Brain)                              │
│                                                                          │
│  • Receives ALL requests (UI, Chat, Editor Decorations)                 │
│  • Makes action plans using reasoning model                             │
│  • Delegates to specialized agents                                       │
│  • Does NOT execute workflows itself                                     │
│                                                                          │
│  Model: Reasoning model (configurable, e.g., DeepSeek, Qwen)            │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────────────┐
        │                           │                                   │
        ▼                           ▼                                   ▼
┌───────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│    NoteEditor     │     │   ContextBuilder    │     │       Worker        │
│      Agent        │     │       Agent         │     │       Agent         │
│                   │     │                     │     │                     │
│ Specialist:       │     │ Specialist:         │     │ Specialist:         │
│ Obsidian I/O      │     │ Vault Awareness     │     │ Workflow Execution  │
│                   │     │                     │     │                     │
│ • Edit notes      │     │ • Search vault      │     │ • Classify (PARA)   │
│ • Create new      │     │ • Find related      │     │ • Enhance notes     │
│ • Move/rename     │     │ • Track trends      │     │ • Atomize content   │
│ • Canvas/Bases    │     │ • User behavior     │     │ • Synthesize        │
│ • Verify work     │     │ • Note context      │     │ • Extract tasks     │
│ • Self-correct    │     │ • Summarize         │     │ • Find connections  │
│                   │     │                     │     │ • Challenge ideas   │
│ Uses: Skills      │     │ Uses: Search        │     │ • Process clippings │
│ (Canvas, Bases,   │     │ Pipeline,           │     │                     │
│  Markdown)        │     │ Embeddings,         │     │ Uses: Workflows     │
│                   │     │ MetadataCache       │     │ (reusable prompts)  │
│                   │     │                     │     │ + Context + Search  │
└───────────────────┘     └─────────────────────┘     └─────────────────────┘
```

---

## Three Triggers

All requests flow through the Orchestrator:

| Trigger | Source | Example |
|---------|--------|---------|
| **UI** | Quick Actions, Agent Streams, Sidebar buttons | "Enhance this note" button |
| **ChatService** | Hybrid mode — conversation OR agent delegation | "/classify this note" in chat |
| **Editor Decorations** | Live conversation during note editing (D8) | Tab key for AI completion |

---

## Agent Responsibilities

### Orchestrator (Brain)

**What it does:**
- Receives all requests from the three triggers
- Reasons about WHAT needs to be done (action planning)
- Delegates to specialized agents
- Aggregates results and returns to caller

**What it does NOT do:**
- Execute workflows directly
- Edit notes directly
- Search the vault directly

**Key insight:** Orchestrator reasons about WHAT. Other agents decide HOW.

### NoteEditor Agent

**Specialist in:** Obsidian file I/O

**Capabilities:**
- Edit existing notes (content, frontmatter)
- Create new notes, canvas files, bases
- Move/rename notes
- Self-verify work (check what was written)
- Recover from mistakes (retry with corrections)

**Uses:** Skills Registry (Canvas, Bases, Markdown)

**Why it's an agent (not a tool):**
- Needs LLM to understand note structure
- Needs to verify its own work
- Can recover from mistakes autonomously

### ContextBuilder Agent

**Specialist in:** Vault awareness

**Capabilities:**
- Search vault using vector search + reranking
- Find semantically related notes
- Track user behavior (recent edits, active note patterns)
- Track trends (note clusters, topic evolution)
- Build context summaries for other agents

**Uses:** Search Pipeline, Embeddings, MetadataCache

**Why it's an agent (not a tool):**
- Needs LLM to synthesize context
- Needs to adapt to query type
- Can iterate on search results

### Worker Agent

**Specialist in:** Workflow execution

**Capabilities:**
- Execute any workflow from the prompts library
- Classify notes (PARA)
- Enhance quick captures
- Atomize complex notes
- Synthesize related notes
- Extract tasks and deadlines
- Find semantic connections
- Challenge ideas (devil's advocate)
- Process web clippings

**Uses:** 
- Workflow prompts (reusable step-by-step prompts)
- ContextBuilder (for vault awareness)
- Search Pipeline (for finding related content)
- Embeddings (for semantic similarity)

**Why it's an agent (not just prompt execution):**
- May need to call ContextBuilder first
- May need to iterate on results
- May need to combine multiple capabilities

---

## What Gets Deleted

| Current | Absorbs Into | Rationale |
|---------|--------------|-----------|
| `ClassifierAgent` | Worker | Just a workflow prompt |
| `ConnectionAgent` | Worker | Just a workflow prompt |
| `WorkflowAgents` (8) | Worker | Unified executor |
| `ChatAgent` | Already dead code | — |

**Workflow prompts are PRESERVED.** We only change WHO executes them.

---

## Implementation Phases

### Phase 1: Orchestrator Foundation

Refactor `chiefOfStaff.ts` → pure reasoning brain:
- Remove direct agent instantiation
- Add action planning with LLM
- Delegate to agents via clean interface

### Phase 2: Worker Agent

Create `workerAgent.ts`:
- Unified workflow executor
- Load prompts from `intelligence/prompts/`
- Can request context from ContextBuilder
- Execute workflows intelligently

### Phase 3: Agent Enhancements

Enhance `noteEditorAgent.ts`:
- Add self-verification loop
- Cleaner interface for Orchestrator

Enhance `contextBuilderAgent.ts`:
- Add user behavior tracking
- Add trend tracking

### Phase 4: ChatService Integration

Modify `chatService.ts`:
- Keep direct conversation handling
- Add `triggerOrchestrator()` for agent tasks
- Hybrid mode detection

### Phase 5: Cleanup

Delete absorbed agents:
- `classifierAgent.ts`
- `connectionAgent.ts`
- `workflowAgents.ts`

---

## Key Files

| Action | File | Reason |
|--------|------|--------|
| REFACTOR | `src/core/agents/chiefOfStaff.ts` | Become Orchestrator (brain only) |
| CREATE | `src/core/agents/workerAgent.ts` | Unified workflow executor |
| ENHANCE | `src/core/agents/noteEditorAgent.ts` | Add self-verification |
| ENHANCE | `src/core/agents/contextBuilderAgent.ts` | Add behavior/trend tracking |
| MODIFY | `src/core/chat/chatService.ts` | Add Orchestrator trigger |
| MODIFY | `src/core/agents/types.ts` | New agent type definitions |
| DELETE | `src/core/agents/classifierAgent.ts` | Absorbed into Worker |
| DELETE | `src/core/agents/connectionAgent.ts` | Absorbed into Worker |
| DELETE | `src/core/agents/workflowAgents.ts` | Absorbed into Worker |

---

## New Types

```typescript
// New agent types
export type AgentType = 
  | 'orchestrator'     // Brain - makes plans
  | 'note-editor'      // Obsidian I/O specialist
  | 'context-builder'  // Vault awareness specialist
  | 'worker';          // Workflow executor

// Orchestrator request (from any trigger)
interface OrchestratorRequest {
  source: 'ui' | 'chat' | 'editor';
  intent: string;  // Natural language from user
  noteContext?: NoteContext;
  chatHistory?: ChatMessage[];
}

// Orchestrator action plan
interface OrchestratorPlan {
  steps: Array<{
    agent: 'note-editor' | 'context-builder' | 'worker';
    task: string;
    params: Record<string, unknown>;
  }>;
  reasoning: string;
}
```

---

## Validation Criteria

- [ ] Orchestrator receives requests from all 3 triggers
- [ ] Orchestrator makes plans using LLM reasoning (not pattern matching)
- [ ] NoteEditor can verify and self-correct its work
- [ ] Worker executes any workflow with context awareness
- [ ] ChatService can trigger Orchestrator for agent tasks
- [ ] All existing workflows still work via Worker agent
- [ ] No dead code (deleted agents removed from codebase)

---

## Risk Assessment

### Confidence: HIGH (85%)

**Why proceed:**
1. Aligns with PHASE-UNIVERSE's stated direction ("full orchestrator")
2. No functionality loss — all workflows preserved
3. Clearer mental model — 4 agents vs 13+
4. Enables future parallelism

### Mitigation

Proceed incrementally:
1. Phase 1: Orchestrator (low risk, high clarity)
2. Phase 2: Worker (prove workflows work)
3. Phase 3-5: Only delete old agents AFTER Worker is proven

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent count | 4 agents | Clear separation of concerns |
| Worker scope | Unified workflow executor | Absorbs 8 workflows + Classifier + Connection |
| ChatService | Hybrid mode | Maintains direct chat, enables agent delegation |
| Model config | Configurable per agent | Orchestrator can use reasoning model, others faster |
| Complexity concern | Proceed incrementally | Prove each phase before deleting old code |

---

*Swarm Architecture: Simple, scalable, future-proof.*
