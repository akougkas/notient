# /// script
# package = "notient-queue-processor-gemini"
# version = "1.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Queue processor for Notient multi-agent orchestration (Gemini CLI)"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Agent Queue Processor (Gemini CLI)

Watches a queue directory for .task files, executes them via Gemini CLI,
and writes responses. Zero external dependencies - stdlib only.

Usage:
    uv run queue-processor.py <agent_name>

    agent_name: archie, sage, or faye

Workflow:
    1. Orchestrator writes JSON .task file to agent's queue/
    2. This processor picks up task, runs `gemini -p`
    3. Writes JSON .response file to responses/
    4. Orchestrator reads response when ready
"""

import json
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

POLL_INTERVAL = 1.0
DEFAULT_MODEL = "gemini-2.5-pro"
VALID_MODELS = ("gemini-2.5-pro", "gemini-2.0-flash")
VALID_AGENTS = ("archie", "sage", "faye")


@dataclass
class Task:
    id: str
    prompt: str
    model: str = DEFAULT_MODEL
    context: str = ""
    priority: int = 0
    created_at: str = ""

    @classmethod
    def from_file(cls, path: Path) -> "Task":
        data = json.loads(path.read_text())
        return cls(
            id=data.get("id", path.stem),
            prompt=data.get("prompt", ""),
            model=data.get("model", DEFAULT_MODEL),
            context=data.get("context", ""),
            priority=data.get("priority", 0),
            created_at=data.get("created_at", ""),
        )


@dataclass
class Response:
    task_id: str
    agent: str
    status: str  # complete, failed
    output: str = ""
    error: Optional[str] = None
    model: str = DEFAULT_MODEL
    returncode: int = 0
    elapsed_seconds: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "agent": self.agent,
            "status": self.status,
            "output": self.output,
            "error": self.error,
            "model": self.model,
            "returncode": self.returncode,
            "elapsed_seconds": self.elapsed_seconds,
            "timestamp": self.timestamp,
        }


class QueueProcessor:
    def __init__(self, agent: str):
        self.agent = agent
        self.running = True
        self.current_task: Optional[str] = None

        # Paths
        repo = Path(__file__).parent.parent.parent
        self.queue_dir = repo / f".gemini/orchestration/{agent}/queue"
        self.response_dir = repo / f".gemini/orchestration/{agent}/responses"
        self.worktree = Path.home() / f"projects/_worktrees/notient-{agent}"

        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

    def _shutdown(self, *_):
        self.running = False

    def log(self, msg: str, level: str = "INFO"):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] [{self.agent.upper()}] {level}: {msg}", flush=True)

    def status(self, state: str, detail: str = ""):
        suffix = f" - {detail}" if detail else ""
        print(f"STATUS:{self.agent}:{state}{suffix}", flush=True)

    def setup(self) -> bool:
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self.response_dir.mkdir(parents=True, exist_ok=True)

        if not self.worktree.exists():
            self.log(f"Worktree missing: {self.worktree}", "ERROR")
            return False

        result = subprocess.run(["gemini", "--version"], capture_output=True)
        if result.returncode != 0:
            self.log("Gemini CLI not found", "ERROR")
            return False

        self.log(f"Queue: {self.queue_dir}")
        self.log(f"Worktree: {self.worktree}")
        return True

    def pending_tasks(self) -> list[Path]:
        if not self.queue_dir.exists():
            return []
        tasks = list(self.queue_dir.glob("*.task"))
        return sorted(tasks, key=lambda p: p.stat().st_mtime)

    def execute(self, task: Task) -> Response:
        self.current_task = task.id
        self.log(f"Executing: {task.id}")
        self.status("busy", task.id)

        prompt = task.prompt
        if task.context:
            prompt = f"{task.context}\n\n---\n\n{prompt}"

        # Gemini CLI format: gemini -p "prompt" --model "model" --yolo --output-format text
        cmd = [
            "gemini",
            "-p", prompt,
            "--model", task.model,
            "--yolo",
            "--output-format", "text",
        ]

        start = time.time()

        proc = subprocess.Popen(
            cmd,
            cwd=self.worktree,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        lines = []
        for line in iter(proc.stdout.readline, ""):
            print(f"  > {line}", end="", flush=True)
            lines.append(line)

        proc.wait()
        elapsed = time.time() - start
        stderr = proc.stderr.read()

        status = "complete" if proc.returncode == 0 else "failed"
        if proc.returncode != 0:
            self.log(f"Task failed (code={proc.returncode})", "ERROR")

        self.current_task = None

        return Response(
            task_id=task.id,
            agent=self.agent,
            status=status,
            output="".join(lines).strip(),
            error=stderr.strip() if stderr else None,
            model=task.model,
            returncode=proc.returncode,
            elapsed_seconds=round(elapsed, 2),
        )

    def save_response(self, response: Response, task_path: Path):
        out = self.response_dir / f"{response.task_id}.response"
        out.write_text(json.dumps(response.to_dict(), indent=2))
        self.log(f"Response: {out.name}")
        task_path.unlink(missing_ok=True)

    def run(self) -> int:
        self.log("Starting queue processor")
        self.status("starting")

        if not self.setup():
            self.status("error", "setup failed")
            return 1

        pending = self.pending_tasks()
        if pending:
            self.log(f"Found {len(pending)} pending task(s)")

        self.status("idle", "ready")

        while self.running:
            tasks = self.pending_tasks()
            if tasks:
                task_path = tasks[0]
                try:
                    task = Task.from_file(task_path)
                    response = self.execute(task)
                    self.save_response(response, task_path)
                except json.JSONDecodeError as e:
                    self.log(f"Invalid JSON: {e}", "ERROR")
                    task_path.unlink(missing_ok=True)
                except Exception as e:
                    self.log(f"Error: {e}", "ERROR")
                self.status("idle", "ready")
            else:
                time.sleep(POLL_INTERVAL)

        self.log("Stopped")
        self.status("stopped")
        return 0


def main():
    if len(sys.argv) < 2:
        print("Usage: uv run queue-processor.py <agent>")
        print(f"  agent: {', '.join(VALID_AGENTS)}")
        sys.exit(1)

    agent = sys.argv[1].lower()
    if agent not in VALID_AGENTS:
        print(f"Unknown agent: {agent}")
        print(f"  Valid: {', '.join(VALID_AGENTS)}")
        sys.exit(1)

    sys.exit(QueueProcessor(agent).run())


if __name__ == "__main__":
    main()
