# /// script
# package = "notient-dispatch"
# version = "2.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Dispatch tasks to Notient role-based agent queues"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Task Dispatcher v2

Enqueue tasks for role-based agent queue processors.

Roles are organized into two categories with shared core identities:
- CODERS: implementer, simplifier, validator, tester, architect, advisor
- RESEARCHERS: docs-fetcher, codebase-navigator, world-knowledge

Usage:
    uv run dispatch.py <role> <prompt> [--cli CLI] [--model MODEL] [--context CONTEXT]
    uv run dispatch.py --check <role>
    uv run dispatch.py --responses <role>

Examples:
    # Coder roles
    uv run dispatch.py implementer "Add retry logic to LLMProvider" --cli claude
    uv run dispatch.py simplifier "Flatten SearchPipeline callbacks" --cli gemini
    uv run dispatch.py validator "Review the new event bus changes" --cli claude
    uv run dispatch.py tester "Write tests for ChunkService" --cli claude

    # Researcher roles
    uv run dispatch.py docs-fetcher "Get Preact signals documentation" --cli gemini
    uv run dispatch.py codebase-navigator "Map the search pipeline data flow" --cli claude
    uv run dispatch.py world-knowledge "Find existing LLM orchestration solutions" --cli gemini

    # Check status
    uv run dispatch.py --check implementer
    uv run dispatch.py --responses docs-fetcher
"""

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════════════════
# Role Definitions
# ═══════════════════════════════════════════════════════════════════════════════

# Coder roles (shared CODER.md core identity)
CODER_ROLES = (
    "implementer",
    "simplifier",
    "validator",
    "tester",
    "architect",
    "advisor",
)

# Researcher roles (shared RESEARCHER.md core identity)
RESEARCHER_ROLES = (
    "docs-fetcher",
    "codebase-navigator",
    "world-knowledge",
)

# All valid roles
VALID_ROLES = CODER_ROLES + RESEARCHER_ROLES

# Role display metadata
ROLE_META = {
    # Coders
    "implementer": {"category": "coder", "icon": "🔨", "desc": "Feature builder"},
    "simplifier": {"category": "coder", "icon": "✨", "desc": "Code clarifier"},
    "validator": {"category": "coder", "icon": "🔍", "desc": "Quality gate"},
    "tester": {"category": "coder", "icon": "🧪", "desc": "Test specialist"},
    "architect": {"category": "coder", "icon": "📐", "desc": "System designer"},
    "advisor": {"category": "coder", "icon": "💡", "desc": "Technical consultant"},
    # Researchers
    "docs-fetcher": {"category": "researcher", "icon": "📚", "desc": "Documentation expert"},
    "codebase-navigator": {"category": "researcher", "icon": "🗺️", "desc": "Codebase expert"},
    "world-knowledge": {"category": "researcher", "icon": "🌐", "desc": "External intelligence"},
}

# ═══════════════════════════════════════════════════════════════════════════════
# CLI Platform Configuration
# ═══════════════════════════════════════════════════════════════════════════════

VALID_CLIS = ("claude", "gemini", "cursor-agent", "opencode")


def load_config() -> dict:
    """Load CLI configuration from config.json."""
    config_path = Path(__file__).parent.parent / "orchestration/config.json"
    if config_path.exists():
        return json.loads(config_path.read_text())
    # Fallback defaults
    return {
        "models": {
            "claude": "claude-opus-4-5-20251101",
            "gemini": "gemini-3.0-pro",
            "cursor-agent": "gpt-5.2-codex-high",
            "opencode": "glm-4.7",
        }
    }


CONFIG = load_config()
DEFAULT_MODELS = CONFIG["models"]

# ═══════════════════════════════════════════════════════════════════════════════
# Path Utilities
# ═══════════════════════════════════════════════════════════════════════════════

WORKTREE_BASE = Path.home() / "projects/_worktrees"


def get_repo_root() -> Path:
    """Get the main repository root."""
    return Path(__file__).parent.parent.parent


def get_paths(role: str) -> tuple[Path, Path]:
    """Get queue and response paths for a role."""
    repo = get_repo_root()
    queue = repo / f".claude/orchestration/{role}/queue"
    responses = repo / f".claude/orchestration/{role}/responses"
    return queue, responses


def get_worktree_path(role: str) -> Path:
    """Get the worktree path for a role."""
    return WORKTREE_BASE / f"notient-{role}"


def get_role_category(role: str) -> str:
    """Get the category (coder/researcher) for a role."""
    return ROLE_META.get(role, {}).get("category", "coder")


def get_core_identity_path(role: str) -> str:
    """Get the path to the core identity file for a role's category."""
    category = get_role_category(role)
    if category == "researcher":
        return ".claude/orchestration/core/RESEARCHER.md"
    return ".claude/orchestration/core/CODER.md"


def get_role_identity_path(role: str) -> str:
    """Get the path to the role-specific identity file."""
    return f".claude/orchestration/{role}/ROLE.md"


# ═══════════════════════════════════════════════════════════════════════════════
# Worktree Sync
# ═══════════════════════════════════════════════════════════════════════════════

def sync_file_to_worktree(role: str, rel_path: str) -> bool:
    """Sync a file from main workspace to role's worktree."""
    repo = get_repo_root()
    source = repo / rel_path
    worktree = get_worktree_path(role)

    if not source.exists():
        return False

    if not worktree.exists():
        print(f"  Warning: Worktree not found: {worktree}")
        return False

    target = worktree / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() or target.is_symlink():
        target.unlink()

    try:
        target.symlink_to(source)
        return True
    except OSError:
        import shutil
        shutil.copy2(source, target)
        return True


def sync_role_files(role: str) -> None:
    """Sync identity files to role's worktree."""
    synced = []

    # Sync core identity
    core_path = get_core_identity_path(role)
    if sync_file_to_worktree(role, core_path):
        synced.append(Path(core_path).name)

    # Sync role identity
    role_path = get_role_identity_path(role)
    if sync_file_to_worktree(role, role_path):
        synced.append("ROLE.md")

    if synced:
        print(f"  Synced: {', '.join(synced)} -> {role} worktree")


# ═══════════════════════════════════════════════════════════════════════════════
# Task Dispatch
# ═══════════════════════════════════════════════════════════════════════════════

def dispatch_task(
    role: str,
    prompt: str,
    model: str = None,
    context: str = "",
    cli: str = None
) -> str:
    """Dispatch a task to a role's queue."""
    queue_dir, _ = get_paths(role)
    queue_dir.mkdir(parents=True, exist_ok=True)

    # Default CLI
    if cli is None:
        cli = "claude"

    # Default model for CLI
    if model is None:
        model = DEFAULT_MODELS.get(cli, DEFAULT_MODELS["claude"])

    # Build the prompt with identity file instructions
    core_identity = get_core_identity_path(role)
    role_identity = get_role_identity_path(role)

    # Inject current date for world-knowledge
    date_context = ""
    if role == "world-knowledge":
        date_context = f"\n\nToday's date: {datetime.now().strftime('%Y-%m-%d')}"

    full_prompt = (
        f"First, read your identity files in order:\n"
        f"1. {core_identity} (core identity)\n"
        f"2. {role_identity} (role specialization)\n"
        f"{date_context}\n\n"
        f"Then execute this task:\n{prompt}"
    )

    task_id = f"task-{uuid.uuid4().hex[:8]}"
    task = {
        "id": task_id,
        "role": role,
        "category": get_role_category(role),
        "prompt": full_prompt,
        "model": model,
        "cli": cli,
        "context": context,
        "cli_platform": cli,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    task_file = queue_dir / f"{task_id}.task"
    task_file.write_text(json.dumps(task, indent=2))

    meta = ROLE_META.get(role, {})
    icon = meta.get("icon", "🤖")
    desc = meta.get("desc", role)

    print(f"\n{icon} Dispatched: {task_id} -> {role}")
    print(f"  Category: {get_role_category(role)}")
    print(f"  CLI: {cli}")
    print(f"  Model: {model}")
    print(f"  Prompt: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")
    print()

    # Sync identity files to worktree
    sync_role_files(role)

    return task_id


# ═══════════════════════════════════════════════════════════════════════════════
# Queue Management
# ═══════════════════════════════════════════════════════════════════════════════

def check_queue(role: str):
    """Check queue status for a role."""
    queue_dir, responses_dir = get_paths(role)

    pending = list(queue_dir.glob("*.task")) if queue_dir.exists() else []
    completed = list(responses_dir.glob("*.response")) if responses_dir.exists() else []

    meta = ROLE_META.get(role, {})
    icon = meta.get("icon", "🤖")

    print(f"\n{icon} Role: {role}")
    print(f"  Category: {get_role_category(role)}")
    print(f"  Pending tasks: {len(pending)}")
    print(f"  Completed responses: {len(completed)}")

    if pending:
        print("\nPending:")
        for p in sorted(pending, key=lambda x: x.stat().st_mtime):
            task = json.loads(p.read_text())
            prompt = task.get("prompt", "")
            # Extract just the task part (after "Then execute this task:")
            if "Then execute this task:" in prompt:
                prompt = prompt.split("Then execute this task:")[-1].strip()
            print(f"  - {task['id']}: {prompt[:60]}...")


def list_responses(role: str):
    """List responses for a role."""
    _, responses_dir = get_paths(role)

    if not responses_dir.exists():
        print(f"No responses for {role}")
        return

    responses = list(responses_dir.glob("*.response"))
    if not responses:
        print(f"No responses for {role}")
        return

    meta = ROLE_META.get(role, {})
    icon = meta.get("icon", "🤖")

    print(f"\n{icon} Responses for {role}:\n")
    for r in sorted(responses, key=lambda x: x.stat().st_mtime, reverse=True):
        resp = json.loads(r.read_text())
        status_icon = "✓" if resp["status"] == "complete" else "✗"
        print(f"{status_icon} {resp['task_id']} ({resp.get('elapsed_seconds', 0)}s)")
        output = resp.get("output", "")
        if output:
            print(f"  {output[:100]}{'...' if len(output) > 100 else ''}")
        print()


def list_all_status():
    """Show status of all roles."""
    print("\n📊 All Roles Status:\n")

    print("CODERS:")
    for role in CODER_ROLES:
        queue_dir, resp_dir = get_paths(role)
        pending = len(list(queue_dir.glob("*.task"))) if queue_dir.exists() else 0
        completed = len(list(resp_dir.glob("*.response"))) if resp_dir.exists() else 0
        meta = ROLE_META.get(role, {})
        icon = meta.get("icon", "🤖")
        status = "🟡" if pending > 0 else ("📬" if completed > 0 else "⚪")
        print(f"  {status} {icon} {role}: {pending} pending, {completed} responses")

    print("\nRESEARCHERS:")
    for role in RESEARCHER_ROLES:
        queue_dir, resp_dir = get_paths(role)
        pending = len(list(queue_dir.glob("*.task"))) if queue_dir.exists() else 0
        completed = len(list(resp_dir.glob("*.response"))) if resp_dir.exists() else 0
        meta = ROLE_META.get(role, {})
        icon = meta.get("icon", "🤖")
        status = "🟡" if pending > 0 else ("📬" if completed > 0 else "⚪")
        print(f"  {status} {icon} {role}: {pending} pending, {completed} responses")

    print()


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Dispatch tasks to role-based agent queues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Roles:
  CODERS (shared coder core):
    {', '.join(CODER_ROLES)}

  RESEARCHERS (shared researcher core):
    {', '.join(RESEARCHER_ROLES)}

Examples:
    # Dispatch to implementer using Claude
    uv run dispatch.py implementer "Add retry logic" --cli claude

    # Dispatch to docs-fetcher using Gemini
    uv run dispatch.py docs-fetcher "Get React 19 docs" --cli gemini

    # Check all roles
    uv run dispatch.py --status

    # Check specific role
    uv run dispatch.py --check implementer
        """
    )
    parser.add_argument("role", nargs="?", help=f"Role: {', '.join(VALID_ROLES)}")
    parser.add_argument("prompt", nargs="?", help="Task prompt")
    parser.add_argument("--cli", choices=VALID_CLIS, default=None,
                        help=f"CLI platform: {', '.join(VALID_CLIS)} (default: claude)")
    parser.add_argument("--model", "-m", default=None,
                        help="Model to use (default: CLI-specific default)")
    parser.add_argument("--context", "-c", default="", help="Additional context")
    parser.add_argument("--check", action="store_true", help="Check queue status")
    parser.add_argument("--responses", "-r", action="store_true", help="List responses")
    parser.add_argument("--status", "-s", action="store_true", help="Show all roles status")

    args = parser.parse_args()

    # Show all status
    if args.status:
        list_all_status()
        return

    # Need a role for other operations
    if not args.role:
        parser.print_help()
        sys.exit(1)

    role = args.role.lower()
    if role not in VALID_ROLES:
        print(f"Unknown role: {role}")
        print(f"\nCoders: {', '.join(CODER_ROLES)}")
        print(f"Researchers: {', '.join(RESEARCHER_ROLES)}")
        sys.exit(1)

    if args.check:
        check_queue(role)
    elif args.responses:
        list_responses(role)
    elif args.prompt:
        dispatch_task(role, args.prompt, args.model, args.context, args.cli)
    else:
        check_queue(role)


if __name__ == "__main__":
    main()
