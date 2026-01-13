# Sage - ChiefOfStaff Consolidation
status: ready
phase: universe-completion
branch: sage/orchestration

## do

### D4: Merge actionOrchestrator → ChiefOfStaff
- src/core/agents/chiefOfStaff.ts: Absorb actionOrchestrator functionality
  - ChiefOfStaff becomes FULL ORCHESTRATOR: routes + executes + persists
  - Use FUNCTIONAL COMPOSITION: extract pure functions, keep one file
  - Move dispatch logic from actionOrchestrator into chiefOfStaff
- DELETE src/core/intelligence/actionOrchestrator.ts after merge
- DELETE src/core/intelligence/actionPipeline.ts (inline into chiefOfStaff)
- src/core/agentic/workflowRunner.ts: Merge into TaskQueue or chiefOfStaff

### Refactor D9 Code
- src/main.ts: Update enhance handler
  - Change `actionOrchestrator.dispatch()` → `chiefOfStaff.execute()`
  - Ensure context menu actions still work through ChiefOfStaff

### D5: Delete Dead Code
- DELETE dead ChatAgent file (find it first: `grep -r "ChatAgent" src/`)
- Only ChatAgent - minimal scope per interview decision

### Functional Composition Pattern
Extract pure functions from ChiefOfStaff:
```typescript
// Pure functions (no this, no side effects)
function routeToAgent(intent: string, context: AgentContext): AgentType { ... }
function buildAgentPrompt(agent: AgentType, context: AgentContext): string { ... }
function parseAgentOutput(raw: string, agent: AgentType): AgentOutput { ... }

// ChiefOfStaff orchestrates using pure functions
class ChiefOfStaff {
  async execute(intent: string, context: AgentContext): Promise<AgentResult> {
    const agent = routeToAgent(intent, context);
    const prompt = buildAgentPrompt(agent, context);
    // ... orchestration logic
  }
}
```

## context
Interview decisions (2026-01-13):
- ChiefOfStaff is FULL ORCHESTRATOR (routes, executes, persists)
- Functional composition: pure functions, one file
- Dead code scope: ChatAgent ONLY (minimal)
- D9's actionOrchestrator.dispatch() must migrate to chiefOfStaff.execute()

## anti-patterns
- NO creating multiple orchestrator files
- NO keeping actionOrchestrator "just in case"
- NO deleting files other than ChatAgent (minimal scope)
- NO breaking D9 context menu functionality

## verify
- `bun run typecheck` → passes
- `bun run build` → passes
- `grep -r "actionOrchestrator" src/` → no matches (except maybe comments)
- Context menu "Enhance" action still works via ChiefOfStaff
- `ls src/core/intelligence/actionOrchestrator.ts` → file not found (deleted)

## git
files: src/core/agents/chiefOfStaff.ts, src/main.ts, DELETE src/core/intelligence/actionOrchestrator.ts, DELETE src/core/intelligence/actionPipeline.ts
msg: "refactor(d4): ChiefOfStaff becomes full orchestrator - functional composition"
