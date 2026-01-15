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

# Valid roles (predefined)
VALID_ROLES = ("researcher", "coder", "reviewer", "tester")
# Keep old agents for backward compatibility
VALID_AGENTS = VALID_ROLES + ("archie", "sage", "faye")

# Valid CLI platforms
VALID_CLIS = ("claude", "gemini", "cursor-agent", "opencode")

# Default models per CLI
DEFAULT_MODELS = {
    "claude": "claude-opus-4-5-20251101",
    "gemini": "gemini-3.0-pro",
    "cursor-agent": "gpt-5.2-codex-high",
    "opencode": "glm-4.7",
}

# CLI trust levels
CLI_TRUST = {
    "claude": "high",
    "gemini": "high",
    "cursor-agent": "medium",
    "opencode": "low",
}

# Legacy model list for backward compatibility
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


def sync_file_to_worktree(agent: str, filename: str) -> bool:
    """Sync a file from main workspace to agent's worktree.

    Uses symlink if possible, falls back to copy.
    """
    repo = Path(__file__).parent.parent.parent
    source = repo / f".claude/orchestration/{agent}/{filename}"
    worktree = get_worktree_path(agent)
    target_dir = worktree / f".claude/orchestration/{agent}"
    target = target_dir / filename

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
        return True
    except OSError:
        # Symlink failed (e.g., cross-device), fall back to copy
        import shutil
        shutil.copy2(source, target)
        return True


def sync_agent_files(agent: str) -> None:
    """Sync CLAUDE.md and TASK.md to agent's worktree."""
    synced = []
    if sync_file_to_worktree(agent, "CLAUDE.md"):
        synced.append("CLAUDE.md")
    if sync_file_to_worktree(agent, "TASK.md"):
        synced.append("TASK.md")
    if synced:
        print(f"  Synced: {', '.join(synced)} -> {agent} worktree")


def dispatch_task(agent: str, prompt: str, model: str = None, context: str = "", cli: str = None) -> str:
    queue_dir, _ = get_paths(agent)
    queue_dir.mkdir(parents=True, exist_ok=True)

    # Determine CLI platform (default to claude for old agents)
    if cli is None:
        cli = "claude"  # Default CLI

    # Use default model for CLI if not specified
    if model is None:
        model = DEFAULT_MODELS.get(cli, DEFAULT_MODEL)

    # Determine identity file based on agent type
    if agent in VALID_ROLES:
        identity_file = f".claude/orchestration/{agent}/ROLE.md"
    else:
        identity_file = f".claude/orchestration/{agent}/CLAUDE.md"

    # Prepend instruction to read identity file first
    full_prompt = f"First read {identity_file} for your role context and instructions, then: {prompt}"

    task_id = f"task-{uuid.uuid4().hex[:8]}"
    task = {
        "id": task_id,
        "prompt": full_prompt,
        "model": model,
        "cli": cli,
        "context": context,
        "trust_level": CLI_TRUST.get(cli, "high"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    task_file = queue_dir / f"{task_id}.task"
    task_file.write_text(json.dumps(task, indent=2))

    print(f"Dispatched: {task_id} -> {agent}")
    print(f"  CLI: {cli}")
    print(f"  Model: {model}")
    print(f"  Trust: {CLI_TRUST.get(cli, 'high')}")
    print(f"  Prompt: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

    # Sync identity files to worktree (for backward compatibility)
    sync_agent_files(agent)

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
    parser = argparse.ArgumentParser(
        description="Dispatch tasks to role-based agent queues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Dispatch to researcher role using Gemini
    uv run dispatch.py researcher "Analyze the search pipeline" --cli gemini

    # Dispatch to coder role using Claude Opus
    uv run dispatch.py coder "Implement retry logic" --cli claude --model claude-opus-4-5-20251101

    # Check queue status
    uv run dispatch.py --check researcher

    # List responses
    uv run dispatch.py --responses coder
        """
    )
    parser.add_argument("agent", nargs="?", help=f"Agent/Role: {', '.join(VALID_AGENTS)}")
    parser.add_argument("prompt", nargs="?", help="Task prompt")
    parser.add_argument("--cli", choices=VALID_CLIS, default=None,
                        help=f"CLI platform: {', '.join(VALID_CLIS)} (default: claude)")
    parser.add_argument("--model", "-m", default=None,
                        help="Model to use (default: CLI-specific default)")
    parser.add_argument("--context", "-c", default="", help="Additional context")
    parser.add_argument("--check", action="store_true", help="Check queue status")
    parser.add_argument("--responses", "-r", action="store_true", help="List responses")

    args = parser.parse_args()

    if not args.agent:
        parser.print_help()
        sys.exit(1)

    agent = args.agent.lower()
    if agent not in VALID_AGENTS:
        print(f"Unknown agent/role: {agent}")
        print(f"  Roles: {', '.join(VALID_ROLES)}")
        print(f"  Legacy agents: archie, sage, faye")
        sys.exit(1)

    if args.check:
        check_queue(agent)
    elif args.responses:
        list_responses(agent)
    elif args.prompt:
        dispatch_task(agent, args.prompt, args.model, args.context, args.cli)
    else:
        check_queue(agent)


if __name__ == "__main__":
    main()
