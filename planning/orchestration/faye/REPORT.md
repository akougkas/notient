# Faye Report
status: complete
commit: 85297a2

## did

### Agent Streams Wiring + Insights Fix (code-red-fixes-2)

- src/ui/sidebar/App.tsx:175-178: Fixed InsightStream reactivity by adding `agentInsights.value` to useMemo dependency array
  - Bug: useMemo only had `staticInsights` in deps, missed `agentInsights.value`
  - Result: InsightStream now re-renders when agents complete and emit insights

- src/ui/sidebar/hooks/useAppEvents.ts:387-404: Added missing "queued" status handler
  - Bug: Switch statement only handled running/completed/failed/cancelled
  - When task enqueued with status "queued", event was ignored
  - Fix: Added case for "queued" to show tasks immediately in Agent Streams

- src/ui/sidebar/hooks/useAppEvents.ts:241-278: Fixed "running" status transition handling
  - Bug: When transitioning from "queued" to "running", runningCount was incremented twice
  - Fix: Check if existing agent was "queued" before updating, only increment runningCount on state change

## verify
typecheck: pass
build: pass

## issues
none
