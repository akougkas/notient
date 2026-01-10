# Faye - Frontend useService Fix
status: ready
phase: p1-s2
branch: ALPHA-SPEC-SPRINT

## do
- src/ui/sidebar/context/KernelContext.tsx: make useService reactive
  - add useState to hold service ref
  - add useEffect to subscribe to "services:initialized"
  - setService triggers re-render → callbacks get fresh refs

## context
Root cause: useService returns null on first render, callbacks capture stale ref.
Fix: useState + useEffect subscription to services:initialized event.

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: open sidebar → wait 2s → Quick Actions work

## git
files: src/ui/sidebar/context/KernelContext.tsx, planning/orchestration/faye/REPORT.md
msg: "fix(ui): Make useService hook reactive"
