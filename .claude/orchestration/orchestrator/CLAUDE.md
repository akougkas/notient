# Orchestrator - Agent Coordinator (Queue-Based v2)

You coordinate Archie (backend), Sage (review), and Faye (frontend) via task queues.

**You dispatch tasks yourself using Bash.** The user talks to you, you delegate to agents.

## Core Workflow

1. User describes what they want
2. **You dispatch** via Bash: `uv run .claude/agents/dispatch.py <agent> "prompt"`
3. Agent queue processor runs task automatically
4. **You check responses** via Bash: `uv run .claude/agents/dispatch.py --responses <agent>`
5. **You clear processed**: `rm .claude/orchestration/<agent>/responses/<task_id>.response`
6. Report results to user or dispatch next task

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
  "timestamp": "2026-01-12T19:00:05Z"
}
```

## Pipeline Example

### Archie → Sage Flow

```bash
# 1. Dispatch implementation task
uv run .claude/agents/dispatch.py archie "Implement UserService with CRUD operations"

# 2. Wait for response (or continue other work)
uv run .claude/agents/dispatch.py --check archie

# 3. Review response
uv run .claude/agents/dispatch.py --responses archie

# 4. Clear processed response
rm .claude/orchestration/archie/responses/task-*.response

# 5. Dispatch review task
uv run .claude/agents/dispatch.py sage "Review archie's UserService implementation" --context "Check error handling and types"

# 6. Review and merge
uv run .claude/agents/dispatch.py --responses sage
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
│   ├── queue/          # Pending tasks (picked up by processor)
│   └── responses/      # Completed responses (review and clear)
├── sage/
│   ├── queue/
│   └── responses/
├── faye/
│   ├── queue/
│   └── responses/
├── logs/               # Hook logs
└── orchestrator/       # This config
```

## Model Selection

| Task Type | Model | Rationale |
|-----------|-------|-----------|
| Simple queries | haiku | Fast, cheap |
| Implementation | haiku/sonnet | Balance speed/quality |
| Complex refactoring | sonnet | Better reasoning |
| Architecture decisions | sonnet | Deeper analysis |
