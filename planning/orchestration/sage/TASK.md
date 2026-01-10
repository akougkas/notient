# Sage - Phase 3 Review: Intelligence Tag Sharding

> **Status**: ASSIGNED
> **Agent**: `code-simplifier:code-simplifier`
> **Branch**: `archie/backend-fixes`

---

## Git Workflow (CRITICAL)

### Before Starting
```bash
git status
git diff --name-only
```
Understand what files are already modified. DO NOT touch files you don't need.

### During Work
- ONLY simplify files listed in "Focus Files" below
- Keep changes focused on clarity, not functionality

### After Completing
```bash
# Stage ONLY your files
git add src/core/intelligence/types.ts
git add src/core/intelligence/intelligenceDb.ts
git add src/core/intelligence/noteIntelligence.ts
git add planning/orchestration/sage/REPORT.md

# Commit with descriptive message
git commit -m "refactor(intelligence): Simplify Phase 3 tag-sharding code

- [List specific simplifications made]

Code review by Sage (code-simplifier)."

# DO NOT PUSH - only commit
```

### Rules
- **NO `git push`** - Only local commits
- **NO staging unrelated files** - Check `git status` before commit
- **NO amending** other people's commits

---

## How Sage Works

Sage IS the code-simplifier agent from Anthropic. It:
- Operates autonomously on recently modified code
- Preserves all functionality while improving clarity
- Uses Opus model for maximum capability

---

## Focus Files

| File | Lines | What to Review |
|------|-------|----------------|
| `src/core/intelligence/types.ts` | 79-104 | IntelligenceTopicFile, IntelligenceMeta types |
| `src/core/intelligence/intelligenceDb.ts` | 1-384 | Multi-file topic management, migration |
| `src/core/intelligence/noteIntelligence.ts` | 48-226 | Tag passing, initialization |

---

## Invocation

To run Sage on Phase 3, use this exact prompt:

```
Simplify the Phase 3 intelligence tag-sharding code that was recently added.

## Git Workflow
1. Run `git status` first to see current state
2. Only modify files listed below
3. After changes, stage ONLY your files and commit (no push)

## Focus Files
- src/core/intelligence/types.ts (lines 79-104)
- src/core/intelligence/intelligenceDb.ts (lines 1-384)
- src/core/intelligence/noteIntelligence.ts (lines 48-226)

## After Simplification
1. Run: bun run typecheck && bun run build
2. Write findings to: planning/orchestration/sage/REPORT.md
3. Git commit your changes (only your files, no push)
```

---

## What Code-Simplifier Will Do

1. **Read** the specified files
2. **Analyze** for simplification opportunities:
   - Unnecessary abstractions
   - Redundant code paths
   - Over-validation
   - Nested ternaries → switch statements
3. **Apply** edits while preserving functionality
4. **Verify** with typecheck and build
5. **Report** changes made
6. **Commit** only touched files (no push)

---

## What It WON'T Do

- Change functionality (only HOW code achieves it)
- Remove helpful abstractions
- Prioritize brevity over readability
- Create clever solutions that are hard to understand
- Touch files outside the focus list
- Push to remote
