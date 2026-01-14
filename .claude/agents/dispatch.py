# /// script
# package = "notient-dispatch"
# version = "1.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Dispatch tasks to Notient agent queues"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Task Dispatcher

Enqueue tasks for agent queue processors.

Usage:
    uv run dispatch.py <agent> <prompt> [--model MODEL] [--context CONTEXT]
    uv run dispatch.py --check <agent>
    uv run dispatch.py --responses <agent>

Examples:
    uv run dispatch.py archie "Implement FooService in src/core/foo.ts"
    uv run dispatch.py archie "Fix the bug" --model sonnet --context "See issue #123"
    uv run dispatch.py --check archie
    uv run dispatch.py --responses archie
"""

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

VALID_AGENTS = ("archie", "sage", "faye")
VALID_MODELS = (
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
)
DEFAULT_MODEL = "claude-opus-4-5-20251101"

# Worktree paths (agents run in separate git worktrees)
WORKTREE_BASE = Path.home() / "projects/_worktrees"


def get_paths(agent: str) -> tuple[Path, Path]:
    """Get queue and response paths in main workspace."""
    repo = Path(__file__).parent.parent.parent
    queue = repo / f".claude/orchestration/{agent}/queue"
    responses = repo / f".claude/orchestration/{agent}/responses"
    return queue, responses


def get_worktree_path(agent: str) -> Path:
    """Get the worktree path for an agent."""
    return WORKTREE_BASE / f"notient-{agent}"


def sync_task_to_worktree(agent: str) -> bool:
    """Sync TASK.md from main workspace to agent's worktree.

    This ensures agents can read their task file when running in their worktree.
    Uses symlink if possible, falls back to copy.
    """
    repo = Path(__file__).parent.parent.parent
    source = repo / f".claude/orchestration/{agent}/TASK.md"
    worktree = get_worktree_path(agent)
    target_dir = worktree / f".claude/orchestration/{agent}"
    target = target_dir / "TASK.md"

    if not source.exists():
        return False

    if not worktree.exists():
        print(f"  Warning: Worktree not found: {worktree}")
        return False

    # Ensure target directory exists
    target_dir.mkdir(parents=True, exist_ok=True)

    # Remove existing target (file or symlink)
    if target.exists() or target.is_symlink():
        target.unlink()

    # Try symlink first (more efficient), fall back to copy
    try:
        target.symlink_to(source)
        print(f"  Synced: TASK.md -> {agent} worktree (symlink)")
    except OSError:
        # Symlink failed (e.g., cross-device), fall back to copy
        import shutil
        shutil.copy2(source, target)
        print(f"  Synced: TASK.md -> {agent} worktree (copy)")

    return True


def dispatch_task(agent: str, prompt: str, model: str = DEFAULT_MODEL, context: str = "") -> str:
    queue_dir, _ = get_paths(agent)
    queue_dir.mkdir(parents=True, exist_ok=True)

    task_id = f"task-{uuid.uuid4().hex[:8]}"
    task = {
        "id": task_id,
        "prompt": prompt,
        "model": model,
        "context": context,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    task_file = queue_dir / f"{task_id}.task"
    task_file.write_text(json.dumps(task, indent=2))

    print(f"Dispatched: {task_id} -> {agent}")
    print(f"  Model: {model}")
    print(f"  Prompt: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

    # Sync TASK.md to worktree so agent can read it
    sync_task_to_worktree(agent)

    return task_id


def check_queue(agent: str):
    queue_dir, responses_dir = get_paths(agent)

    pending = list(queue_dir.glob("*.task")) if queue_dir.exists() else []
    completed = list(responses_dir.glob("*.response")) if responses_dir.exists() else []

    print(f"Agent: {agent}")
    print(f"  Pending tasks: {len(pending)}")
    print(f"  Completed responses: {len(completed)}")

    if pending:
        print("\nPending:")
        for p in sorted(pending, key=lambda x: x.stat().st_mtime):
            task = json.loads(p.read_text())
            print(f"  - {task['id']}: {task['prompt'][:60]}...")


def list_responses(agent: str):
    _, responses_dir = get_paths(agent)

    if not responses_dir.exists():
        print(f"No responses for {agent}")
        return

    responses = list(responses_dir.glob("*.response"))
    if not responses:
        print(f"No responses for {agent}")
        return

    print(f"Responses for {agent}:\n")
    for r in sorted(responses, key=lambda x: x.stat().st_mtime, reverse=True):
        resp = json.loads(r.read_text())
        status_icon = "✓" if resp["status"] == "complete" else "✗"
        print(f"{status_icon} {resp['task_id']} ({resp['elapsed_seconds']}s)")
        print(f"  {resp['output'][:100]}{'...' if len(resp['output']) > 100 else ''}")
        print()


def main():
    parser = argparse.ArgumentParser(description="Dispatch tasks to agent queues")
    parser.add_argument("agent", nargs="?", help=f"Agent: {', '.join(VALID_AGENTS)}")
    parser.add_argument("prompt", nargs="?", help="Task prompt")
    parser.add_argument("--model", "-m", default=DEFAULT_MODEL, choices=VALID_MODELS)
    parser.add_argument("--context", "-c", default="", help="Additional context")
    parser.add_argument("--check", action="store_true", help="Check queue status")
    parser.add_argument("--responses", "-r", action="store_true", help="List responses")

    args = parser.parse_args()

    if not args.agent:
        parser.print_help()
        sys.exit(1)

    agent = args.agent.lower()
    if agent not in VALID_AGENTS:
        print(f"Unknown agent: {agent}")
        print(f"  Valid: {', '.join(VALID_AGENTS)}")
        sys.exit(1)

    if args.check:
        check_queue(agent)
    elif args.responses:
        list_responses(agent)
    elif args.prompt:
        dispatch_task(agent, args.prompt, args.model, args.context)
    else:
        check_queue(agent)


if __name__ == "__main__":
    main()
