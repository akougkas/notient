# /// script
# package = "notient-queue-processor"
# version = "4.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Queue processor for Notient dynamic two-tier agent orchestration"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Role Queue Processor v4 - Dynamic Two-Tier Support

Enhanced queue processor with instance tracking for both base army and dynamic spawns:
- Instance-aware: tracks context usage per instance
- Registry integration: updates instances.json with real-time stats
- Multi-CLI support: claude, gemini, cursor-agent, opencode
- Rich terminal display with context monitoring

Usage:
    uv run queue-processor.py <role> [--instance <instance-name>]

    role: implementer, simplifier, validator, tester, architect, advisor,
          docs-fetcher, codebase-navigator, world-knowledge

    --instance: Instance name (e.g., implementer-claude, implementer-gemini-2)
                If not provided, uses role name for compatibility

Workflow:
    1. Orchestrator dispatches task via dispatch.py
    2. This processor picks up task, runs appropriate CLI
    3. Parses events and displays rich formatted output
    4. Updates instances.json with context usage
    5. Writes JSON .response file to responses/
    6. Orchestrator reads response when ready
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

POLL_INTERVAL = 1.0

# Load CLI configuration from central config file
def load_config() -> dict:
    """Load CLI configuration from config.json."""
    config_path = Path(__file__).parent.parent / "orchestration/config.json"
    if config_path.exists():
        return json.loads(config_path.read_text())
    # Fallback defaults if config missing
    return {
        "models": {
            "claude": "claude-opus-4-5-20251101",
            "gemini": "gemini-3.0-pro",
            "cursor-agent": "gpt-5.2-codex-high",
            "opencode": "glm-4.7",
        },
        "cli": {
            "claude": {"cmd": "claude", "flags": ["--print", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"]},
            "gemini": {"cmd": "gemini", "flags": ["--output-format", "stream-json"]},
            "cursor-agent": {"cmd": "cursor-agent", "flags": ["--print", "--output-format", "stream-json"]},
            "opencode": {"cmd": "opencode", "subcommand": "run", "flags": ["--format", "json"]},
        },
        "agent_categories": {
            "edit_agents": ["implementer", "simplifier", "validator", "tester"],
            "read_only_agents": ["advisor", "docs-fetcher", "codebase-navigator", "world-knowledge", "architect"]
        }
    }

CONFIG = load_config()
DEFAULT_MODELS = CONFIG["models"]
CLI_CONFIGS = CONFIG["cli"]

# Role definitions from config
EDIT_AGENTS = tuple(CONFIG["agent_categories"]["edit_agents"])
READ_ONLY_AGENTS = tuple(CONFIG["agent_categories"]["read_only_agents"])
VALID_ROLES = EDIT_AGENTS + READ_ONLY_AGENTS

# Role themes for display
ROLE_THEME = {
    # Coders
    "implementer": {"icon": "🔨", "color": "cyan", "name": "IMPLEMENTER", "category": "coder"},
    "simplifier": {"icon": "✨", "color": "green", "name": "SIMPLIFIER", "category": "coder"},
    "validator": {"icon": "🔍", "color": "yellow", "name": "VALIDATOR", "category": "coder"},
    "tester": {"icon": "🧪", "color": "magenta", "name": "TESTER", "category": "coder"},
    "architect": {"icon": "📐", "color": "blue", "name": "ARCHITECT", "category": "coder"},
    "advisor": {"icon": "💡", "color": "white", "name": "ADVISOR", "category": "coder"},
    # Researchers
    "docs-fetcher": {"icon": "📚", "color": "blue", "name": "DOCS-FETCHER", "category": "researcher"},
    "codebase-navigator": {"icon": "🗺️", "color": "cyan", "name": "CODEBASE-NAVIGATOR", "category": "researcher"},
    "world-knowledge": {"icon": "🌐", "color": "magenta", "name": "WORLD-KNOWLEDGE", "category": "researcher"},
}

# ═══════════════════════════════════════════════════════════════════════════════
# Instance Registry Integration
# ═══════════════════════════════════════════════════════════════════════════════

def get_repo_root() -> Path:
    """Get main repo root."""
    return Path(__file__).parent.parent.parent


def get_instances_path() -> Path:
    """Get path to instances.json."""
    return get_repo_root() / ".claude/orchestration/state/instances.json"


def load_instances() -> dict:
    """Load instances registry."""
    path = get_instances_path()
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return {"base_army": {}, "dynamic": {}}
    return {"base_army": {}, "dynamic": {}}


def save_instances(instances: dict):
    """Save instances registry."""
    path = get_instances_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(instances, indent=2))


def update_instance_status(instance: str, status: str, context_percent: float = None, last_task: str = None):
    """Update instance status in registry."""
    instances = load_instances()
    
    # Find instance in base_army or dynamic
    if instance in instances.get("base_army", {}):
        target = instances["base_army"][instance]
    elif instance in instances.get("dynamic", {}):
        target = instances["dynamic"][instance]
    else:
        # Instance not registered, skip update
        return
    
    target["status"] = status
    target["last_active"] = datetime.now(timezone.utc).isoformat()
    
    if context_percent is not None:
        target["context_percent"] = context_percent
    
    if last_task is not None:
        target["last_task"] = last_task
    
    save_instances(instances)


# ═══════════════════════════════════════════════════════════════════════════════
# ANSI Colors and Formatting
# ═══════════════════════════════════════════════════════════════════════════════

class C:
    """ANSI color codes for terminal styling."""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    ITALIC = "\033[3m"
    UNDERLINE = "\033[4m"

    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    GRAY = "\033[90m"

    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"
    BRIGHT_WHITE = "\033[97m"

    BG_BLACK = "\033[40m"
    BG_RED = "\033[41m"
    BG_GREEN = "\033[42m"
    BG_YELLOW = "\033[43m"
    BG_BLUE = "\033[44m"
    BG_MAGENTA = "\033[45m"
    BG_CYAN = "\033[46m"
    BG_WHITE = "\033[47m"


def get_role_color(role: str) -> str:
    """Get the ANSI color code for a role."""
    theme = ROLE_THEME.get(role, {"color": "white"})
    return getattr(C, theme["color"].upper(), C.WHITE)


# ═══════════════════════════════════════════════════════════════════════════════
# ASCII Art Components
# ═══════════════════════════════════════════════════════════════════════════════

class Box:
    """ASCII box drawing characters."""
    H = "─"
    V = "│"
    TL = "╭"
    TR = "╮"
    BL = "╰"
    BR = "╯"
    LT = "├"
    RT = "┤"
    TT = "┬"
    BT = "┴"
    X = "┼"

    DH = "═"
    DV = "║"
    DTL = "╔"
    DTR = "╗"
    DBL = "╚"
    DBR = "╝"


def box_line(width: int, left: str = Box.TL, right: str = Box.TR, fill: str = Box.H) -> str:
    """Create a box line."""
    return f"{left}{fill * (width - 2)}{right}"


def box_text(text: str, width: int, left: str = Box.V, right: str = Box.V, align: str = "left") -> str:
    """Create a box text line with padding."""
    inner_width = width - 4
    if len(text) > inner_width:
        text = text[:inner_width - 3] + "..."

    if align == "center":
        text = text.center(inner_width)
    elif align == "right":
        text = text.rjust(inner_width)
    else:
        text = text.ljust(inner_width)

    return f"{left} {text} {right}"


# ═══════════════════════════════════════════════════════════════════════════════
# Tool Icons and Formatting
# ═══════════════════════════════════════════════════════════════════════════════

TOOL_ICONS = {
    "Bash": ("🖥️ ", C.YELLOW),
    "Read": ("📖", C.BLUE),
    "Edit": ("✏️ ", C.GREEN),
    "Write": ("📝", C.GREEN),
    "Glob": ("🔍", C.CYAN),
    "Grep": ("🔎", C.CYAN),
    "WebFetch": ("🌐", C.MAGENTA),
    "WebSearch": ("🔍", C.MAGENTA),
    "TodoWrite": ("📋", C.YELLOW),
    "Task": ("📦", C.BLUE),
    "TaskOutput": ("📤", C.BLUE),
    "NotebookEdit": ("📓", C.GREEN),
    "AskUserQuestion": ("❓", C.YELLOW),
    "Skill": ("⚡", C.CYAN),
}


def get_tool_display(tool_name: str) -> tuple[str, str]:
    """Get icon and color for a tool."""
    if tool_name.startswith("mcp__"):
        return ("🔌", C.MAGENTA)
    return TOOL_ICONS.get(tool_name, ("🔧", C.WHITE))


# ═══════════════════════════════════════════════════════════════════════════════
# Data Classes
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Task:
    id: str
    prompt: str
    model: str = ""
    cli: str = "claude"
    role: str = ""
    category: str = ""
    context: str = ""
    instance: str = ""
    priority: int = 0
    created_at: str = ""

    @classmethod
    def from_file(cls, path: Path) -> "Task":
        data = json.loads(path.read_text())
        return cls(
            id=data.get("id", path.stem),
            prompt=data.get("prompt", ""),
            model=data.get("model", DEFAULT_MODELS.get(data.get("cli", "claude"), "")),
            cli=data.get("cli", "claude"),
            role=data.get("role", ""),
            category=data.get("category", ""),
            context=data.get("context", ""),
            instance=data.get("instance", ""),
            priority=data.get("priority", 0),
            created_at=data.get("created_at", ""),
        )


@dataclass
class ToolCall:
    """Track a tool call and its result."""
    name: str
    tool_id: str
    input_data: dict
    description: str = ""
    result: Optional[str] = None
    is_error: bool = False
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None


@dataclass
class ExecutionStats:
    """Track execution statistics.

    Context Window Tracking:
    - Claude models have 200K token context window
    - input_tokens: tokens sent TO the model (prompt + conversation)
    - output_tokens: tokens generated BY the model
    - cache_read_tokens: tokens read from cache (NOT counted against limit)
    - cache_creation_tokens: tokens written to cache

    For one-shot tasks (--print mode), each task gets a fresh 200K context.
    For continued sessions (--continue), context accumulates across turns.
    """
    tool_calls: list[ToolCall] = field(default_factory=list)
    files_read: list[str] = field(default_factory=list)
    files_written: list[str] = field(default_factory=list)
    files_edited: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    total_cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    num_turns: int = 0

    # Claude models context window (Opus 4.5, Sonnet 4.5, Haiku 4.5)
    CONTEXT_LIMIT: int = 200_000

    @property
    def context_used(self) -> int:
        """Total tokens used in this task/session.

        Note: cache_read_tokens are PRE-COMPUTED and don't count against limit.
        Only input_tokens (fresh) + output_tokens count toward context usage.
        """
        return self.input_tokens + self.output_tokens

    @property
    def context_remaining(self) -> int:
        """Tokens remaining in context window."""
        return max(0, self.CONTEXT_LIMIT - self.context_used)

    @property
    def context_percent_used(self) -> float:
        """Percentage of context window used."""
        if self.CONTEXT_LIMIT == 0:
            return 0.0
        return round((self.context_used / self.CONTEXT_LIMIT) * 100, 1)

    @property
    def context_is_critical(self) -> bool:
        """True if context usage exceeds 80% (needs attention)."""
        return self.context_percent_used >= 80.0

    @property
    def context_is_exhausted(self) -> bool:
        """True if context usage exceeds 95% (should refresh)."""
        return self.context_percent_used >= 95.0


@dataclass
class Response:
    task_id: str
    role: str
    status: str
    instance: str = ""
    output: str = ""
    error: Optional[str] = None
    model: str = ""
    cli: str = "claude"
    returncode: int = 0
    elapsed_seconds: float = 0.0
    stats: Optional[ExecutionStats] = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        result = {
            "task_id": self.task_id,
            "role": self.role,
            "instance": self.instance,
            "status": self.status,
            "output": self.output,
            "error": self.error,
            "model": self.model,
            "cli": self.cli,
            "returncode": self.returncode,
            "elapsed_seconds": self.elapsed_seconds,
            "timestamp": self.timestamp,
        }
        if self.stats:
            result["stats"] = {
                "tool_calls": len(self.stats.tool_calls),
                "files_read": self.stats.files_read,
                "files_written": self.stats.files_written,
                "files_edited": self.stats.files_edited,
                "commands_run": len(self.stats.commands_run),
                "total_cost_usd": self.stats.total_cost_usd,
                "tokens": {
                    "input": self.stats.input_tokens,
                    "output": self.stats.output_tokens,
                    "cache_read": self.stats.cache_read_tokens,
                    "cache_creation": self.stats.cache_creation_tokens,
                },
                "context": {
                    "used": self.stats.context_used,
                    "remaining": self.stats.context_remaining,
                    "percent_used": self.stats.context_percent_used,
                    "limit": self.stats.CONTEXT_LIMIT,
                    "is_critical": self.stats.context_is_critical,
                    "is_exhausted": self.stats.context_is_exhausted,
                },
            }
        return result


# ═══════════════════════════════════════════════════════════════════════════════
# Event Display
# ═══════════════════════════════════════════════════════════════════════════════

class EventDisplay:
    """Handles formatting and display of CLI streaming events."""

    def __init__(self, role: str, instance: str, task: Task):
        self.role = role
        self.instance = instance
        self.task = task
        self.theme = ROLE_THEME.get(role, {"icon": "🤖", "color": "white", "name": role.upper()})
        self.color = get_role_color(role)
        self.stats = ExecutionStats()
        self.pending_tools: dict[str, ToolCall] = {}
        self.current_text = ""
        self.start_time = time.time()
        self.width = min(os.get_terminal_size().columns, 100)
        self._timer_thread: Optional[threading.Thread] = None
        self._timer_running = False

    def start(self):
        """Display task header with clear WORKING ON banner."""
        icon = self.theme["icon"]
        name = self.theme["name"]
        model = self.task.model if self.task.model else "DEFAULT"
        cli = self.task.cli.upper()
        category = self.theme.get("category", "agent").upper()

        # Extract actual task (after "Then execute this task:")
        prompt = self.task.prompt
        if "Then execute this task:" in prompt:
            prompt = prompt.split("Then execute this task:")[-1].strip()

        # Truncate prompt for display
        prompt_line1 = prompt[:self.width - 8].replace("\n", " ")
        prompt_line2 = ""
        if len(prompt) > self.width - 8:
            prompt_line2 = prompt[self.width - 8:self.width * 2 - 16].replace("\n", " ")
            if len(prompt) > self.width * 2 - 16:
                prompt_line2 += "..."

        print()
        print(f"{C.BRIGHT_WHITE}{C.BG_BLUE} ▶ WORKING {C.RESET} {self.color}{icon} {name}{C.RESET}")
        print(f"{C.DIM}   Instance: {self.instance}{C.RESET}")
        print()
        print(f"{self.color}{Box.DTL}{Box.DH * (self.width - 2)}{Box.DTR}{C.RESET}")
        print(f"{self.color}{Box.DV} {C.BRIGHT_WHITE}CLI:{C.RESET} {cli:<15} {self.color}{C.BRIGHT_WHITE}MODEL:{C.RESET} {model:<30} {self.color}{Box.DV}{C.RESET}")
        print(f"{self.color}{Box.DV}{Box.H * (self.width - 2)}{Box.DV}{C.RESET}")
        print(f"{self.color}{Box.DV} {C.BRIGHT_WHITE}TASK:{C.RESET} {self.task.id:<56} {self.color}{Box.DV}{C.RESET}")
        print(f"{self.color}{Box.DV}{Box.H * (self.width - 2)}{Box.DV}{C.RESET}")
        print(f"{self.color}{Box.DV} 📝 {prompt_line1:<{self.width - 6}}{Box.DV}{C.RESET}")
        if prompt_line2:
            print(f"{self.color}{Box.DV}    {prompt_line2:<{self.width - 6}}{Box.DV}{C.RESET}")
        print(f"{self.color}{Box.DBL}{Box.DH * (self.width - 2)}{Box.DBR}{C.RESET}")
        print()

    def stop(self):
        """Stop any running display updates."""
        self._timer_running = False

    def elapsed_str(self) -> str:
        """Format elapsed time."""
        elapsed = time.time() - self.start_time
        mins, secs = divmod(int(elapsed), 60)
        if mins > 0:
            return f"{mins}m {secs}s"
        return f"{secs}s"

    def handle_event(self, event: dict) -> Optional[str]:
        """Handle a streaming event and return any final result text."""
        event_type = event.get("type")
        subtype = event.get("subtype")

        if event_type == "system":
            if subtype == "init":
                model = event.get("model", "unknown")
                print(f"  {C.DIM}⚙️  Initialized: {model}{C.RESET}")
            elif subtype == "hook_response":
                pass
            else:
                pass

        elif event_type == "assistant":
            self._handle_assistant_event(event)

        elif event_type == "user":
            self._handle_tool_result(event)

        elif event_type == "result":
            return self._handle_result(event)

        return None

    def _handle_assistant_event(self, event: dict):
        """Handle assistant message events (text and tool_use)."""
        message = event.get("message", {})
        content = message.get("content", [])

        for item in content:
            item_type = item.get("type")

            if item_type == "text":
                text = item.get("text", "")
                if text and text != self.current_text:
                    new_text = text[len(self.current_text):]
                    if new_text.strip():
                        lines = new_text.split("\n")
                        for line in lines:
                            if line.strip():
                                print(f"  {C.WHITE}💭 {line.strip()}{C.RESET}")
                    self.current_text = text

            elif item_type == "tool_use":
                self._handle_tool_use(item)

    def _handle_tool_use(self, item: dict):
        """Handle a tool_use event."""
        tool_name = item.get("name", "unknown")
        tool_id = item.get("id", "")
        input_data = item.get("input", {})

        icon, color = get_tool_display(tool_name)

        tool_call = ToolCall(
            name=tool_name,
            tool_id=tool_id,
            input_data=input_data,
            description=input_data.get("description", ""),
        )
        self.pending_tools[tool_id] = tool_call
        self.stats.tool_calls.append(tool_call)

        if tool_name == "Bash":
            cmd = input_data.get("command", "")[:60]
            desc = input_data.get("description", "")
            self.stats.commands_run.append(cmd)
            print(f"  {color}{icon} Bash:{C.RESET} {C.YELLOW}{cmd}{C.RESET}")
            if desc:
                print(f"     {C.DIM}└─ {desc}{C.RESET}")

        elif tool_name == "Read":
            file_path = input_data.get("file_path", input_data.get("target_file", input_data.get("path", "")))
            self.stats.files_read.append(file_path)
            short_path = self._short_path(file_path)
            print(f"  {color}{icon} Read:{C.RESET} {C.BLUE}{short_path}{C.RESET}")

        elif tool_name in ("Edit", "Write", "StrReplace"):
            file_path = input_data.get("file_path", input_data.get("target_file", input_data.get("path", "")))
            short_path = self._short_path(file_path)

            if tool_name in ("Edit", "StrReplace"):
                self.stats.files_edited.append(file_path)
                old_str = input_data.get("old_string", "")
                new_str = input_data.get("new_string", "")
                diff_lines = self._compute_diff_summary(old_str, new_str)
                print(f"  {color}{icon} Edit:{C.RESET} {C.GREEN}{short_path}{C.RESET}")
                if diff_lines:
                    print(f"     {C.DIM}└─ {diff_lines}{C.RESET}")
            else:
                self.stats.files_written.append(file_path)
                content = input_data.get("contents", "")
                line_count = content.count("\n") + 1 if content else 0
                print(f"  {color}{icon} Write:{C.RESET} {C.GREEN}{short_path}{C.RESET} ({line_count} lines)")

        elif tool_name == "Glob":
            pattern = input_data.get("pattern", input_data.get("glob_pattern", ""))
            print(f"  {color}{icon} Glob:{C.RESET} {C.CYAN}{pattern}{C.RESET}")

        elif tool_name == "Grep":
            pattern = input_data.get("pattern", "")
            path = input_data.get("path", "")
            print(f"  {color}{icon} Grep:{C.RESET} {C.CYAN}'{pattern}'{C.RESET} in {path or 'workspace'}")

        elif tool_name.startswith("mcp__"):
            mcp_name = tool_name.split("__")[-1] if "__" in tool_name else tool_name
            print(f"  {color}{icon} MCP:{C.RESET} {C.MAGENTA}{mcp_name}{C.RESET}")

        else:
            print(f"  {color}{icon} {tool_name}{C.RESET}")

    def _handle_tool_result(self, event: dict):
        """Handle a tool result event."""
        message = event.get("message", {})
        content = message.get("content", [])
        tool_result = event.get("tool_use_result", {})

        for item in content:
            if item.get("type") == "tool_result":
                tool_id = item.get("tool_use_id", "")
                is_error = item.get("is_error", False)
                result_content = item.get("content", "")

                if tool_id in self.pending_tools:
                    tool = self.pending_tools[tool_id]
                    tool.end_time = time.time()
                    tool.is_error = is_error
                    tool.result = result_content[:500] if result_content else None

                    if is_error:
                        print(f"     {C.RED}└─ ✗ Error{C.RESET}")
                    else:
                        if tool.name == "Glob" and result_content:
                            files = result_content.strip().split("\n")
                            print(f"     {C.DIM}└─ Found {len(files)} file(s){C.RESET}")
                        elif tool.name == "Grep" and result_content:
                            matches = len(result_content.strip().split("\n"))
                            print(f"     {C.DIM}└─ {matches} match(es){C.RESET}")
                        elif tool.name == "Read" and result_content:
                            lines = result_content.count("\n") + 1
                            print(f"     {C.DIM}└─ {lines} lines{C.RESET}")
                        elif tool.name == "Bash":
                            stdout = tool_result.get("stdout", "")
                            stderr = tool_result.get("stderr", "")
                            if stdout:
                                preview = stdout.strip().split("\n")[0][:50]
                                print(f"     {C.DIM}└─ {preview}{'...' if len(stdout) > 50 else ''}{C.RESET}")
                            elif stderr:
                                print(f"     {C.YELLOW}└─ {stderr[:50]}...{C.RESET}")

    def _handle_result(self, event: dict) -> str:
        """Handle the final result event."""
        is_error = event.get("is_error", False)
        duration_ms = event.get("duration_ms", 0)
        result_text = event.get("result", "")
        total_cost = event.get("total_cost_usd", 0)
        usage = event.get("usage", {})
        num_turns = event.get("num_turns", 0)

        # Extract all token metrics
        self.stats.total_cost_usd = total_cost
        self.stats.input_tokens = usage.get("input_tokens", 0)
        self.stats.output_tokens = usage.get("output_tokens", 0)
        self.stats.cache_read_tokens = usage.get("cache_read_input_tokens", 0)
        self.stats.cache_creation_tokens = usage.get("cache_creation_input_tokens", 0)
        self.stats.num_turns = num_turns

        print()
        elapsed = duration_ms / 1000

        if is_error:
            status_line = f"❌ Failed │ {elapsed:.1f}s │ ${total_cost:.4f}"
            print(f"{C.RED}{box_line(self.width)}{C.RESET}")
            print(f"{C.RED}{box_text(status_line, self.width)}{C.RESET}")
        else:
            tool_count = len(self.stats.tool_calls)
            files_count = len(set(self.stats.files_read + self.stats.files_written + self.stats.files_edited))
            ctx_pct = self.stats.context_percent_used
            ctx_remaining_k = self.stats.context_remaining // 1000

            status_line = f"✅ Complete │ {elapsed:.1f}s │ ${total_cost:.4f} │ {tool_count} tools │ {files_count} files"
            print(f"{self.color}{box_line(self.width)}{C.RESET}")
            print(f"{self.color}{box_text(status_line, self.width)}{C.RESET}")

            # Context usage with color coding
            if self.stats.context_is_exhausted:
                ctx_color = C.BRIGHT_RED
                ctx_warning = " ⚠️  REFRESH RECOMMENDED"
            elif self.stats.context_is_critical:
                ctx_color = C.YELLOW
                ctx_warning = " ⚡ approaching limit"
            else:
                ctx_color = C.GREEN
                ctx_warning = ""

            ctx_line = f"📊 Context: {ctx_pct}% used │ {ctx_remaining_k}K tokens remaining{ctx_warning}"
            print(f"{self.color}{box_text(f'{ctx_color}{ctx_line}{C.RESET}', self.width)}{C.RESET}")

            # Show token breakdown for transparency
            token_line = f"   Input: {self.stats.input_tokens:,} │ Output: {self.stats.output_tokens:,} │ Cache: {self.stats.cache_read_tokens:,}"
            print(f"{self.color}{box_text(f'{C.DIM}{token_line}{C.RESET}', self.width)}{C.RESET}")

        modified = list(set(self.stats.files_written + self.stats.files_edited))
        if modified:
            print(f"{self.color}{box_line(self.width, Box.LT, Box.RT)}{C.RESET}")
            for f in modified:
                short = self._short_path(f)
                action = "✏️" if f in self.stats.files_edited else "📝"
                print(f"{self.color}{box_text(f'{action} {short}', self.width)}{C.RESET}")

        print(f"{self.color}{box_line(self.width, Box.BL, Box.BR)}{C.RESET}")
        print()

        return result_text

    def _short_path(self, path: str) -> str:
        """Shorten a file path for display."""
        if not path:
            return ""
        for prefix in ["/home/akougkas/projects/notient/", "src/", "./"]:
            if path.startswith(prefix):
                path = path[len(prefix):]
        return path

    def _compute_diff_summary(self, old: str, new: str) -> str:
        """Compute a simple diff summary."""
        if not old and not new:
            return ""

        old_lines = old.count("\n") + 1 if old else 0
        new_lines = new.count("\n") + 1 if new else 0

        if old_lines == 0:
            return f"+{new_lines} lines"
        elif new_lines == 0:
            return f"-{old_lines} lines"

        diff = new_lines - old_lines
        if diff > 0:
            return f"+{diff} lines ({old_lines} → {new_lines})"
        elif diff < 0:
            return f"{diff} lines ({old_lines} → {new_lines})"
        else:
            return f"~{new_lines} lines (modified)"


# ═══════════════════════════════════════════════════════════════════════════════
# Queue Processor
# ═══════════════════════════════════════════════════════════════════════════════

class QueueProcessor:
    def __init__(self, role: str, instance: str = None):
        self.role = role
        self.instance = instance or role  # Fallback to role name for backward compat
        self.running = True
        self.current_task: Optional[str] = None
        self.current_process: Optional[subprocess.Popen] = None
        self.current_display: Optional[EventDisplay] = None

        repo = get_repo_root()
        self.queue_dir = repo / f".claude/orchestration/{role}/queue"
        self.response_dir = repo / f".claude/orchestration/{role}/responses"
        
        # Determine worktree from environment or config
        self.worktree = Path(os.environ.get("NOTIENT_WORKTREE", Path.cwd()))

        signal.signal(signal.SIGINT, self._handle_interrupt)
        signal.signal(signal.SIGTERM, self._shutdown)

    def _shutdown(self, *_):
        """Clean shutdown."""
        self.running = False
        if self.current_process:
            self.current_process.terminate()

    def _handle_interrupt(self, *_):
        """Handle SIGINT - interrupt current task or shutdown if idle."""
        if self.current_process:
            print(f"\n{C.YELLOW}⚡ Interrupting current task...{C.RESET}")
            self.current_process.terminate()
        else:
            self.running = False

    def log(self, msg: str, level: str = "INFO"):
        ts = datetime.now().strftime("%H:%M:%S")
        color = C.WHITE
        if level == "ERROR":
            color = C.RED
        elif level == "WARN":
            color = C.YELLOW
        elif level == "SUCCESS":
            color = C.GREEN
        print(f"{C.DIM}[{ts}]{C.RESET} {color}[{self.instance.upper()}]{C.RESET} {msg}", flush=True)

    def status(self, state: str, detail: str = ""):
        theme = ROLE_THEME.get(self.role, {"icon": "🤖"})
        icon = theme["icon"]
        color = get_role_color(self.role)

        if state == "idle":
            print()
            print(f"{C.DIM}{C.BG_BLACK} ⏸ IDLE {C.RESET} {color}{icon} {self.instance.upper()}{C.RESET} {C.DIM}— Waiting for tasks...{C.RESET}", flush=True)
            print()
            # Update registry
            update_instance_status(self.instance, "idle")
        elif state == "busy":
            update_instance_status(self.instance, "running")

    def setup(self) -> bool:
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self.response_dir.mkdir(parents=True, exist_ok=True)

        # Check default CLI availability
        result = subprocess.run(["claude", "--version"], capture_output=True)
        if result.returncode != 0:
            self.log("Claude CLI not found (other CLIs may still work)", "WARN")

        self.log(f"Queue: {self.queue_dir}")
        self.log(f"Working dir: {Path.cwd()}")
        return True

    def pending_tasks(self) -> list[Path]:
        if not self.queue_dir.exists():
            return []
        tasks = list(self.queue_dir.glob("*.task"))
        return sorted(tasks, key=lambda p: p.stat().st_mtime)

    def _build_command(self, task: Task, prompt: str) -> list[str]:
        """Build CLI command: <cmd> [subcommand] [--model X] [flags...] "prompt"."""
        cli_config = CLI_CONFIGS.get(task.cli, CLI_CONFIGS["claude"])
        cmd = [cli_config["cmd"]]

        # Add subcommand if specified (e.g., "run" for opencode)
        if cli_config.get("subcommand"):
            cmd.append(cli_config["subcommand"])

        # Add model flag
        if task.model:
            cmd.extend(["--model", task.model])

        # Add all configured flags
        cmd.extend(cli_config.get("flags", []))

        # Prompt is always positional (last argument)
        cmd.append(prompt)

        return cmd

    def execute(self, task: Task) -> Response:
        self.current_task = task.id
        self.status("busy")

        display = EventDisplay(self.role, self.instance, task)
        self.current_display = display
        display.start()

        prompt = task.prompt
        if task.context:
            prompt = f"{task.context}\n\n---\n\n{prompt}"

        cmd = self._build_command(task, prompt)

        cli_name = task.cli.upper()
        self.log(f"Using CLI: {cli_name} ({CLI_CONFIGS.get(task.cli, {}).get('cmd', 'unknown')})")

        start = time.time()
        result_text = ""
        error_text = None
        returncode = 0

        try:
            self.current_process = subprocess.Popen(
                cmd,
                cwd=Path.cwd(),  # Use current working directory (worktree)
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            for line in iter(self.current_process.stdout.readline, ""):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    result = display.handle_event(event)
                    if result is not None:
                        result_text = result
                except json.JSONDecodeError:
                    print(f"  {C.DIM}> {line.strip()}{C.RESET}")

            self.current_process.wait()
            returncode = self.current_process.returncode
            error_text = self.current_process.stderr.read().strip() or None

        except Exception as e:
            error_text = str(e)
            returncode = 1
        finally:
            self.current_process = None
            display.stop()

        elapsed = time.time() - start
        status = "complete" if returncode == 0 else "failed"

        if returncode != 0 and not error_text:
            status = "interrupted"

        self.current_task = None
        self.current_display = None

        # Update instance registry with context usage
        update_instance_status(
            self.instance,
            "idle",
            context_percent=display.stats.context_percent_used,
            last_task=task.id
        )

        return Response(
            task_id=task.id,
            role=self.role,
            instance=self.instance,
            status=status,
            output=result_text,
            error=error_text,
            model=task.model,
            cli=task.cli,
            returncode=returncode,
            elapsed_seconds=round(elapsed, 2),
            stats=display.stats,
        )

    def save_response(self, response: Response, task_path: Path):
        out = self.response_dir / f"{response.task_id}.response"
        out.write_text(json.dumps(response.to_dict(), indent=2))
        self.log(f"Response saved: {out.name}", "SUCCESS")
        task_path.unlink(missing_ok=True)

    def run(self) -> int:
        theme = ROLE_THEME.get(self.role, {"icon": "🤖", "name": self.role.upper()})
        category = theme.get("category", "unknown")
        color = get_role_color(self.role)

        print()
        print(f"{color}{Box.DTL}{Box.DH * 68}{Box.DTR}{C.RESET}")
        print(f"{color}{Box.DV}  {theme['icon']} {self.instance.upper():<30} {'│':^3} {category.upper():<8} {'│':^3} READY    {Box.DV}{C.RESET}")
        print(f"{color}{Box.DV}{Box.DH * 68}{Box.DV}{C.RESET}")
        print(f"{color}{Box.DV}  📍 Queue: .claude/orchestration/{self.role}/queue/{' ' * (35 - len(self.role))}{Box.DV}{C.RESET}")
        print(f"{color}{Box.DV}  🔧 Available CLIs: claude, gemini, cursor-agent, opencode{' ' * 8}{Box.DV}{C.RESET}")
        print(f"{color}{Box.DBL}{Box.DH * 68}{Box.DBR}{C.RESET}")
        print()

        if not self.setup():
            self.log("Setup failed", "ERROR")
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
                    self.log(f"Invalid JSON in task file: {e}", "ERROR")
                    task_path.unlink(missing_ok=True)
                except Exception as e:
                    self.log(f"Error processing task: {e}", "ERROR")
                self.status("idle", "ready")
            else:
                time.sleep(POLL_INTERVAL)

        self.log("Processor stopped")
        return 0


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Queue processor for Notient agent orchestration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Usage:
    uv run queue-processor.py <role> [--instance <instance-name>]

Roles: {', '.join(VALID_ROLES)}

The --instance flag is used to identify this processor in the instance registry.
If not provided, the role name is used (for backward compatibility).

Examples:
    # Base army agent
    uv run queue-processor.py implementer --instance implementer-claude

    # Dynamic spawn
    uv run queue-processor.py implementer --instance implementer-gemini-2
        """
    )
    
    parser.add_argument("role", help=f"Role: {', '.join(VALID_ROLES)}")
    parser.add_argument("--instance", "-i", help="Instance name for registry tracking")
    
    args = parser.parse_args()

    role = args.role.lower()
    if role not in VALID_ROLES:
        print(f"{C.RED}Unknown role: {role}{C.RESET}")
        print(f"\nEdit Agents: {', '.join(EDIT_AGENTS)}")
        print(f"Read-Only Agents: {', '.join(READ_ONLY_AGENTS)}")
        sys.exit(1)

    instance = args.instance or os.environ.get("NOTIENT_INSTANCE", role)
    
    sys.exit(QueueProcessor(role, instance).run())


if __name__ == "__main__":
    main()
