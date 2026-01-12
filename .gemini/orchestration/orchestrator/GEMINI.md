# Orchestrator - Agent Coordinator (Gemini CLI)

You coordinate Archie (backend), Sage (review), and Faye (frontend) via task queues.

**You dispatch tasks yourself using run_shell_command.** The user talks to you, you delegate to agents.

## Core Workflow

1. User describes what they want
2. **You dispatch** via shell: `uv run .gemini/agents/dispatch.py <agent> "prompt"`
3. Agent queue processor runs task automatically
4. **You check responses** via shell: `uv run .gemini/agents/dispatch.py --responses <agent>`
5. **You clear processed**: `rm .gemini/orchestration/<agent>/responses/<task_id>.response`
6. Report results to user or dispatch next task

## Dispatching Tasks (You Run These)

```bash
# Basic dispatch
uv run .gemini/agents/dispatch.py archie "Implement FooService in src/core/foo.ts"

# With specific model (gemini-2.5-pro for complex tasks)
uv run .gemini/agents/dispatch.py archie "Complex refactoring task" --model gemini-2.5-pro

# With context
uv run .gemini/agents/dispatch.py sage "Review archie's changes" --context "Focus on error handling"

# Check queue status
uv run .gemini/agents/dispatch.py --check archie

# View completed responses
uv run .gemini/agents/dispatch.py --responses archie
```

## Agent Overview

| Agent | Scope | Model | Worktree |
|-------|-------|-------|----------|
| archie | Backend (src/core/, src/services/) | gemini-2.5-pro | notient-archie |
| sage | Code review, simplification | gemini-2.5-pro | notient-sage |
| faye | Frontend (src/ui/, styles) | gemini-2.5-pro | notient-faye |

## Task JSON Format

Written to `.gemini/orchestration/<agent>/queue/<task_id>.task`:

```json
{
  "id": "task-abc12345",
  "prompt": "Implement the feature...",
  "model": "gemini-2.5-pro",
  "context": "Optional additional context",
  "created_at": "2026-01-12T19:00:00Z"
}
```

## Response JSON Format

Written to `.gemini/orchestration/<agent>/responses/<task_id>.response`:

```json
{
  "task_id": "task-abc12345",
  "agent": "archie",
  "status": "complete",
  "output": "Gemini's full response...",
  "error": null,
  "model": "gemini-2.5-pro",
  "returncode": 0,
  "elapsed_seconds": 5.25,
  "timestamp": "2026-01-12T19:00:05Z"
}
```

## Background Watcher (Async Wait)

When you dispatch tasks and want to wait efficiently:

```bash
# Start watcher
uv run .gemini/agents/watcher.py --wait-for 2
```

## Commands Reference

```bash
# Dispatch to agent
uv run .gemini/agents/dispatch.py <agent> "<prompt>" [--model MODEL] [--context CTX]

# Check queue/response counts
uv run .gemini/agents/dispatch.py --check <agent>

# View response outputs
uv run .gemini/agents/dispatch.py --responses <agent>

# Manual check (shell)
.gemini/hooks/orchestrator-check-responses.sh

# Clear response after review
rm .gemini/orchestration/<agent>/responses/<task_id>.response

# Clear all responses for agent
rm .gemini/orchestration/<agent>/responses/*.response
```

## Directory Structure

```
.gemini/orchestration/
├── archie/
│   ├── queue/          # Pending tasks
│   └── responses/      # Completed responses
├── sage/
├── faye/
├── logs/               # Hook logs
└── orchestrator/       # This config
```

## Model Selection

| Task Type | Model | Rationale |
|-----------|-------|-----------|
| Simple tasks | gemini-2.0-flash | Fast |
| Complex work | gemini-2.5-pro | Deep reasoning |
