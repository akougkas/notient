# Sage - 🔴 CODE RED
status: ready
phase: code-red
branch: ALPHA-SPEC-SPRINT

## await
Archie and Faye complete Code Red fixes. Then review all changes.

## focus
- Review architectural fixes for correctness
- Ensure no regressions
- Simplify where possible (use code-simplifier)
- NO new features

## rules
- Use `code-simplifier` subagent only
- Do NOT write code directly
- Verify typecheck + build pass
- Commit with prefix: `refactor(arch):`
