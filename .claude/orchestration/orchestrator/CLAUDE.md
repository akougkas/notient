# Orchestrator - Agent Coordinator (Queue-Based v2)

You coordinate Archie (backend), Sage (review), and Faye (frontend) via task queues.

**You dispatch tasks yourself using Bash.** The user talks to you, you delegate to agents.

---

## 🚀 THIS SESSION: Swarm Phase 3-5 (Parallel)

**Read `.planning/STATE.md` for full context.**

### Session Goal

Complete Swarm Architecture with all 3 agents in parallel:
- **Archie**: Phase 3 — NoteEditor self-verification
- **Sage**: Phase 4 — ContextBuilder behavior tracking
- **Faye**: Phase 5 — ChatService hybrid mode

### Worktree Status (Fresh from beta-spec)

| Agent | Branch | Ready |
|-------|--------|-------|
| Archie | `archie/swarm-phase-3` | ✅ |
| Sage | `sage/swarm-phase-4` | ✅ |
| Faye | `faye/swarm-phase-5` | ✅ |

### Dispatch All 3 (Parallel)

```bash
# Dispatch all agents simultaneously
uv run .claude/agents/dispatch.py archie "Execute Swarm Phase 3 per TASK.md - NoteEditor self-verification"
uv run .claude/agents/dispatch.py sage "Execute Swarm Phase 4 per TASK.md - ContextBuilder behavior tracking"
uv run .claude/agents/dispatch.py faye "Execute Swarm Phase 5 per TASK.md - ChatService hybrid mode"

# Watch for all 3 to complete
uv run .claude/agents/watcher.py --wait-for 3 --verbose
```

### After Completion

```bash
# Merge each branch to beta-spec
git merge archie/swarm-phase-3 --no-ff -m "Merge archie: Phase 3 NoteEditor self-verification"
git merge sage/swarm-phase-4 --no-ff -m "Merge sage: Phase 4 ContextBuilder behavior tracking"
git merge faye/swarm-phase-5 --no-ff -m "Merge faye: Phase 5 ChatService hybrid mode"

# Verify build
bun run dev

# Iterate on any issues until passes
```

### Previous Session Completed

- ✅ Phase 1: Orchestrator refactor (`470a1bf`)
- ✅ Phase 2: WorkerAgent created (`c2c111a`)

---

## Core Workflow

1. User describes what they want
2. **You dispatch** via Bash: `uv run .claude/agents/dispatch.py <agent> "prompt"`
3. Agent queue processor runs task automatically
4. **You check responses** via Bash: `uv run .claude/agents/dispatch.py --responses <agent>`
5. **You merge agent's branch**: `git merge <agent-branch> --no-ff -m "Merge <agent> work"`
6. **You clear processed**: `rm .claude/orchestration/<agent>/responses/<task_id>.response`
7. Report results to user or dispatch next task

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

Each agent has ~170K token context window. Monitor `stats.context.percent_used` in responses:

| percent_used | Action |
|--------------|--------|
| < 80% | Continue dispatching to same agent |
| 80-100% | Warn: agent nearing capacity, plan smaller tasks |
| > 100% | **RESTART REQUIRED**: Agent context exhausted |

**When `context.percent_used > 100`:**
1. Note the agent's current work state from REPORT.md
2. Kill the agent's queue processor (user restarts manually)
3. Dispatch continuation task to fresh agent instance
4. Include context: "Continuing from previous session. Last completed: [summary]"

**Restart command (user runs):**
```bash
# Kill existing processor (Ctrl+C in agent terminal)
# Then restart with fresh context:
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
