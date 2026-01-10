# Sage - Phase 1 Stage 1.5: Optimize Debug Logging

> **Status**: PENDING (waits for Archie + Faye)
> **Phase**: ALPHA-SPEC Phase 1 (Foundation)
> **Agent**: `code-simplifier:code-simplifier`
> **Branch**: `ALPHA-SPEC-SPRINT` (shared with all engineers)
> **Duration**: 1 hour

---

## Git Workflow (CRITICAL - SHARED IDE)

### Rule 1: You're Already on the Right Branch
```bash
# Check current state
git status
git branch   # Should show: * ALPHA-SPEC-SPRINT
```

**NEVER switch branches** - you're already on `ALPHA-SPEC-SPRINT`.
Archie and Faye are working on this same branch. Switching affects ALL terminals.

### Rule 2: Check What Files Were Modified (Before Starting)
```bash
git diff --name-only    # See which files Archie/Faye changed
git log --oneline -3    # See recent commits
```

Chief of Staff will tell you which files to optimize.

### Rule 3: Stage ONLY YOUR Files (ONE BY ONE)

```bash
# Check what changed
git status

# Stage ONLY files YOU modified in THIS session
git add src/core/agent/taskQueue.ts         # ONLY if you optimized it
git add src/ui/sidebar/App.tsx              # ONLY if you optimized it
git add src/utils/debugLog.ts               # If you created this helper
git add planning/orchestration/sage/REPORT.md

# Verify ONLY your files are staged
git status   # Staged files should match what YOU edited
```

**CRITICAL - What NOT to do**:
- ❌ `git add .` - Stages EVERYTHING
- ❌ `git add src/**` - Wildcards catch unrelated files
- ❌ Staging files Archie or Faye modified (unless you also modified them)

### Rule 4: Commit with Clear Message

```bash
git commit -m "refactor(phase-1): Optimize debug logging for performance

Improvements:
- Reduced log volume by [X%]
- Added structured logging with context
- Extracted common logging patterns
- No performance impact (verified in DevTools)

Code review by Sage (code-simplifier)."
```

### Rule 5: NEVER Push

```bash
# ❌ NEVER DO THIS - CEO handles all pushes
git push
```

---

### Git Rules Summary
1. ✅ You're on `ALPHA-SPEC-SPRINT` (shared branch)
2. ✅ Stage files ONE BY ONE with explicit paths
3. ✅ Verify with `git status` before commit
4. ❌ NEVER use `git add .` or wildcards
5. ❌ NEVER switch branches (`git checkout`)
6. ❌ NEVER push (`git push`)

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
| `src/core/chat/types.ts` | 9-80 | StoredChatMessage, ConversationFile, ConversationRollup, AppendMessageOptions |
| `src/core/chat/conversationStore.ts` | 1-630 | Per-note storage, lazy loading, migration, dual API |
| `src/core/chat/chatService.ts` | 32-60 | extractReasoningSummary() utility |

---

## Invocation

To run Sage on Phase 4, use this exact prompt:

```
Simplify the Phase 4 conversation storage code that was recently added.

## Git Workflow
1. Run `git status` first to see current state
2. Only modify files listed below
3. After changes, stage ONLY your files and commit (no push)

## Focus Files
- src/core/chat/types.ts (lines 9-80)
- src/core/chat/conversationStore.ts (lines 1-630)
- src/core/chat/chatService.ts (lines 32-60)

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
   - Verbose patterns that could be cleaner
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
