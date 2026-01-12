# Migration: Claude Code → Gemini CLI Orchestration

## Objective

Mirror the `.claude/` multi-agent orchestration system to `.gemini/` using Gemini CLI. Create a fully independent, parallel system that can replace Claude Code entirely if needed.

## Source Reference

The Claude Code implementation lives in `.claude/` with these key components:

```
.claude/
├── CLAUDE.md                           # Project instructions
├── settings.local.json                 # Hooks config
├── mprocs.yaml                         # Workspace config
├── agents/
│   ├── queue-processor.py              # Executes tasks via claude --print
│   ├── dispatch.py                     # Enqueues tasks
│   └── watcher.py                      # Watches for responses
├── hooks/
│   ├── orchestrator-session-start.sh   # Injects pending responses
│   ├── orchestrator-stop.sh            # Reminds about responses
│   └── orchestrator-check-responses.sh # Manual check
└── orchestration/
    ├── NEXT-SESSION-PROMPT.md
    ├── orchestrator/CLAUDE.md
    ├── archie/{queue,responses}/
    ├── sage/{queue,responses}/
    └── faye/{queue,responses}/
```

---

## Target Structure

Create `.gemini/` with this structure:

```
.gemini/
├── GEMINI.md                           # Project instructions (adapt from project CLAUDE.md)
├── settings.json                       # Gemini settings + hooks
├── mprocs-gemini.yaml                  # Separate workspace for Gemini agents
│
├── agents/
│   ├── queue-processor.py              # Adapted for: gemini -p --model gemini-2.5-pro
│   ├── dispatch.py                     # Copy from .claude (unchanged)
│   └── watcher.py                      # Copy from .claude (unchanged)
│
├── hooks/
│   ├── orchestrator-session-start.sh   # Adapt for Gemini hook format
│   └── orchestrator-check-responses.sh # Copy (unchanged)
│
└── orchestration/
    ├── NEXT-SESSION-PROMPT.md          # Gemini-specific session context
    ├── orchestrator/GEMINI.md          # Orchestrator instructions for Gemini
    ├── archie/
    │   ├── queue/.gitkeep
    │   └── responses/.gitkeep
    ├── sage/
    │   ├── queue/.gitkeep
    │   └── responses/.gitkeep
    └── faye/
        ├── queue/.gitkeep
        └── responses/.gitkeep
```

---

## Detailed Adaptations

### 1. queue-processor.py

**Source:** `.claude/agents/queue-processor.py`

**Changes required:**

```python
# BEFORE (Claude)
cmd = [
    "claude",
    "--print",
    "--model", task.model,
    "--dangerously-skip-permissions",
    "--output-format", "text",
    prompt,
]

# AFTER (Gemini)
cmd = [
    "gemini",
    "-p", prompt,  # Note: prompt comes after -p flag
    "--model", task.model,
    "--yolo",  # Equivalent to --dangerously-skip-permissions
    "--output-format", "text",
]
```

**Model mapping:**
- Default model: `gemini-2.5-pro` (user has Ultra plan)
- Fallback: `gemini-2.0-flash` (only if explicitly requested)

**Update UV script header:**
```python
# /// script
# package = "notient-queue-processor-gemini"
# version = "1.0.0"
# ...
```

**Update constants:**
```python
DEFAULT_MODEL = "gemini-2.5-pro"  # Was "haiku"
VALID_MODELS = ("gemini-2.5-pro", "gemini-2.0-flash")
```

**Update worktree paths:**
```python
# Queue/response dirs now under .gemini/
self.queue_dir = repo / f".gemini/orchestration/{agent}/queue"
self.response_dir = repo / f".gemini/orchestration/{agent}/responses"
# Worktrees remain the same (shared between Claude and Gemini)
self.worktree = Path.home() / f"projects/_worktrees/notient-{agent}"
```

### 2. dispatch.py

**Source:** `.claude/agents/dispatch.py`

**Changes required:**

```python
# Update paths
ORCH_DIR = ".gemini/orchestration"  # Was ".claude/orchestration"

# Update default model
DEFAULT_MODEL = "gemini-2.5-pro"
VALID_MODELS = ("gemini-2.5-pro", "gemini-2.0-flash")

# Update UV script header
# package = "notient-dispatch-gemini"
```

### 3. watcher.py

**Source:** `.claude/agents/watcher.py`

**Changes required:**

```python
# Update paths only
def get_response_dir(agent: str) -> Path:
    repo = Path(__file__).parent.parent.parent
    return repo / f".gemini/orchestration/{agent}/responses"

def get_queue_dir(agent: str) -> Path:
    repo = Path(__file__).parent.parent.parent
    return repo / f".gemini/orchestration/{agent}/queue"

# Update UV script header
# package = "notient-watcher-gemini"
```

### 4. settings.json (Hooks Configuration)

**Gemini CLI hook format differs from Claude Code.**

Create `.gemini/settings.json`:

```json
{
  "model": {
    "name": "gemini-2.5-pro"
  },
  "tools": {
    "autoAccept": ["read_file", "list_directory", "glob", "search_file_content"]
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "orchestrator-session-start",
            "type": "command",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/orchestrator-session-start.sh",
            "description": "Inject pending agent responses"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "orchestrator-session-end",
            "type": "command",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/orchestrator-check-responses.sh",
            "description": "Check for pending responses"
          }
        ]
      }
    ]
  }
}
```

### 5. Hook Scripts

**orchestrator-session-start.sh adaptation:**

Gemini hooks receive JSON via stdin and must output JSON:

```bash
#!/usr/bin/env bash
# Gemini CLI SessionStart Hook

set -euo pipefail

# Read hook input (Gemini provides JSON via stdin)
INPUT=$(cat)

# ... same response checking logic as Claude version ...

# Output format for Gemini (different from Claude)
cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ${ESCAPED_CONTEXT}
  }
}
EOF
```

**Key difference:** Gemini uses `hookSpecificOutput.additionalContext` instead of Claude's `hookSpecificOutput.additionalContext` (actually same structure, but verify).

### 6. mprocs-gemini.yaml

Create separate mprocs config for Gemini workspace:

```yaml
# Notient Multi-Agent Orchestration (Gemini CLI)
# Usage: mprocs -c .gemini/mprocs-gemini.yaml

server: 127.0.0.1:4051  # Different port from Claude (4050)
log_dir: <CONFIG_DIR>/logs

procs:
  repos:
    cwd: /home/akougkas/projects/notient
    shell: "YAZI_CONFIG_HOME=/home/akougkas/projects/notient/.claude/yazi-config /home/akougkas/projects/notient/.claude/bin/yazi"
    autostart: true
    stop: "SIGTERM"

  orchestrator:
    cwd: /home/akougkas/projects/notient
    env:
      NOTIENT_ORCHESTRATOR: "1"
      GEMINI_PROJECT_DIR: "/home/akougkas/projects/notient"
    shell: "gemini"
    autostart: true
    stop: "SIGTERM"

  archie:
    cwd: /home/akougkas/projects/notient
    env:
      NOTIENT_AGENT: "archie"
    shell: "uv run .gemini/agents/queue-processor.py archie"
    autostart: true
    stop: "SIGTERM"

  sage:
    cwd: /home/akougkas/projects/notient
    env:
      NOTIENT_AGENT: "sage"
    shell: "uv run .gemini/agents/queue-processor.py sage"
    autostart: true
    stop: "SIGTERM"

  faye:
    cwd: /home/akougkas/projects/notient
    env:
      NOTIENT_AGENT: "faye"
    shell: "uv run .gemini/agents/queue-processor.py faye"
    autostart: true
    stop: "SIGTERM"
```

### 7. GEMINI.md (Project Context)

Create `.gemini/GEMINI.md` by adapting the project's `.claude/CLAUDE.md`:

- Keep all project-specific instructions
- Update tool references (Bash → run_shell_command, Read → read_file, etc.)
- Update model references (haiku → gemini-2.5-pro)
- Keep architecture, patterns, and rules

### 8. orchestrator/GEMINI.md

Adapt `.claude/orchestration/orchestrator/CLAUDE.md`:

```markdown
# Orchestrator - Agent Coordinator (Gemini CLI)

You coordinate Archie (backend), Sage (review), and Faye (frontend) via task queues.

**You dispatch tasks yourself using run_shell_command.**

## Core Workflow

1. User describes what they want
2. **You dispatch** via shell: `uv run .gemini/agents/dispatch.py <agent> "prompt"`
3. Agent queue processor runs task automatically (uses gemini -p)
4. **You check responses**: `uv run .gemini/agents/dispatch.py --responses <agent>`
5. **You clear processed**: `rm .gemini/orchestration/<agent>/responses/<task_id>.response`

## Model

Default: gemini-2.5-pro (Ultra plan)
```

---

## CLI Command Mapping Reference

| Action | Claude Code | Gemini CLI |
|--------|-------------|------------|
| Non-interactive | `claude --print "prompt"` | `gemini -p "prompt"` |
| Specify model | `--model haiku` | `--model gemini-2.5-pro` |
| Skip permissions | `--dangerously-skip-permissions` | `--yolo` or `-y` |
| JSON output | `--output-format json` | `--output-format json` |
| Stream JSON | `--output-format stream-json` | `--output-format stream-json` |
| Resume session | `--resume` or `-r` | `--resume` or `-r` |

## Hook Event Mapping

| Claude Code | Gemini CLI | Notes |
|-------------|------------|-------|
| `SessionStart` | `SessionStart` | ✅ Same |
| `Stop` | `SessionEnd` | Different name |
| `PreToolUse` | `BeforeTool` | Different name |
| `PostToolUse` | `AfterTool` | Different name |
| N/A | `BeforeAgent` | Gemini-only |
| N/A | `AfterAgent` | Gemini-only |
| N/A | `BeforeModel` | Gemini-only |
| N/A | `AfterModel` | Gemini-only |

## Tool Name Mapping

| Claude Code | Gemini CLI |
|-------------|------------|
| `Bash` | `run_shell_command` |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Edit` | `replace` |
| `Glob` | `glob` |
| `Grep` | `search_file_content` |
| `WebFetch` | `web_fetch` |
| `WebSearch` | `google_web_search` |
| `TodoWrite` | `write_todos` |

---

## Verification Steps

After implementation, verify:

1. **Queue processor starts:**
   ```bash
   uv run .gemini/agents/queue-processor.py archie
   # Should show: STATUS:archie:idle - ready
   ```

2. **Dispatch works:**
   ```bash
   uv run .gemini/agents/dispatch.py archie "Echo: TEST"
   uv run .gemini/agents/dispatch.py --check archie
   # Should show: Pending tasks: 1
   ```

3. **Task executes:**
   ```bash
   # Queue processor should pick up task and run gemini -p
   # Response should appear in .gemini/orchestration/archie/responses/
   ```

4. **Watcher works:**
   ```bash
   uv run .gemini/agents/watcher.py --once
   # Should detect response
   ```

5. **mprocs workspace:**
   ```bash
   mprocs -c .gemini/mprocs-gemini.yaml
   # All agents should start and show idle
   ```

---

## Execution Command

```
Read this file and implement the Gemini CLI orchestration system.
Create all files in .gemini/ directory following the specifications above.
Test each component after creation.
```
