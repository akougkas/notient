# Notient Orchestration System

> Two-tier agent workforce for complex software development

## Architecture

```
CEO (User) ─── Makes ALL decisions
     │
Orchestrator (Chief Engineer) ─── Proposes options, designs DAGs, manages lifecycle
     │
     ├── Base Army (persistent, via mprocs):
     │   implementer, simplifier, validator, tester
     │
     ├── Spawn Variants (on-demand):
     │   implementer-gemini, validator-gemini, tester-gemini, simplifier-gemini
     │
     └── Dynamic Specialists (read-only):
         architect, advisor, docs-fetcher, codebase-navigator, world-knowledge
```

## Infrastructure

### Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `git-prepare.sh` | Prepare worktree for task | `.claude/agents/git-prepare.sh <role> <role>/<task>` |
| `dispatch.py` | Task dispatch & lifecycle | `uv run .claude/agents/dispatch.py <command>` |
| `watcher.py` | Monitor task completion | `uv run .claude/agents/watcher.py [options]` |
| `queue-processor.py` | Process queue (daemon) | Runs via mprocs, not called directly |

### Key Directories

```
.claude/orchestration/
├── orchestrator/CLAUDE.md    # Orchestrator identity
├── core/
│   ├── CODER.md              # Shared coder identity
│   └── RESEARCHER.md         # Shared researcher identity
├── <role>/
│   ├── ROLE.md               # Role specialization
│   ├── queue/                # Pending tasks (.task files)
│   └── responses/            # Completed responses (.response files)
├── state/
│   ├── instances.json        # Runtime agent state
│   ├── notifications.jsonl   # Watcher notifications
│   └── SESSION-HANDOFF.md    # Session continuity
└── config.json               # Central configuration
```

### Worktrees

```
~/projects/notient/                          # Orchestrator (beta-spec)
~/projects/_worktrees/notient-implementer/   # Base army
~/projects/_worktrees/notient-simplifier/
~/projects/_worktrees/notient-validator/
~/projects/_worktrees/notient-tester/
/tmp/notient-worktrees/                      # Dynamic spawns (auto-created)
```

---

## Complete Orchestration Flow

### 1. Session Start

```bash
# Check for session handoff
cat .claude/orchestration/state/SESSION-HANDOFF.md

# Review project state
cat .planning/STATE.md
cat .planning/PHASE-GALAXY.md

# Verify mprocs is running (CEO starts this)
uv run .claude/agents/dispatch.py status
```

If agents show 🔴, ask CEO to start mprocs.

### 2. Propose Options (REQUIRED)

Always propose to CEO before dispatching:

```
📋 DISPATCH OPTIONS:

Recommended Pattern: PARALLEL-ISOLATED

Agent 1: implementer → src/core/events.ts
Agent 2: implementer-gemini → src/core/db/

Alternative: PIPELINE
  implementer → validator → tester

Which approach?
```

### 3. Task Preparation

**For each coder agent:**
```bash
.claude/agents/git-prepare.sh <role> <role>/<task-name>
```

**For Gemini variants (auto-creates temp worktree):**
```bash
uv run .claude/agents/dispatch.py spawn implementer --cli gemini
```

### 4. Task Dispatch

**Dispatch ALL tasks:**
```bash
uv run .claude/agents/dispatch.py task implementer "Task description" --cli claude
uv run .claude/agents/dispatch.py task implementer-gemini "Task description" --cli gemini
```

**Start watcher (background):**
```bash
uv run .claude/agents/watcher.py --roles implementer,implementer-gemini --wait-for 2 --notify --timeout 1800 &
```

### 5. Agent Execution (Automatic)

- mprocs runs queue-processor for each agent
- Agent picks up task from queue
- Agent works, commits to branch
- Agent writes `.response` file to `<role>/responses/`
- Watcher detects completion, notifies

### 6. Post-Completion Validation

**Validate in agent's worktree:**
```bash
cd ~/projects/_worktrees/notient-<role>
bun run typecheck && bun run build && bun run lint
```

**If validation passes, report to CEO:**
```
✅ VALIDATION PASSED

Branch: implementer/g1-wave2-eventbus
Validation: typecheck ✓ | build ✓ | lint ✓

Proceed with merge?
```

### 7. Merge (After CEO Approval)

```bash
# In orchestrator repo
git merge <role>/<task> --no-ff -m "Merge <role>: <description>"

# Verify on beta-spec
bun run typecheck && bun run build

# If fails, revert
git reset --hard HEAD~1
```

### 8. Cleanup (Immediately After Merge)

```bash
# Clear responses
rm -f .claude/orchestration/<role>/responses/*.response
rm -f .claude/orchestration/<role>/responses/*.md

# Clear processed queue (if not auto-cleared)
rm -f .claude/orchestration/<role>/queue/*.task

# Report to CEO
```

---

## Dispatch Commands Reference

```bash
# === TASK DISPATCH ===
uv run .claude/agents/dispatch.py task <role> "<prompt>" --cli <cli>

# === SPAWN VARIANTS ===
uv run .claude/agents/dispatch.py spawn <role> --cli gemini

# === LIFECYCLE ===
uv run .claude/agents/dispatch.py kill <instance>
uv run .claude/agents/dispatch.py refresh <instance>

# === STATUS ===
uv run .claude/agents/dispatch.py status
uv run .claude/agents/dispatch.py check <role>
uv run .claude/agents/dispatch.py responses <role>
```

---

## Orchestration Patterns

### Single (Default)
One agent, one task.

### Parallel-Isolated
Multiple agents on **separate** code areas.
```
implementer → src/core/events.ts
implementer-gemini → src/core/db/
```

### Parallel-Competing (Best-of-N)
Multiple agents try **same task**, pick best.
```
implementer (Claude) → approach A
implementer-gemini → approach B
→ Evaluate both, pick winner
```

### Pipeline (Serial)
Output feeds next agent.
```
implementer → validator → simplifier → tester
```

### DAG (Directed Acyclic Graph)
Complex dependency graph.

---

## Rules (NON-NEGOTIABLE)

1. **NEVER auto-dispatch** — propose options to CEO
2. **NEVER auto-merge** — require CEO approval
3. **ALWAYS use git-prepare.sh** — never manually manage worktrees
4. **ALWAYS use watcher.py** — never poll status manually
5. **ALWAYS validate in agent's worktree** — not in orchestrator repo
6. **ALWAYS cleanup responses** — immediately after merge
7. **YOU own all merges** — agents only commit to their branch
8. **Parallel dispatch order**: Prepare ALL → Dispatch ALL → Start watcher

---

## Troubleshooting

### Agents show 🔴 (not running)
CEO needs to start mprocs. Ask: "Please start mprocs to run the agent infrastructure."

### Validation fails in agent branch
Options:
1. Dispatch simplifier to fix
2. Dispatch implementer to fix
3. Discard branch (`git branch -D <branch>`)

### Merge conflicts
1. Resolve in agent's worktree
2. Re-validate
3. Then merge

### Context exhaustion (>80%)
```bash
uv run .claude/agents/dispatch.py refresh <instance>
```

---

## Lessons Learned (Session 10)

### What NOT to Do

1. **Don't manually run git commands on worktrees** — use `git-prepare.sh`
2. **Don't poll agent status manually** — use `watcher.py` in background
3. **Don't forget post-merge cleanup** — clear responses immediately
4. **Don't interleave parallel prep/dispatch** — prepare ALL, dispatch ALL, then watch
5. **Don't validate in orchestrator repo** — validate in agent's worktree
6. **Don't create worktrees manually for Gemini variants** — `spawn` auto-creates them

### What TO Do

1. **Use the scripts** — they handle edge cases you'll forget
2. **Use the watcher** — it's designed for this
3. **Follow the flow** — propose → prepare → dispatch → watch → validate → merge → cleanup
4. **Clear responses after merge** — keep the system clean
5. **Trust mprocs** — agents are daemons, they pick up tasks automatically
