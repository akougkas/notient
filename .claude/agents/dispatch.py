# /// script
# package = "notient-dispatch"
# version = "3.0.0"
# authors = ["Anthony Kougkas | https://akougkas.io"]
# description = "Dispatch tasks and manage agent lifecycle for Notient orchestration"
# repository = "https://github.com/akougkas/notient"
# license = "MIT"
# dependencies = []
# requires-python = ">=3.10"
# ///
"""
Notient Task Dispatcher v3.1 - Dynamic Two-Tier Orchestration

Two-tier agent architecture:
- Tier 1: Base Army (4 edit agents on Claude, boot with orchestrator)
- Tier 2: Dynamic Spawns (researchers + extra coders on demand)

Usage:
    # DISPATCH TASKS (use 'task' subcommand)
    uv run dispatch.py task <role> "<prompt>" --cli <cli>
    uv run dispatch.py task implementer "Add retry logic" --cli claude
    uv run dispatch.py task docs-fetcher "Get Preact docs" --cli gemini

    # LIFECYCLE MANAGEMENT
    uv run dispatch.py spawn <role> --cli <cli>     # Spawn dynamic agent
    uv run dispatch.py kill <instance>              # Kill dynamic agent
    uv run dispatch.py refresh <instance>           # Kill + respawn fresh
    uv run dispatch.py status                       # All agents with context %
    uv run dispatch.py list-instances               # Show dynamic instances

    # QUEUE INSPECTION
    uv run dispatch.py check <role>                 # Check queue status
    uv run dispatch.py responses <role>             # List completed responses

Examples:
    # Dispatch task to implementer
    uv run dispatch.py task implementer "Add retry logic to LLM calls" --cli claude

    # Spawn extra implementer on Gemini for parallel work
    uv run dispatch.py spawn implementer --cli gemini
    # Creates: implementer-gemini (with temp worktree)

    # Check agent status and context usage
    uv run dispatch.py status

    # Refresh exhausted agent (kills and respawns fresh)
    uv run dispatch.py refresh implementer-claude
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration Loading
# ═══════════════════════════════════════════════════════════════════════════════

def get_repo_root() -> Path:
    """Get the main repository root."""
    return Path(__file__).parent.parent.parent


def load_config() -> dict:
    """Load configuration from config.json."""
    config_path = Path(__file__).parent.parent / "orchestration/config.json"
    if config_path.exists():
        return json.loads(config_path.read_text())
    raise FileNotFoundError(f"Config not found: {config_path}")


CONFIG = load_config()

# ═══════════════════════════════════════════════════════════════════════════════
# Role Definitions (from config)
# ═══════════════════════════════════════════════════════════════════════════════

EDIT_AGENTS = tuple(CONFIG["agent_categories"]["edit_agents"])
READ_ONLY_AGENTS = tuple(CONFIG["agent_categories"]["read_only_agents"])
VALID_ROLES = EDIT_AGENTS + READ_ONLY_AGENTS
BASE_ARMY_ROLES = tuple(CONFIG["base_army"]["agents"])
VALID_CLIS = tuple(CONFIG["models"].keys())

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
# Instance Registry
# ═══════════════════════════════════════════════════════════════════════════════

def get_instances_path() -> Path:
    """Get path to instances.json."""
    return get_repo_root() / ".claude/orchestration/state/instances.json"


def load_instances() -> dict:
    """Load instances registry."""
    path = get_instances_path()
    if path.exists():
        return json.loads(path.read_text())
    return {"base_army": {}, "dynamic": {}}


def save_instances(instances: dict):
    """Save instances registry."""
    path = get_instances_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(instances, indent=2))


def get_all_instances() -> dict:
    """Get all instances (base + dynamic) merged."""
    data = load_instances()
    return {**data.get("base_army", {}), **data.get("dynamic", {})}


def is_base_army_instance(instance_name: str) -> bool:
    """Check if instance is part of base army."""
    data = load_instances()
    return instance_name in data.get("base_army", {})


# ═══════════════════════════════════════════════════════════════════════════════
# Path Utilities
# ═══════════════════════════════════════════════════════════════════════════════

def get_paths(role: str) -> tuple[Path, Path]:
    """Get queue and response paths for a role."""
    repo = get_repo_root()
    queue = repo / f".claude/orchestration/{role}/queue"
    responses = repo / f".claude/orchestration/{role}/responses"
    return queue, responses


def get_worktree_path(instance: str, is_temp: bool = False) -> Path:
    """Get worktree path for an instance."""
    if is_temp:
        temp_base = Path(CONFIG["worktrees"]["temp_base"])
        return temp_base / instance
    else:
        perm_base = Path(CONFIG["worktrees"]["permanent_base"]).expanduser()
        # Extract role from instance name (e.g., "implementer-claude" -> "implementer")
        role = instance.split("-")[0]
        return perm_base / f"notient-{role}"


def get_role_category(role: str) -> str:
    """Get the category (coder/researcher/edit/read_only) for a role."""
    if role in EDIT_AGENTS:
        return "edit"
    return "read_only"


def get_core_identity_path(role: str) -> str:
    """Get the path to the core identity file for a role's category."""
    meta = ROLE_META.get(role, {})
    category = meta.get("category", "coder")
    if category == "researcher":
        return ".claude/orchestration/core/RESEARCHER.md"
    return ".claude/orchestration/core/CODER.md"


def get_role_identity_path(role: str) -> str:
    """Get the path to the role-specific identity file."""
    return f".claude/orchestration/{role}/ROLE.md"


# ═══════════════════════════════════════════════════════════════════════════════
# Instance Name Generation
# ═══════════════════════════════════════════════════════════════════════════════

def get_cli_short_name(cli: str) -> str:
    """Get short name for CLI (e.g., 'claude-opus-4-5' -> 'claude')."""
    return cli.split("-")[0] if "-" in cli else cli


def generate_instance_name(role: str, cli: str) -> str:
    """Generate unique instance name for dynamic spawn."""
    cli_short = get_cli_short_name(cli)
    base_name = f"{role}-{cli_short}"
    
    instances = get_all_instances()
    
    # Check if base name is available (and not base army)
    if base_name not in instances:
        return base_name
    
    # Find next available number
    existing_numbers = []
    for name in instances:
        if name.startswith(base_name):
            suffix = name[len(base_name):]
            if suffix.startswith("-") and suffix[1:].isdigit():
                existing_numbers.append(int(suffix[1:]))
            elif suffix == "":
                existing_numbers.append(1)
    
    next_num = max(existing_numbers, default=1) + 1
    return f"{base_name}-{next_num}"


# ═══════════════════════════════════════════════════════════════════════════════
# Worktree Management
# ═══════════════════════════════════════════════════════════════════════════════

def create_temp_worktree(instance: str, role: str) -> Path:
    """Create a temporary worktree for a dynamic edit agent."""
    worktree_path = get_worktree_path(instance, is_temp=True)
    main_repo = Path(CONFIG["worktrees"]["main_repo"])
    base_branch = CONFIG["worktrees"]["base_branch"]
    
    # Create worktree directory
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Create new branch for this instance
    branch_name = f"{role}/{instance}"
    
    try:
        # Create worktree
        subprocess.run(
            ["git", "worktree", "add", "-b", branch_name, str(worktree_path), base_branch],
            cwd=main_repo,
            check=True,
            capture_output=True
        )
        print(f"  Created worktree: {worktree_path}")
        return worktree_path
    except subprocess.CalledProcessError as e:
        print(f"  Error creating worktree: {e.stderr.decode()}")
        return None


def remove_temp_worktree(instance: str):
    """Remove a temporary worktree."""
    worktree_path = get_worktree_path(instance, is_temp=True)
    main_repo = Path(CONFIG["worktrees"]["main_repo"])
    
    if worktree_path.exists():
        try:
            # Remove worktree
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=main_repo,
                check=True,
                capture_output=True
            )
            print(f"  Removed worktree: {worktree_path}")
        except subprocess.CalledProcessError:
            # Force remove directory if git worktree fails
            shutil.rmtree(worktree_path, ignore_errors=True)


def sync_file_to_worktree(worktree: Path, rel_path: str) -> bool:
    """Sync a file from main workspace to worktree."""
    repo = get_repo_root()
    source = repo / rel_path
    
    if not source.exists():
        return False
    
    if not worktree.exists():
        return False
    
    target = worktree / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    
    if target.exists() or target.is_symlink():
        target.unlink()
    
    try:
        target.symlink_to(source)
        return True
    except OSError:
        shutil.copy2(source, target)
        return True


def sync_role_files(role: str, worktree: Path):
    """Sync identity files to worktree."""
    synced = []
    
    # Sync core identity
    core_path = get_core_identity_path(role)
    if sync_file_to_worktree(worktree, core_path):
        synced.append(Path(core_path).name)
    
    # Sync role identity
    role_path = get_role_identity_path(role)
    if sync_file_to_worktree(worktree, role_path):
        synced.append("ROLE.md")
    
    if synced:
        print(f"  Synced: {', '.join(synced)}")


# ═══════════════════════════════════════════════════════════════════════════════
# mprocs Integration
# ═══════════════════════════════════════════════════════════════════════════════

def mprocs_ctl(command: dict) -> bool:
    """Send command to mprocs via --ctl."""
    server = CONFIG["mprocs"]["server"]
    ctl_json = json.dumps(command)
    
    try:
        result = subprocess.run(
            ["mprocs", "--ctl", ctl_json, "--server", server],
            capture_output=True,
            text=True
        )
        return result.returncode == 0
    except FileNotFoundError:
        print("  Error: mprocs not found")
        return False


def spawn_mprocs_pane(instance: str, cmd: str, cwd: str) -> bool:
    """Spawn a new mprocs pane for dynamic agent."""
    command = {
        "c": "add-proc",
        "name": instance,
        "cmd": cmd,
        "cwd": cwd
    }
    return mprocs_ctl(command)


def kill_mprocs_pane(instance: str) -> bool:
    """Kill an mprocs pane."""
    # First try to stop gracefully
    mprocs_ctl({"c": "stop-proc", "name": instance})
    # Then remove
    return mprocs_ctl({"c": "remove-proc", "name": instance})


def get_mprocs_procs() -> list[str]:
    """Get list of running mprocs processes."""
    server = CONFIG["mprocs"]["server"]
    try:
        result = subprocess.run(
            ["mprocs", "--ctl", '{"c":"get-procs"}', "--server", server],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return [p["name"] for p in data.get("procs", [])]
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return []


# ═══════════════════════════════════════════════════════════════════════════════
# Spawn / Kill / Refresh Commands
# ═══════════════════════════════════════════════════════════════════════════════

def spawn_agent(role: str, cli: str, model: str = None) -> str:
    """Spawn a new dynamic agent."""
    if role not in VALID_ROLES:
        print(f"Error: Unknown role '{role}'")
        print(f"Valid roles: {', '.join(VALID_ROLES)}")
        return None
    
    if cli not in VALID_CLIS:
        print(f"Error: Unknown CLI '{cli}'")
        print(f"Valid CLIs: {', '.join(VALID_CLIS)}")
        return None
    
    # Get model from config if not specified
    if model is None:
        role_default = CONFIG["role_defaults"].get(role, {})
        model = role_default.get("model", CONFIG["models"].get(cli, ""))
    
    # Generate instance name
    instance_name = generate_instance_name(role, cli)
    
    # Determine category and setup
    category = get_role_category(role)
    main_repo = CONFIG["worktrees"]["main_repo"]
    
    if category == "edit":
        # Edit agent: create temp worktree
        worktree = create_temp_worktree(instance_name, role)
        if worktree is None:
            return None
        cwd = str(worktree)
        sync_role_files(role, worktree)
    else:
        # Read-only agent: run in main repo
        worktree = None
        cwd = main_repo
    
    # Build command
    cmd = (
        f"NOTIENT_ROLE={role} "
        f"NOTIENT_INSTANCE={instance_name} "
        f"NOTIENT_CATEGORY={'coder' if category == 'edit' else 'researcher'} "
        f"uv run {main_repo}/.claude/agents/queue-processor.py {role} --instance {instance_name}"
    )
    
    # Spawn in mprocs
    if not spawn_mprocs_pane(instance_name, cmd, cwd):
        print(f"Error: Failed to spawn mprocs pane for {instance_name}")
        if worktree:
            remove_temp_worktree(instance_name)
        return None
    
    # Register instance
    instances = load_instances()
    instances["dynamic"][instance_name] = {
        "role": role,
        "model": model,
        "cli": cli,
        "status": "running",
        "worktree": str(worktree) if worktree else None,
        "is_base": False,
        "context_percent": 0,
        "spawned_at": datetime.now(timezone.utc).isoformat(),
        "last_task": None
    }
    save_instances(instances)
    
    meta = ROLE_META.get(role, {})
    icon = meta.get("icon", "🤖")
    print(f"\n{icon} Spawned: {instance_name}")
    print(f"  Role: {role}")
    print(f"  CLI: {cli}")
    print(f"  Model: {model}")
    if worktree:
        print(f"  Worktree: {worktree}")
    print()
    
    return instance_name


def kill_agent(instance: str) -> bool:
    """Kill a dynamic agent."""
    instances = load_instances()
    
    # Check if it's a base army agent
    if instance in instances.get("base_army", {}):
        print(f"Error: Cannot kill base army agent '{instance}'")
        print("Use 'refresh' to restart base army agents")
        return False
    
    # Check if it's a dynamic agent
    if instance not in instances.get("dynamic", {}):
        print(f"Error: Unknown instance '{instance}'")
        return False
    
    info = instances["dynamic"][instance]
    
    # Kill mprocs pane
    if not kill_mprocs_pane(instance):
        print(f"Warning: Failed to kill mprocs pane for {instance}")
    
    # Remove worktree if exists
    if info.get("worktree"):
        remove_temp_worktree(instance)
    
    # Remove from registry
    del instances["dynamic"][instance]
    save_instances(instances)
    
    print(f"\n🗑️  Killed: {instance}")
    print()
    
    return True


def refresh_agent(instance: str) -> bool:
    """Refresh an agent (kill + respawn fresh) for context exhaustion."""
    instances = load_instances()
    all_instances = get_all_instances()
    
    if instance not in all_instances:
        print(f"Error: Unknown instance '{instance}'")
        return False
    
    info = all_instances[instance]
    role = info["role"]
    cli = info["cli"]
    model = info["model"]
    is_base = info.get("is_base", False)
    
    print(f"\n🔄 Refreshing: {instance}")
    
    if is_base:
        # For base army: just stop and let mprocs restart
        # We need to signal the process to exit
        kill_mprocs_pane(instance)
        
        # Update registry to mark as refreshing
        instances["base_army"][instance]["status"] = "refreshing"
        instances["base_army"][instance]["context_percent"] = 0
        save_instances(instances)
        
        print(f"  Base army agent will restart automatically via mprocs")
        print()
    else:
        # For dynamic: kill and respawn
        worktree = info.get("worktree")
        
        # Kill
        kill_mprocs_pane(instance)
        if worktree:
            remove_temp_worktree(instance)
        
        # Remove from dynamic
        del instances["dynamic"][instance]
        save_instances(instances)
        
        # Respawn with same settings
        spawn_agent(role, cli, model)
    
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# Status Commands
# ═══════════════════════════════════════════════════════════════════════════════

def show_status():
    """Show status of all agents with context usage."""
    instances = load_instances()
    running_procs = get_mprocs_procs()
    
    print("\n📊 AGENT STATUS")
    print("=" * 70)
    
    # Base Army
    print("\n🏰 BASE ARMY (always running)")
    print("-" * 70)
    
    for name, info in instances.get("base_army", {}).items():
        is_running = name in running_procs
        status_icon = "🟢" if is_running else "🔴"
        role = info.get("role", "?")
        meta = ROLE_META.get(role, {"icon": "🤖"})
        ctx = info.get("context_percent", 0)
        ctx_bar = _context_bar(ctx)
        
        last_task = info.get("last_task", "-")
        if last_task and len(last_task) > 15:
            last_task = last_task[:15] + "..."
        
        print(f"  {status_icon} {meta['icon']} {name:<25} {ctx_bar} {ctx:>5.1f}%  Last: {last_task}")
    
    # Dynamic
    dynamic = instances.get("dynamic", {})
    if dynamic:
        print("\n⚡ DYNAMIC SPAWNS")
        print("-" * 70)
        
        for name, info in dynamic.items():
            is_running = name in running_procs
            status_icon = "🟢" if is_running else "🔴"
            role = info.get("role", "?")
            meta = ROLE_META.get(role, {"icon": "🤖"})
            ctx = info.get("context_percent", 0)
            ctx_bar = _context_bar(ctx)
            cli = info.get("cli", "?")
            
            print(f"  {status_icon} {meta['icon']} {name:<25} {ctx_bar} {ctx:>5.1f}%  CLI: {cli}")
    else:
        print("\n⚡ DYNAMIC SPAWNS: (none)")
    
    print()


def _context_bar(percent: float, width: int = 10) -> str:
    """Generate a visual context bar."""
    filled = int(percent / 100 * width)
    empty = width - filled
    
    if percent < 50:
        color = "\033[32m"  # Green
    elif percent < 80:
        color = "\033[33m"  # Yellow
    else:
        color = "\033[31m"  # Red
    
    return f"{color}[{'█' * filled}{'░' * empty}]\033[0m"


def list_instances():
    """List all dynamic instances."""
    instances = load_instances()
    dynamic = instances.get("dynamic", {})
    
    if not dynamic:
        print("\nNo dynamic instances running.")
        print("Use 'dispatch.py spawn <role> --cli <cli>' to spawn agents.")
        print()
        return
    
    print("\n⚡ DYNAMIC INSTANCES")
    print("=" * 70)
    
    for name, info in dynamic.items():
        role = info.get("role", "?")
        cli = info.get("cli", "?")
        model = info.get("model", "?")
        spawned = info.get("spawned_at", "?")
        worktree = info.get("worktree", "main repo")
        
        meta = ROLE_META.get(role, {"icon": "🤖", "desc": role})
        
        print(f"\n  {meta['icon']} {name}")
        print(f"     Role: {role} ({meta['desc']})")
        print(f"     CLI: {cli}, Model: {model}")
        print(f"     Worktree: {worktree or 'main repo'}")
        print(f"     Spawned: {spawned}")
    
    print()


# ═══════════════════════════════════════════════════════════════════════════════
# Task Dispatch (Enhanced)
# ═══════════════════════════════════════════════════════════════════════════════

def dispatch_task(
    role: str,
    prompt: str,
    model: str = None,
    context: str = "",
    cli: str = None,
    instance: str = None
) -> str:
    """Dispatch a task to a role's queue."""
    queue_dir, _ = get_paths(role)
    queue_dir.mkdir(parents=True, exist_ok=True)
    
    # Get defaults from config
    role_default = CONFIG["role_defaults"].get(role, {})
    
    # Default CLI from role defaults or fallback to claude
    if cli is None:
        cli = role_default.get("cli", "claude")
    
    # Default model for CLI
    if model is None:
        model = CONFIG["models"].get(cli, CONFIG["models"]["claude"])
    
    # Determine target instance
    if instance is None:
        # Find appropriate instance for this role + cli
        all_instances = get_all_instances()
        cli_short = get_cli_short_name(cli)

        # Look for base army first (if base role and using claude)
        if role in BASE_ARMY_ROLES and cli == "claude":
            instance = f"{role}-claude"
        else:
            # Look for dynamic instance matching role + cli
            for name, info in all_instances.items():
                if info.get("role") == role and info.get("cli") == cli:
                    instance = name
                    break

            # Warn if no instance found for non-claude CLI
            if instance is None and cli != "claude":
                print(f"\n⚠️  WARNING: No {cli} instance found for {role}")
                print(f"   The task will be queued but NO agent will pick it up!")
                print(f"   To fix, first spawn the agent:")
                print(f"     uv run dispatch.py spawn {role} --cli {cli}")
                print()

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
        "category": ROLE_META.get(role, {}).get("category", "coder"),
        "prompt": full_prompt,
        "model": model,
        "cli": cli,
        "instance": instance,
        "context": context,
        "cli_platform": cli,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    
    task_file = queue_dir / f"{task_id}.task"
    task_file.write_text(json.dumps(task, indent=2))
    
    meta = ROLE_META.get(role, {})
    icon = meta.get("icon", "🤖")
    
    print(f"\n{icon} Dispatched: {task_id} -> {role}")
    print(f"  Instance: {instance or 'auto-select'}")
    print(f"  CLI: {cli}")
    print(f"  Model: {model}")
    print(f"  Prompt: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")
    print()
    
    # Sync identity files to worktree if permanent
    if instance and not is_base_army_instance(instance):
        worktree_path = get_worktree_path(instance, is_temp=True)
        if worktree_path.exists():
            sync_role_files(role, worktree_path)
    
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
    """Show status of all roles (legacy compatibility)."""
    print("\n📊 All Roles Queue Status:\n")
    
    for role in EDIT_AGENTS:
        queue_dir, resp_dir = get_paths(role)
        pending = len(list(queue_dir.glob("*.task"))) if queue_dir.exists() else 0
        completed = len(list(resp_dir.glob("*.response"))) if resp_dir.exists() else 0
        meta = ROLE_META.get(role, {})
        icon = meta.get("icon", "🤖")
        status = "🟡" if pending > 0 else ("📬" if completed > 0 else "⚪")
        print(f"  {status} {icon} {role}: {pending} pending, {completed} responses")
    
    print()
    
    for role in READ_ONLY_AGENTS:
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
        description="Dispatch tasks and manage agent lifecycle",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Subcommands:
  task <role> "<prompt>"      Dispatch task to role (REQUIRED for task dispatch)
  spawn <role> --cli <cli>    Spawn a dynamic agent
  kill <instance>             Kill a dynamic agent
  refresh <instance>          Kill + respawn (for context exhaustion)
  status                      Show all agents with context usage
  list-instances              Show dynamic instances
  check <role>                Check queue status for a role
  responses <role>            List responses for a role

Examples:
    # Dispatch task to base army (CORRECT SYNTAX)
    uv run dispatch.py task implementer "Add retry logic" --cli claude
    uv run dispatch.py task docs-fetcher "Get Preact docs" --cli gemini

    # Spawn extra implementer on Gemini
    uv run dispatch.py spawn implementer --cli gemini

    # Check agent status
    uv run dispatch.py status

    # Check queue for a role
    uv run dispatch.py check implementer

    # List responses for a role
    uv run dispatch.py responses implementer

Roles: {', '.join(VALID_ROLES)}
CLIs: {', '.join(VALID_CLIS)}
        """
    )

    # Add subparsers (REQUIRED - no more positional args on main parser)
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # task subcommand (THE primary way to dispatch tasks)
    task_parser = subparsers.add_parser("task", help="Dispatch a task to a role")
    task_parser.add_argument("role", help="Target role")
    task_parser.add_argument("prompt", help="Task prompt")
    task_parser.add_argument("--cli", default="claude", help="CLI platform (default: claude)")
    task_parser.add_argument("--model", "-m", help="Model override")
    task_parser.add_argument("--context", "-c", default="", help="Additional context")
    task_parser.add_argument("--instance", help="Target specific instance")

    # spawn subcommand
    spawn_parser = subparsers.add_parser("spawn", help="Spawn a dynamic agent")
    spawn_parser.add_argument("role", help="Role to spawn")
    spawn_parser.add_argument("--cli", required=True, help="CLI platform")
    spawn_parser.add_argument("--model", "-m", help="Model override")

    # kill subcommand
    kill_parser = subparsers.add_parser("kill", help="Kill a dynamic agent")
    kill_parser.add_argument("instance", help="Instance name to kill")

    # refresh subcommand
    refresh_parser = subparsers.add_parser("refresh", help="Refresh agent (context exhaustion)")
    refresh_parser.add_argument("instance", help="Instance name to refresh")

    # status subcommand
    subparsers.add_parser("status", help="Show all agents with context usage")

    # list-instances subcommand
    subparsers.add_parser("list-instances", help="Show dynamic instances")

    # check subcommand (queue status)
    check_parser = subparsers.add_parser("check", help="Check queue status for a role")
    check_parser.add_argument("role", help="Role to check")

    # responses subcommand
    responses_parser = subparsers.add_parser("responses", help="List responses for a role")
    responses_parser.add_argument("role", help="Role to list responses for")

    args = parser.parse_args()

    # Helper for role validation
    def validate_role(role: str) -> str:
        role = role.lower()
        if role not in VALID_ROLES:
            print(f"Error: Unknown role '{role}'")
            print(f"\nEdit Agents: {', '.join(EDIT_AGENTS)}")
            print(f"Read-Only Agents: {', '.join(READ_ONLY_AGENTS)}")
            sys.exit(1)
        return role

    # Helper for CLI validation
    def validate_cli(cli: str) -> str:
        if cli not in VALID_CLIS:
            print(f"Error: Unknown CLI '{cli}'")
            print(f"Valid CLIs: {', '.join(VALID_CLIS)}")
            sys.exit(1)
        return cli

    # Handle subcommands
    if args.command == "task":
        role = validate_role(args.role)
        cli = validate_cli(args.cli)
        dispatch_task(role, args.prompt, args.model, args.context, cli, args.instance)
    elif args.command == "spawn":
        role = validate_role(args.role)
        cli = validate_cli(args.cli)
        spawn_agent(role, cli, args.model)
    elif args.command == "kill":
        kill_agent(args.instance)
    elif args.command == "refresh":
        refresh_agent(args.instance)
    elif args.command == "status":
        show_status()
    elif args.command == "list-instances":
        list_instances()
    elif args.command == "check":
        role = validate_role(args.role)
        check_queue(role)
    elif args.command == "responses":
        role = validate_role(args.role)
        list_responses(role)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
