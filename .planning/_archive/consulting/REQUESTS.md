# Consulting Requests

Active requests for external consultant agents.

---

## Request Template

```markdown
## [TASK-ID]: [Short Title]

**Type**: ANALYZE | IMPLEMENT | AUDIT | TRACE
**Priority**: P0 | P1 | P2
**Status**: PENDING | IN_PROGRESS | COMPLETE | BLOCKED

### Objective
[One paragraph: what needs to be done and why]

### Scope
**Files to examine**:
- `path/to/file1.ts`
- `path/to/file2.ts`

**Out of scope**:
- [What NOT to touch]

### Deliverables
1. [ ] [Specific output 1]
2. [ ] [Specific output 2]

### Validation (close_the_loop)
```
IF [condition] THEN status=COMPLETE
ELSE status=BLOCKED, report why
```

### Context
- Related issue: Phase 0, Issue #X
- Dependencies: [none | list]
- Reference: [link to relevant doc if any]

### Notes
[Any additional context, constraints, or hints]
```

---

## Active Requests

<!-- Add new requests below, newest first -->

### [CONSULT-001]: Reranker JSON Parsing Analysis

**Type**: ANALYZE
**Priority**: P0
**Status**: PENDING

### Objective
Analyze why reranker fails to parse LLM responses containing `<think>` tags. Document the exact failure mode and propose a minimal fix.

### Scope
**Files to examine**:
- `src/core/llm/providers/lmstudio-sdk.ts` (parseRerankResponse function)
- `src/core/llm/provider.ts` (rerank interface)

**Out of scope**:
- Other LLM providers
- Embedding logic

### Deliverables
1. [ ] Report: exact regex that fails and why
2. [ ] Report: sample LLM output that triggers failure
3. [ ] Proposed fix (code snippet, not implementation)

### Validation (close_the_loop)
```
IF report contains (failure_regex + sample_output + proposed_fix) THEN COMPLETE
ELSE BLOCKED
```

### Context
- Related issue: Phase 0, Issue #3
- Console error: `[lmstudio-sdk] No rankings array in response`

---

### [CONSULT-002]: Action Event Flow Trace

**Type**: TRACE
**Priority**: P0
**Status**: PENDING

### Objective
Trace the complete flow from Quick Action button click to pending action appearing in UI. Identify where `action:proposed` event should be emitted but isn't.

### Scope
**Files to examine**:
- `src/ui/sidebar/components/QuickActions.tsx`
- `src/ui/sidebar/hooks/appHandlers.ts`
- `src/core/agent/taskQueue.ts`
- `src/ui/sidebar/hooks/useAppEvents.ts`

**Out of scope**:
- Chat flow
- Workflow agents

### Deliverables
1. [ ] Flow diagram (text): button → ... → UI update
2. [ ] Exact location where event emission is missing
3. [ ] List of all EventBus events in this flow

### Validation (close_the_loop)
```
IF (flow_diagram EXISTS) AND (missing_emission_location IDENTIFIED) THEN COMPLETE
ELSE BLOCKED
```

### Context
- Related issue: Phase 0, Issue #6
- Known: `pendingActions` signal never populates

---

## Completed Requests

<!-- Move completed requests here with completion date -->

_None yet_
