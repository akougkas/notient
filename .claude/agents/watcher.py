# /// script
# package = "notient-watcher"
# version = "3.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Watch role-based agent responses and notify orchestrator"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Response Watcher v3

Unified watcher for orchestrator integration:
- Polls all role response directories
- Writes JSON notifications to state/notifications.jsonl
- Supports DAG dependencies via state/dag.json
- Orchestrator runs this in background and reads notifications

Roles:
  CODERS: implementer, simplifier, validator, tester, architect, advisor
  RESEARCHERS: docs-fetcher, codebase-navigator, world-knowledge

Usage:
    uv run watcher.py [OPTIONS]

Options:
    --roles ROLES       Comma-separated roles to watch (default: all)
    --coders            Watch only coder roles
    --researchers       Watch only researcher roles
    --timeout SECONDS   Exit after N seconds (default: 600 = 10 min)
    --interval SECONDS  Poll interval (default: 2)
    --once              Check once and exit (no polling)
    --wait-for N        Exit after N responses collected
    --notify            Write JSON notifications to state/notifications.jsonl
    --quiet             Suppress terminal output (for background use)
    --clear             Clear notifications file before starting

Orchestrator Integration:
    # Launch in background
    uv run watcher.py --notify --quiet --timeout 1800 &

    # Read notifications (orchestrator)
    tail -f .claude/orchestration/state/notifications.jsonl

    # Or check programmatically
    cat .claude/orchestration/state/notifications.jsonl | jq -s '.[-1]'
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Role definitions
CODER_ROLES = (
    "implementer",
    "simplifier",
    "validator",
    "tester",
    "architect",
    "advisor",
)

RESEARCHER_ROLES = (
    "docs-fetcher",
    "codebase-navigator",
    "world-knowledge",
)

ALL_ROLES = CODER_ROLES + RESEARCHER_ROLES

# Role metadata for display
ROLE_META = {
    "implementer": {"icon": "🔨", "category": "coder"},
    "simplifier": {"icon": "✨", "category": "coder"},
    "validator": {"icon": "🔍", "category": "coder"},
    "tester": {"icon": "🧪", "category": "coder"},
    "architect": {"icon": "📐", "category": "coder"},
    "advisor": {"icon": "💡", "category": "coder"},
    "docs-fetcher": {"icon": "📚", "category": "researcher"},
    "codebase-navigator": {"icon": "🗺️", "category": "researcher"},
    "world-knowledge": {"icon": "🌐", "category": "researcher"},
}

DEFAULT_TIMEOUT = 600  # 10 minutes
DEFAULT_INTERVAL = 2   # seconds


def get_repo_root() -> Path:
    return Path(__file__).parent.parent.parent


def get_response_dir(role: str) -> Path:
    return get_repo_root() / f".claude/orchestration/{role}/responses"


def get_queue_dir(role: str) -> Path:
    return get_repo_root() / f".claude/orchestration/{role}/queue"


def get_state_dir() -> Path:
    state_dir = get_repo_root() / ".claude/orchestration/state"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir


def get_notifications_file() -> Path:
    return get_state_dir() / "notifications.jsonl"


def get_dag_file() -> Path:
    return get_state_dir() / "dag.json"


def load_dag() -> dict:
    """Load DAG dependencies if defined."""
    dag_file = get_dag_file()
    if dag_file.exists():
        try:
            return json.loads(dag_file.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {"dependencies": {}, "chains": []}


def check_responses(roles: list[str], seen: set[str]) -> list[dict]:
    """Check for new responses, return list of new ones."""
    new_responses = []

    for role in roles:
        response_dir = get_response_dir(role)
        if not response_dir.exists():
            continue

        for resp_file in response_dir.glob("*.response"):
            resp_key = f"{role}:{resp_file.name}"
            if resp_key in seen:
                continue

            seen.add(resp_key)

            try:
                data = json.loads(resp_file.read_text())
                stats = data.get("stats", {})

                new_responses.append({
                    "event": "task_complete",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "role": role,
                    "category": ROLE_META.get(role, {}).get("category", "unknown"),
                    "task_id": data.get("task_id", resp_file.stem),
                    "status": data.get("status", "unknown"),
                    "cli": data.get("cli", "claude"),
                    "model": data.get("model", ""),
                    "elapsed_seconds": data.get("elapsed_seconds", 0),
                    "output": data.get("output", ""),
                    "error": data.get("error"),
                    "stats": {
                        "tool_calls": stats.get("tool_calls", 0),
                        "files_read": stats.get("files_read", []),
                        "files_written": stats.get("files_written", []),
                        "files_edited": stats.get("files_edited", []),
                    },
                    "response_file": str(resp_file),
                })
            except (json.JSONDecodeError, IOError):
                continue

    return new_responses


def check_queues(roles: list[str]) -> dict[str, int]:
    """Check pending tasks in queues."""
    counts = {}
    for role in roles:
        queue_dir = get_queue_dir(role)
        if queue_dir.exists():
            count = len(list(queue_dir.glob("*.task")))
            if count > 0:
                counts[role] = count
    return counts


def write_notification(notification: dict, notify_file: bool):
    """Write notification to jsonl file."""
    if not notify_file:
        return

    notifications_path = get_notifications_file()
    with open(notifications_path, "a") as f:
        f.write(json.dumps(notification) + "\n")


def print_notification(response: dict, quiet: bool):
    """Print notification to terminal."""
    if quiet:
        return

    status_icon = "✅" if response["status"] == "complete" else "❌"
    role = response["role"]
    task_id = response["task_id"]
    elapsed = response["elapsed_seconds"]
    cli = response.get("cli", "claude").upper()
    model = response.get("model", "")
    meta = ROLE_META.get(role, {"icon": "🤖"})
    icon = meta["icon"]

    print(flush=True)
    print(f"{'═' * 70}", flush=True)
    print(f"  {status_icon} TASK COMPLETE: {task_id}", flush=True)
    print(f"{'─' * 70}", flush=True)
    print(f"  {icon} Role: {role.upper():<20} CLI: {cli:<15} Time: {elapsed}s", flush=True)
    if model:
        print(f"     Model: {model}", flush=True)

    stats = response.get("stats", {})
    if stats.get("files_edited") or stats.get("files_written"):
        modified = stats.get("files_edited", []) + stats.get("files_written", [])
        print(f"  📁 Modified: {', '.join(Path(f).name for f in modified[:5])}", flush=True)

    output = response.get("output", "")
    if output:
        preview = output[:200].replace("\n", " ")
        print(f"  💬 {preview}{'...' if len(output) > 200 else ''}", flush=True)

    if response.get("error"):
        print(f"  ⚠️  Error: {response['error'][:100]}", flush=True)

    print(f"{'═' * 70}", flush=True)
    print(flush=True)


def check_dag_triggers(response: dict, dag: dict) -> list[dict]:
    """Check if completed task triggers any DAG dependencies."""
    triggers = []
    task_id = response["task_id"]
    role = response["role"]

    # Check chains
    for chain in dag.get("chains", []):
        steps = chain.get("steps", [])
        for i, step in enumerate(steps[:-1]):
            if step.get("task_id") == task_id or step.get("role") == role:
                next_step = steps[i + 1]
                triggers.append({
                    "event": "dag_trigger",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "chain_id": chain.get("id", "unknown"),
                    "triggered_by": task_id,
                    "next_role": next_step.get("role"),
                    "next_prompt": next_step.get("prompt"),
                    "pass_output": next_step.get("pass_output", False),
                })

    return triggers


def emit_status(event_type: str, data: dict, notify_file: bool, quiet: bool):
    """Emit a status event."""
    event = {
        "event": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **data,
    }
    write_notification(event, notify_file)

    if not quiet:
        if event_type == "watcher_start":
            print(f"🔍 Watcher started: watching {data.get('role_count', 0)} roles", flush=True)
        elif event_type == "watcher_stop":
            print(f"🛑 Watcher stopped: {data.get('reason', 'unknown')}", flush=True)


def main():
    parser = argparse.ArgumentParser(
        description="Watch role-based agent response queues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--roles", "-r", default=None,
                        help="Comma-separated roles (default: all)")
    parser.add_argument("--coders", action="store_true",
                        help="Watch only coder roles")
    parser.add_argument("--researchers", action="store_true",
                        help="Watch only researcher roles")
    parser.add_argument("--timeout", "-t", type=int, default=DEFAULT_TIMEOUT,
                        help=f"Exit after N seconds (default: {DEFAULT_TIMEOUT})")
    parser.add_argument("--interval", "-i", type=int, default=DEFAULT_INTERVAL,
                        help=f"Poll interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--once", action="store_true",
                        help="Check once and exit")
    parser.add_argument("--wait-for", "-w", type=int, default=0,
                        help="Exit after N responses collected")
    parser.add_argument("--notify", "-n", action="store_true",
                        help="Write JSON notifications to state/notifications.jsonl")
    parser.add_argument("--quiet", "-q", action="store_true",
                        help="Suppress terminal output (for background use)")
    parser.add_argument("--clear", action="store_true",
                        help="Clear notifications file before starting")

    args = parser.parse_args()

    # Determine which roles to watch
    if args.roles:
        roles = [r.strip().lower() for r in args.roles.split(",")]
        invalid = [r for r in roles if r not in ALL_ROLES]
        if invalid:
            print(f"Unknown roles: {invalid}")
            sys.exit(1)
    elif args.coders:
        roles = list(CODER_ROLES)
    elif args.researchers:
        roles = list(RESEARCHER_ROLES)
    else:
        roles = list(ALL_ROLES)

    # Clear notifications if requested
    if args.clear:
        notifications_path = get_notifications_file()
        if notifications_path.exists():
            notifications_path.unlink()

    # Load DAG if exists
    dag = load_dag()

    seen: set[str] = set()
    collected = 0
    start_time = time.time()

    # Emit start event
    emit_status("watcher_start", {
        "roles": roles,
        "role_count": len(roles),
        "timeout": args.timeout,
        "interval": args.interval,
        "notify_file": str(get_notifications_file()) if args.notify else None,
        "dag_loaded": bool(dag.get("chains")),
    }, args.notify, args.quiet)

    if not args.quiet:
        coders = [r for r in roles if r in CODER_ROLES]
        researchers = [r for r in roles if r in RESEARCHER_ROLES]
        print(f"   CODERS: {', '.join(coders) or 'none'}", flush=True)
        print(f"   RESEARCHERS: {', '.join(researchers) or 'none'}", flush=True)
        if args.notify:
            print(f"   📝 Notifications: {get_notifications_file()}", flush=True)
        if args.wait_for:
            print(f"   🎯 Will exit after {args.wait_for} response(s)", flush=True)
        print(flush=True)

    # Show initial queue status
    queues = check_queues(roles)
    if queues and not args.quiet:
        print(f"⏳ Pending tasks:", flush=True)
        for role, count in queues.items():
            meta = ROLE_META.get(role, {"icon": "🤖"})
            print(f"   {meta['icon']} {role}: {count}", flush=True)
        print(flush=True)

    try:
        while True:
            # Check for new responses
            new_responses = check_responses(roles, seen)

            for resp in new_responses:
                # Write/print notification
                write_notification(resp, args.notify)
                print_notification(resp, args.quiet)
                collected += 1

                # Check DAG triggers
                triggers = check_dag_triggers(resp, dag)
                for trigger in triggers:
                    write_notification(trigger, args.notify)
                    if not args.quiet:
                        print(f"🔗 DAG trigger: {trigger['next_role']} <- {trigger['triggered_by']}", flush=True)

            # Exit conditions
            if args.once:
                if not new_responses and not args.quiet:
                    print("No new responses.", flush=True)
                break

            if args.wait_for and collected >= args.wait_for:
                if not args.quiet:
                    print(f"✅ Collected {collected} response(s), exiting.", flush=True)
                break

            elapsed = time.time() - start_time
            if elapsed >= args.timeout:
                if not args.quiet:
                    print(f"⏱️ Timeout ({args.timeout}s), exiting.", flush=True)
                break

            time.sleep(args.interval)

    except KeyboardInterrupt:
        if not args.quiet:
            print("\n🛑 Interrupted.", flush=True)

    # Emit stop event
    emit_status("watcher_stop", {
        "reason": "complete",
        "collected": collected,
        "elapsed_seconds": round(time.time() - start_time, 1),
    }, args.notify, args.quiet)

    # Final summary
    remaining_queues = check_queues(roles)
    if remaining_queues and not args.quiet:
        print(f"\n⏳ Still pending:", flush=True)
        for role, count in remaining_queues.items():
            meta = ROLE_META.get(role, {"icon": "🤖"})
            print(f"   {meta['icon']} {role}: {count}", flush=True)

    sys.exit(0)


if __name__ == "__main__":
    main()
