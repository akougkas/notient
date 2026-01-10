# Archie - Backend Service Fix
status: ready
phase: p1-s2
branch: ALPHA-SPEC-SPRINT

## do
- src/main.ts: remove conditional service registration (always register taskQueue, workflowRunner)
- src/core/agent/taskQueue.ts: add LLM availability check in enqueue(), throw clear error if unavailable

## context
Root cause: services skipped when LM Studio down → UI gets null → silent failure.
Fix: always register, check availability at call time.

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: LM Studio down → clear error message (not silent null)

## git
files: src/main.ts, src/core/agent/taskQueue.ts, planning/orchestration/archie/REPORT.md
msg: "fix(backend): Always register services for graceful degradation"
