# /// script
# package = "notient-watcher"
# version = "1.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Watch agent response queues and notify when tasks complete"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Response Watcher

Polls agent response directories and outputs notifications when tasks complete.
Designed to run in background (via Bash run_in_background or Ctrl+B subagent).

Usage:
    uv run watcher.py [OPTIONS]

Options:
    --agents AGENTS     Comma-separated agents to watch (default: all)
    --timeout SECONDS   Exit after N seconds (default: 300 = 5 min)
    --interval SECONDS  Poll interval (default: 3)
    --once              Check once and exit (no polling)
    --wait-for N        Exit after N responses collected
    --verbose           Show polling activity

Examples:
    uv run watcher.py                          # Watch all, 5 min timeout
    uv run watcher.py --agents archie,sage     # Watch specific agents
    uv run watcher.py --wait-for 2             # Exit after 2 responses
    uv run watcher.py --once                   # Single check, no wait
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

ALL_AGENTS = ("archie", "sage", "faye")
DEFAULT_TIMEOUT = 300  # 5 minutes
DEFAULT_INTERVAL = 3   # seconds


def get_response_dir(agent: str) -> Path:
    repo = Path(__file__).parent.parent.parent
    return repo / f".claude/orchestration/{agent}/responses"


def get_queue_dir(agent: str) -> Path:
    repo = Path(__file__).parent.parent.parent
    return repo / f".claude/orchestration/{agent}/queue"


def check_responses(agents: list[str], seen: set[str]) -> list[dict]:
    """Check for new responses, return list of new ones."""
    new_responses = []

    for agent in agents:
        response_dir = get_response_dir(agent)
        if not response_dir.exists():
            continue

        for resp_file in response_dir.glob("*.response"):
            resp_key = f"{agent}:{resp_file.name}"
            if resp_key in seen:
                continue

            seen.add(resp_key)

            try:
                data = json.loads(resp_file.read_text())
                new_responses.append({
                    "agent": agent,
                    "task_id": data.get("task_id", resp_file.stem),
                    "status": data.get("status", "unknown"),
                    "elapsed": data.get("elapsed_seconds", 0),
                    "output_preview": data.get("output", "")[:200],
                    "file": str(resp_file),
                })
            except (json.JSONDecodeError, IOError):
                continue

    return new_responses


def check_queues(agents: list[str]) -> dict[str, int]:
    """Check pending tasks in queues."""
    counts = {}
    for agent in agents:
        queue_dir = get_queue_dir(agent)
        if queue_dir.exists():
            count = len(list(queue_dir.glob("*.task")))
            if count > 0:
                counts[agent] = count
    return counts


def notify(response: dict):
    """Output notification for a completed response."""
    status_icon = "✓" if response["status"] == "complete" else "✗"
    agent = response["agent"]
    task_id = response["task_id"]
    elapsed = response["elapsed"]

    print(f"\n{'='*60}", flush=True)
    print(f"📬 {status_icon} {agent.upper()} completed: {task_id} ({elapsed}s)", flush=True)
    print(f"{'='*60}", flush=True)

    if response["output_preview"]:
        preview = response["output_preview"].replace("\n", "\n   ")
        print(f"   {preview}{'...' if len(response['output_preview']) >= 200 else ''}", flush=True)

    print(flush=True)


def log(msg: str, verbose: bool):
    """Conditional logging."""
    if verbose:
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {msg}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Watch agent response queues")
    parser.add_argument("--agents", "-a", default=",".join(ALL_AGENTS),
                        help=f"Comma-separated agents (default: {','.join(ALL_AGENTS)})")
    parser.add_argument("--timeout", "-t", type=int, default=DEFAULT_TIMEOUT,
                        help=f"Exit after N seconds (default: {DEFAULT_TIMEOUT})")
    parser.add_argument("--interval", "-i", type=int, default=DEFAULT_INTERVAL,
                        help=f"Poll interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--once", action="store_true",
                        help="Check once and exit")
    parser.add_argument("--wait-for", "-w", type=int, default=0,
                        help="Exit after N responses collected")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show polling activity")

    args = parser.parse_args()

    agents = [a.strip().lower() for a in args.agents.split(",")]
    invalid = [a for a in agents if a not in ALL_AGENTS]
    if invalid:
        print(f"Unknown agents: {invalid}")
        print(f"Valid: {ALL_AGENTS}")
        sys.exit(1)

    seen: set[str] = set()
    collected = 0
    start_time = time.time()

    print(f"🔍 Watching: {', '.join(agents)}", flush=True)
    if args.wait_for:
        print(f"   Will exit after {args.wait_for} response(s)", flush=True)
    elif not args.once:
        print(f"   Timeout: {args.timeout}s | Interval: {args.interval}s", flush=True)
    print(flush=True)

    # Show initial queue status
    queues = check_queues(agents)
    if queues:
        print(f"⏳ Pending tasks: {queues}", flush=True)
        print(flush=True)

    while True:
        # Check for new responses
        new_responses = check_responses(agents, seen)

        for resp in new_responses:
            notify(resp)
            collected += 1

        # Exit conditions
        if args.once:
            if not new_responses:
                print("No new responses.", flush=True)
            break

        if args.wait_for and collected >= args.wait_for:
            print(f"✅ Collected {collected} response(s), exiting.", flush=True)
            break

        elapsed = time.time() - start_time
        if elapsed >= args.timeout:
            print(f"⏱️ Timeout ({args.timeout}s), exiting.", flush=True)
            break

        # Poll interval
        log(f"Polling... ({int(elapsed)}s elapsed, {collected} collected)", args.verbose)
        time.sleep(args.interval)

    # Final summary
    remaining_queues = check_queues(agents)
    if remaining_queues:
        print(f"\n⏳ Still pending: {remaining_queues}", flush=True)

    sys.exit(0)


if __name__ == "__main__":
    main()
