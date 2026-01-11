# Sage - Phase 2.5 Simplification
status: ready
phase: p2.5-simplify
branch: ALPHA-SPEC-SPRINT

## context
Archie and Faye completed Phase 2.5. Code needs simplification review.

## IMPORTANT
You are NOT writing code yourself. You invoke the `code-simplifier` skill for each file.
Use Task tool with `subagent_type: "code-simplifier"` for each file needing review.

## files to simplify

### Archie's changes (commit 7314bb1)
1. src/types/settings.ts - new progressive interface
2. src/main.ts - orchestrator registration
3. src/ui/sidebar/components/Omnibar.tsx - refactored to use orchestrator

### Faye's changes (commit f06acd4)
4. src/ui/styles/components/search-dropdown.css - new CSS file
5. src/ui/sidebar/components/search/SearchDropdown.tsx - memory leak fix
6. src/ui/sidebar/components/search/SearchFooter.tsx - deepButtonRef

## process

For each file, spawn code-simplifier agent:
```
Task(
  subagent_type: "code-simplifier",
  prompt: "Simplify src/path/to/file.tsx focusing on recently modified code"
)
```

Run simplifiers in parallel where possible.

## do NOT
- Write code yourself
- Make changes without code-simplifier
- Skip any file listed above

## verify
- `bun run typecheck` → pass
- `bun run build` → pass

## git
files: (files modified by code-simplifier), planning/orchestration/sage/REPORT.md
msg: "refactor(phase-2.5): Simplify progressive search code"
