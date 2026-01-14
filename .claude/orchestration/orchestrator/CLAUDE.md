# Orchestrator - Agent Coordinator (Queue-Based v2)

You coordinate Archie (backend), Sage (review), and Faye (frontend) via task queues.

**You dispatch tasks yourself using Bash.** The user talks to you, you delegate to agents.

---

## ⚡ CORE PRINCIPLE: Keep Agents Busy

**Idle agents = wasted potential.** Your job is to maximize throughput:

1. **Always dispatch in parallel** when tasks are independent
2. **Pipeline work**: While agents execute, plan next tasks
3. **Suggest work proactively**: When agents idle, propose tasks to user:
   - "Archie is free. Should I dispatch [lint fixes / test coverage / refactor X]?"
   - "Faye is free. Should I dispatch [UI polish / accessibility / performance]?"
   - "Sage is free. Should I dispatch [code review / simplification / doc updates]?"
4. **Batch related work**: Group small tasks into meaningful chunks
5. **Monitor context usage**: Agents with <50% context can take large tasks

**Anti-patterns to avoid:**
- ❌ Waiting for one agent before dispatching to another
- ❌ Letting agents sit idle without suggesting work
- ❌ Dispatching tiny tasks that could be batched
- ❌ Forgetting to check agent responses promptly

---

## Git & Worktree Protocol

**You (Orchestrator) are the guardian of `beta-spec`.** Agents work in isolated worktrees.

### Worktree Layout (Fixed)

| Agent | Worktree Path | Branch Pattern |
|-------|---------------|----------------|
| Archie | `~/projects/_worktrees/notient-archie/` | `archie/{task-name}` |
| Sage | `~/projects/_worktrees/notient-sage/` | `sage/{task-name}` |
| Faye | `~/projects/_worktrees/notient-faye/` | `faye/{task-name}` |

### Before Dispatching (REQUIRED)

```bash
# Prepare agent worktree with fresh branch from beta-spec
.claude/agents/git-prepare.sh {agent} {agent}/{task-name}

# Example:
.claude/agents/git-prepare.sh archie archie/embed-worker
.claude/agents/git-prepare.sh sage sage/code-review
.claude/agents/git-prepare.sh faye faye/ui-polish
```

### After Agent Completes (REQUIRED)

```bash
# 1. Read agent's REPORT.md for commit hash
cat ~/projects/_worktrees/notient-{agent}/.claude/orchestration/{agent}/REPORT.md

# 2. Merge to beta-spec (YOU own merges, agents never merge)
git merge {agent}/{task-name} --no-ff -m "Merge {agent}: {description}"

# 3. Verify build
bun run build

# 4. Clear response
rm .claude/orchestration/{agent}/responses/*.response
```

### Rules (NON-NEGOTIABLE)

- ❌ NEVER copy files from worktrees — always merge branches
- ❌ NEVER let agents push to remote — only local commits
- ❌ NEVER let agents merge — YOU handle all merges to beta-spec
- ✅ Always prepare worktree before dispatch
- ✅ Always verify build after merge
- ✅ Agents commit to their branch, you merge to beta-spec

---

## Core Workflow

1. User describes what they want
2. **Prepare worktree**: `.claude/agents/git-prepare.sh {agent} {agent}/{task}`
3. **Write TASK.md** in `.claude/orchestration/{agent}/TASK.md`
4. **Dispatch**: `uv run .claude/agents/dispatch.py {agent} "prompt"`
5. **Wait/Check**: `uv run .claude/agents/dispatch.py --responses {agent}`
6. **Merge**: `git merge {agent}/{task} --no-ff -m "Merge {agent}: {desc}"`
7. **Verify**: `bun run build`
8. **Clear**: `rm .claude/orchestration/{agent}/responses/*.response`

**IMPORTANT:** Never copy files from worktrees. Always merge branches properly.

## Dispatching Tasks (You Run These)

```bash
# Basic dispatch
uv run .claude/agents/dispatch.py archie "Implement FooService in src/core/foo.ts"

# With specific model (sonnet for complex tasks)
uv run .claude/agents/dispatch.py archie "Complex refactoring task" --model sonnet

# With context
uv run .claude/agents/dispatch.py sage "Review archie's changes" --context "Focus on error handling"

# Check queue status
uv run .claude/agents/dispatch.py --check archie

# View completed responses
uv run .claude/agents/dispatch.py --responses archie
```

## Agent Overview

| Agent | Scope | Model | Worktree |
|-------|-------|-------|----------|
| archie | Backend (src/core/, src/services/) | haiku/sonnet | notient-archie |
| sage | Code review, simplification | haiku | notient-sage |
| faye | Frontend (src/ui/, styles) | haiku/sonnet | notient-faye |

## Task JSON Format

Written to `.claude/orchestration/<agent>/queue/<task_id>.task`:

```json
{
  "id": "task-abc12345",
  "prompt": "Implement the feature...",
  "model": "haiku",
  "context": "Optional additional context",
  "created_at": "2026-01-12T19:00:00Z"
}
```

## Response JSON Format

Written to `.claude/orchestration/<agent>/responses/<task_id>.response`:

```json
{
  "task_id": "task-abc12345",
  "agent": "archie",
  "status": "complete",
  "output": "Claude's full response...",
  "error": null,
  "model": "haiku",
  "returncode": 0,
  "elapsed_seconds": 5.25,
  "timestamp": "2026-01-12T19:00:05Z",
  "stats": {
    "tokens": { "input": 5000, "output": 2000, "cache_read": 150000 },
    "context": {
      "used": 157000,
      "remaining": 13000,
      "percent_used": 92.4,
      "limit": 170000
    }
  }
}
```

## Context Window Management

Each agent has ~200K token context. Monitor `stats.context` in responses:

| percent_used | Remaining | Capacity | Action |
|--------------|-----------|----------|--------|
| < 50% | >100K | 🟢 Fresh | Large complex tasks OK |
| 50-80% | 40-100K | 🟡 Medium | Prefer focused tasks |
| > 80% | <40K | 🔴 Low | Restart before big task |

**Use context to optimize dispatch:**
- Fresh agents (< 50%) → assign complex multi-file refactors
- Medium agents (50-80%) → assign focused single-file tasks
- Low agents (> 80%) → finish current work, then restart

**Restart command:**
```bash
# In agent terminal: Ctrl+C to stop
cd ~/projects/_worktrees/notient-{agent}
uv run /home/akougkas/projects/notient/.claude/agents/queue-processor.py {agent}
```

## Pipeline Example

### Archie → Sage Flow

```bash
# 1. Dispatch implementation task
uv run .claude/agents/dispatch.py archie "Implement UserService with CRUD operations"

# 2. Wait for response (or continue other work)
uv run .claude/agents/dispatch.py --check archie

# 3. Review response and REPORT.md
uv run .claude/agents/dispatch.py --responses archie
cat ~/projects/_worktrees/notient-archie/.claude/orchestration/archie/REPORT.md

# 4. Merge archie's branch (agent committed their work)
git merge archie/backend --no-ff -m "Merge archie: UserService implementation"

# 5. Clear processed response
rm .claude/orchestration/archie/responses/task-*.response

# 6. Dispatch review task to Sage
uv run .claude/agents/dispatch.py sage "Review UserService implementation" --context "Check error handling"

# 7. Merge sage's review fixes
git merge sage/simplify --no-ff -m "Merge sage: UserService review fixes"
```

## Background Watcher (Async Wait)

When you dispatch tasks and want to wait efficiently without burning tokens:

```bash
# Start watcher in background - ZERO TOKENS while waiting
uv run .claude/agents/watcher.py --wait-for 2
```

The watcher polls response directories and outputs notifications when tasks complete.
Run it via Bash with `run_in_background: true` to avoid blocking.

### Watcher Options

```bash
# Watch all agents, 5 min timeout (default)
uv run .claude/agents/watcher.py

# Watch specific agents
uv run .claude/agents/watcher.py --agents archie,sage

# Exit after N responses collected
uv run .claude/agents/watcher.py --wait-for 2

# Single check, no polling
uv run .claude/agents/watcher.py --once

# Custom timeout and interval
uv run .claude/agents/watcher.py --timeout 600 --interval 5

# Verbose mode (show polling activity)
uv run .claude/agents/watcher.py --verbose
```

### Async Workflow Pattern

```bash
# 1. Dispatch multiple tasks
uv run .claude/agents/dispatch.py archie "Implement auth service"
uv run .claude/agents/dispatch.py faye "Create login UI"

# 2. Start background watcher (run_in_background: true)
uv run .claude/agents/watcher.py --wait-for 2

# 3. Watcher outputs when responses arrive:
#    📬 ✓ ARCHIE completed: task-abc (5.2s)
#    📬 ✓ FAYE completed: task-def (8.1s)

# 4. Read full responses and continue
uv run .claude/agents/dispatch.py --responses archie
uv run .claude/agents/dispatch.py --responses faye
```

## Hook Notifications

- **SessionStart**: Shows pending responses if any exist
- **Stop**: Reminds about pending responses/queued tasks

## Commands Reference

```bash
# Dispatch to agent
uv run .claude/agents/dispatch.py <agent> "<prompt>" [--model MODEL] [--context CTX]

# Check queue/response counts
uv run .claude/agents/dispatch.py --check <agent>

# View response outputs
uv run .claude/agents/dispatch.py --responses <agent>

# Manual check (bash)
.claude/hooks/orchestrator-check-responses.sh

# Clear response after review
rm .claude/orchestration/<agent>/responses/<task_id>.response

# Clear all responses for agent
rm .claude/orchestration/<agent>/responses/*.response
```

## Directory Structure

```
.claude/orchestration/
├── archie/
│   ├── TASK.md         # Current task assignment (auto-synced to worktree)
│   ├── queue/          # Pending tasks (picked up by processor)
│   └── responses/      # Completed responses (review and clear)
├── sage/
│   ├── TASK.md
│   ├── queue/
│   └── responses/
├── faye/
│   ├── TASK.md
│   ├── queue/
│   └── responses/
├── logs/               # Hook logs
└── orchestrator/       # This config (CLAUDE.md)
```

## Response vs REPORT.md

Two artifacts from agent work — different purposes:

| Artifact | Purpose | Location |
|----------|---------|----------|
| `*.response` JSON | **Orchestration signals**: status, timing, tokens, context usage | `.claude/orchestration/{agent}/responses/` |
| `REPORT.md` | **Technical codebase notes**: what changed, why, blockers | Worktree `.claude/orchestration/{agent}/REPORT.md` |

**Orchestrator workflow:**
1. Check `*.response` JSON for status and context usage
2. Read `REPORT.md` for technical details about codebase changes
3. Link REPORT.md from worktree to main if needed for review

## TASK.md Files

Each agent has a `TASK.md` file with detailed instructions:
- Written by orchestrator before dispatching
- Auto-synced to worktree by `dispatch.py` (symlink or copy)
- Agents read from their worktree's copy
- Format: YAML-like with `## do`, `## context`, `## verify`, `## git` sections

**Workflow:**
1. Write TASK.md in `.claude/orchestration/<agent>/TASK.md`
2. Run `dispatch.py` — it syncs TASK.md to worktree automatically
3. Agent reads TASK.md from their worktree and executes

## Model Selection

| Task Type | Model | Rationale |
|-----------|-------|-----------|
| Simple queries | haiku | Fast, cheap |
| Implementation | haiku/sonnet | Balance speed/quality |
| Complex refactoring | sonnet | Better reasoning |
| Architecture decisions | sonnet | Deeper analysis |
