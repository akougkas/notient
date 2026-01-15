# Pipeline Review Part 4: Holistic Wiring Audit

You have full codebase access. This is the deep review — find everything that's disconnected, half-wired, or architecturally broken.

## Mission

Trace the **complete data flow** from every entry point to final output. Find breaks, dead ends, and silent failures.

## Entry Points to Trace

### 1. User Triggers → Agent Execution → UI Update
```
Entry: QuickActions.tsx, context menu, chat input, keyboard shortcuts
Flow: → taskQueue/chatService → chiefOfStaff → agent → output
Exit: InsightStream, AgentStreamsView, chat messages, notices
```

### 2. Note Changes → Index Update → Search Ready
```
Entry: file create/modify/delete events
Flow: → simpleIndexer → chunker → embeddings → vectorStore
Exit: searchable chunks, updated note states
```

### 3. Search Query → Results → Display
```
Entry: Omnibar, chat semantic search, find-related
Flow: → SearchPipeline → strategy → vector/rerank → results
Exit: searchResults signal, UI display
```

### 4. Agent Output → Action Application → Verification
```
Entry: agent structured output
Flow: → actionApplier → obsidianFacade → file changes
Exit: success/failure feedback, undo history
```

## What to Find

### Disconnected Wires
- Events emitted but never subscribed
- Functions defined but never called
- Outputs generated but never consumed
- Signals updated but never read

### Half-Implemented Features
- Interfaces with no implementations
- Implementations with no callers
- Config options that do nothing
- Feature flags that are always false

### Silent Failures
- Errors caught but not surfaced
- Empty results treated as success
- Timeouts without user feedback
- Network failures hidden

### Architectural Inconsistencies
- Same data fetched multiple ways
- Duplicate state in different locations
- Competing patterns (signals vs events vs direct calls)
- Circular dependencies

## Key Integration Points

Check these specific connections:

```
chiefOfStaff.ts ←→ taskQueue.ts ←→ UI signals
workerAgent.ts ←→ WORKFLOW_CONFIGS ←→ prompts/*.ts
searchPipeline.ts ←→ strategies/*.ts ←→ ollamaReranker.ts
indexManager.ts ←→ hnswVectorStore.ts ←→ vector.worker.ts
eventBus.ts ←→ all subscribers ←→ UI hooks
```

## Output Format

Group findings by severity and area:

```
## CRITICAL — Data Loss / Core Broken
[findings]

## HIGH — Feature Degraded
[findings]

## MEDIUM — Edge Cases / UX Issues
[findings]

## LOW — Tech Debt / Cleanup
[findings]
```

For each finding:
```
### [AREA] Short title

**Trace**: entry → step1 → step2 → BREAK → (expected: step3 → exit)

**Evidence**: [code snippet or log]

**Fix**: [minimal wiring change]
```

## Constraints

- **No architecture changes** — wire what exists
- **No new abstractions** — use existing patterns
- **Minimal fixes** — smallest change that works
- **Preserve features** — don't suggest removing capabilities

Take your time. Be thorough. Find everything.
