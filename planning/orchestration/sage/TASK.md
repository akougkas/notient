# Sage - Phase 1 Stage 2 Review
status: complete
phase: p1-s2
branch: ALPHA-SPEC-SPRINT

## await
Archie and Faye completing Stage 2 implementation fixes.

## do
When ready, spawn code-simplifier subagents for:
- src/main.ts (Archie's service registration changes)
- src/core/agent/taskQueue.ts (Archie's availability checks)
- src/ui/sidebar/context/KernelContext.tsx (Faye's useService reactivity)

## focus
- Error handling patterns (consistent approach)
- Service availability checks (DRY)
- Hook reactivity patterns (clean useEffect)
- Remove any leftover debug logging

## anti-patterns
- Don't add complexity
- Don't change behavior
- Don't touch files not modified by Archie/Faye

## verify
- `bun run typecheck` → pass
- `bun run build` → pass

## git
files: [files modified by subagents], planning/orchestration/sage/REPORT.md
msg: "refactor(phase-1): Simplify Stage 2 implementation code"
