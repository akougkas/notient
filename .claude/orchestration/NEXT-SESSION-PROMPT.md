# Queue-Based Multi-Agent Architecture

## Status: Complete ✓

Full queue-based agent system with async watcher for zero-token waiting.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR (Interactive)                   │
│  1. User describes task                                         │
│  2. Orchestrator dispatches: uv run dispatch.py archie "task"   │
│  3. Orchestrator starts watcher (background Bash)               │
│  4. Watcher polls, outputs when responses arrive                │
│  5. Orchestrator reads responses, reports to user               │
└─────────────────────────────────────────────────────────────────┘
         │                              ▲
         │ dispatch                     │ notify
         ▼                              │
┌─────────────────────────────────────────────────────────────────┐
│              QUEUE PROCESSOR (uv run, per agent)                 │
│  Polls queue/ → runs claude --print → writes responses/         │
└─────────────────────────────────────────────────────────────────┘
         │                              ▲
         │ writes                       │ polls
         ▼                              │
┌─────────────────────────────────────────────────────────────────┐
│              WATCHER (uv run, background)                        │
│  Polls responses/ → outputs 📬 when tasks complete              │
│  ZERO TOKENS while sleeping                                     │
└─────────────────────────────────────────────────────────────────┘
```

## UV Single-File Agents

| File | Purpose |
|------|---------|
| `.claude/agents/queue-processor.py` | Executes tasks via `claude --print` |
| `.claude/agents/dispatch.py` | Enqueues tasks to agent queues |
| `.claude/agents/watcher.py` | Polls responses, notifies when ready |

All stdlib-only, zero external dependencies.

## Usage

### Start mprocs

```bash
mprocs -c .claude/mprocs.yaml
```

Agents auto-start as queue processors.

### Orchestrator Workflow

Talk to orchestrator. It handles everything:

```
User: "Implement user authentication"

Orchestrator (via Bash):
1. uv run dispatch.py archie "Implement auth service"
2. uv run dispatch.py faye "Create login UI"
3. uv run watcher.py --wait-for 2  (background)
4. [waits, zero tokens]
5. Watcher outputs: 📬 ✓ ARCHIE completed...
6. uv run dispatch.py --responses archie
7. Reports to user
```

### Watcher Options

```bash
uv run watcher.py                      # All agents, 5 min timeout
uv run watcher.py --agents archie      # Specific agent
uv run watcher.py --wait-for 2         # Exit after 2 responses
uv run watcher.py --once               # Single check
uv run watcher.py --timeout 600        # 10 min timeout
uv run watcher.py --verbose            # Show polling
```

## Hook Integration

- **SessionStart**: Injects pending responses as context
- **Stop**: Reminds `📬 N response(s): agent(count)`

## Benefits

- **Zero token burn**: Watcher sleeps in Python, not Claude
- **Deterministic**: One task at a time per agent
- **Observable**: JSON files, verbose logging
- **Recoverable**: Queue persists across restarts
- **Async-ready**: Background watcher pattern

## Files

```
.claude/agents/
├── queue-processor.py   # Task executor
├── dispatch.py          # Task dispatcher
└── watcher.py           # Response watcher

.claude/orchestration/
├── {archie,sage,faye}/
│   ├── queue/           # .task files
│   └── responses/       # .response files
└── orchestrator/CLAUDE.md

.claude/hooks/
├── orchestrator-session-start.sh
├── orchestrator-stop.sh
└── orchestrator-check-responses.sh
```
