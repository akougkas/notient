# Faye - Agent Streams Wiring + Insights Fix
status: ready
phase: code-red-fixes-2
branch: ALPHA-SPEC-SPRINT

## context
Agent Streams view shows empty state even when agents are running. Quick Actions trigger agents but the UI doesn't update. Insights stream is also empty. Either events aren't emitted, events aren't received, or signals aren't reactive. This is a WIRING bug, not a component design bug.

## do

### 1. Trace Quick Action → Agent Streams Flow (P0)
Add temporary debug logs to trace the full flow:
1. `appHandlers.ts:triggerAgenticAction()` - log "triggering action"
2. `taskQueue.ts:enqueue()` - log "task enqueued"
3. `taskQueue.ts:_executeTask()` - log "emitting agent:task-update"
4. `useAppEvents.ts:agent:task-update` handler - log "received task update"
5. `state.ts:activeAgents` - log when signal changes

Run a Quick Action and check which log is missing.

### 2. Fix Event Emission (if broken)
- src/core/agent/taskQueue.ts: Ensure `agent:task-update` is emitted with correct payload:
  ```typescript
  eventBus.emit("agent:task-update", {
    task: { id, type, targetNote, status: "running" },
  });
  ```
- Verify event is emitted for ALL states: running, completed, failed, cancelled

### 3. Fix Event Reception (if broken)
- src/ui/sidebar/hooks/useAppEvents.ts:238-365: Verify `agent:task-update` handler:
  - Creates new `ActiveAgent` object correctly
  - Updates `activeAgents.value` with new array (not mutation)
  - Handles all status transitions

### 4. Fix Signal Reactivity (if broken)
- src/ui/sidebar/state.ts: Verify signal updates trigger re-renders
- Pattern: `activeAgents.value = [...activeAgents.value, newAgent]` (new array)
- NOT: `activeAgents.value.push(newAgent)` (mutation won't trigger)

### 5. Wire InsightStream (P1)
- src/ui/sidebar/hooks/useAppEvents.ts: On `agent:task-update` with status "completed":
  ```typescript
  if (task.resultData?.insightSummary) {
    agentInsights.value = [
      { id: task.id, summary: task.resultData.insightSummary, timestamp: Date.now() },
      ...agentInsights.value.slice(0, 4),
    ];
  }
  ```
- src/ui/sidebar/components/InsightStream.tsx: Verify it reads from `agentInsights` signal

### 6. Clean Up Debug Logs
- Remove all temporary debug logs after fixing
- Keep meaningful error logs only

## anti-patterns
- ❌ Do NOT modify backend services (Archie's domain)
- ❌ Do NOT mutate signals directly (use new array/object assignment)
- ❌ Do NOT restructure component hierarchy
- ❌ Do NOT add new dependencies

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- Manual: Click "Find Links" in Quick Actions → Agent card appears in Streams with "Running" spinner
- Manual: Wait for completion → Card changes to "Completed" with duration and "View Results" button
- Manual: Check Vitals tab → Insight one-liner appears in InsightStream
- Manual: Click another Quick Action → Second agent card appears (multiple agents tracked)

## git
files: src/ui/sidebar/hooks/useAppEvents.ts, src/ui/sidebar/state/appHandlers.ts, src/core/agent/taskQueue.ts, src/ui/sidebar/state.ts, src/ui/sidebar/components/InsightStream.tsx, planning/orchestration/faye/REPORT.md
msg: "fix(ui): Wire Agent Streams + Insights from Quick Actions"
