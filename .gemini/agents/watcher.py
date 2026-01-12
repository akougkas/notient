# /// script
# package = "notient-watcher-gemini"
# version = "1.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Watch agent response queues and notify when tasks complete (Gemini CLI)"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Response Watcher (Gemini CLI)

Polls agent response directories and outputs notifications when tasks complete.

Usage:
    uv run watcher.py [OPTIONS]

Options:
    --agents AGENTS     Comma-separated agents to watch (default: all)
    --timeout SECONDS   Exit after N seconds (default: 300 = 5 min)
    --interval SECONDS  Poll interval (default: 3)
    --once              Check once and exit (no polling)
    --wait-for N        Exit after N responses collected
    --verbose           Show polling activity
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
    return repo / f".gemini/orchestration/{agent}/responses"


def get_queue_dir(agent: str) -> Path:
    repo = Path(__file__).parent.parent.parent
    return repo / f".gemini/orchestration/{agent}/queue"


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
    print(f"{ '='*60}", flush=True)

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
    parser.add_argument("--agents", default=",".join(ALL_AGENTS), help="Agents to watch")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Seconds to poll")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Poll interval")
    parser.add_argument("--once", action="store_true", help="Check once and exit")
    parser.add_argument("--wait-for", type=int, default=0, help="Exit after N responses")
    parser.add_argument("--verbose", action="store_true", help="Show polling activity")

    args = parser.parse_args()
    agents = [a.strip() for a in args.agents.split(",")]

    start_time = time.time()
    seen = set()
    collected = 0

    # Initial check (silent, just to seed 'seen')
    check_responses(agents, seen)

    if args.once:
        new = check_responses(agents, seen)
        for r in new:
            notify(r)
        return

    log(f"Watching: {', '.join(agents)}", args.verbose)
    log(f"Timeout: {args.timeout}s, Interval: {args.interval}s", args.verbose)

    try:
        while True:
            # Check elapsed time
            elapsed_time = time.time() - start_time
            if args.timeout > 0 and elapsed_time > args.timeout:
                log("Timeout reached", args.verbose)
                break

            # Check for new responses
            new = check_responses(agents, seen)
            for r in new:
                notify(r)
                collected += 1

            if args.wait_for > 0 and collected >= args.wait_for:
                log(f"Collected {collected} responses, finishing", args.verbose)
                break

            # Check pending tasks (for status reporting)
            pending = check_queues(agents)
            if pending and args.verbose:
                log(f"Pending: {pending}", True)

            time.sleep(args.interval)

    except KeyboardInterrupt:
        log("Interrupted by user", args.verbose)

    log("Stopped", args.verbose)


if __name__ == "__main__":
    main()
