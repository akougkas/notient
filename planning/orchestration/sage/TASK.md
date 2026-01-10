# Sage - Awaiting Assignment

> **Status**: IDLE
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Branch**: `ALPHA-SPEC-SPRINT`

---

## Current State

No active assignment. Sage will be assigned after Archie and Faye complete Stage 2 implementation.

## How Sage Works

Sage is a **code simplifier orchestrator**. She does NOT simplify code directly - she spawns `code-simplifier` subagents via the Task tool.

### Workflow

1. Receive assignment (files to review)
2. Break down into file-level tasks
3. Spawn code-simplifier subagents in parallel (up to 3-4)
4. Collect results
5. Write consolidated REPORT.md
6. Commit changes

### Spawning Subagents

```
Task tool:
  subagent_type: code-simplifier
  description: Simplify [filename]
  prompt: |
    Review and simplify: [path/to/file.ts]

    Focus on:
    - [specific pattern]

    Preserve all functionality.
    Run typecheck after changes.
```

---

## Next Expected Assignment

After Archie and Faye complete Stage 2:
- Review their implementation changes
- Spawn code-simplifier subagents for each modified file
- Consolidate and verify

---

## Git Rules

```bash
# Stage ONLY files modified by subagents
git add <modified-files>
git add planning/orchestration/sage/REPORT.md

# Commit
git commit -m "refactor(scope): Simplify [description]

Reviewed by Sage (code-simplifier orchestrator)."

# NEVER PUSH
```
