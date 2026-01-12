# Notient - AI Assistant Context (Gemini CLI)

> AI-powered vault management for Obsidian using local LLMs only.

## Core Mission

**Notient = Note + Sentient** — Transform Obsidian notes from passive files into living entities with health, context, and agency. Local-only. Privacy-first. Human-in-the-steering-wheel.

**Mental Model: White House**
- User = President (decision maker, commands agents)
- ChiefOfStaff = Orchestrator (routes tasks, manages delegation)
- Agents = Department Heads (specialized expertise)

---

## Tech Stack

| Layer | Technology | Decision Rationale |
|-------|------------|-------------------|
| Language | TypeScript (strict) | Type safety, IDE support, Obsidian ecosystem |
| Runtime | Bun | Fast, modern, excellent DX |
| Build | esbuild | Speed, simplicity |
| Lint | Biome | Fast, opinionated, replaces ESLint+Prettier |
| UI | Preact + @preact/signals | Lightweight React-like, reactive state |
| Reasoning LLM | LM Studio | OpenAI-compatible, local, user controls model |
| Embedding LLM | Ollama | Local embeddings, flexible model choice |
| Vector Store | Custom brute-force | Zero deps, predictable, good enough for vault sizes |

**Why not X?**
- No cloud APIs (OpenAI, Claude) — Privacy is non-negotiable
- No SQLite/IndexedDB for vectors — Overkill for <10K notes, adds complexity
- No React — Preact is smaller, signals are cleaner than hooks

---

## Commands

```bash
# Development
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:clean        # Wipe plugin data + fresh build
bun run dev:reset        # Soft reset (settings only)
bun run dev:hard-reset   # Hard reset (everything)

# Production  
bun run build            # Typecheck + production build
bun run build:dev        # Dev build with sourcemaps
bun run analyze          # Bundle size analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

## Git Infrastructure

### Branch Hierarchy

```
main                         ← Tagged releases only (production-ready)
  └── beta-spec              ← Active development (CEO workspace)
        └── sage/simplify    ← Quality gate (review + simplify before promoting)
              ├── archie/backend  ← Heavy backend work
              └── faye/frontend   ← Heavy frontend work
```

### Worktree Layout

| Path | Branch | Owner |
|------|--------|-------|
| `~/projects/notient/` | `beta-spec` | CEO (main workspace) |
| `~/projects/_worktrees/notient-sage/` | `sage/simplify` | Sage |
| `~/projects/_worktrees/notient-archie/` | `archie/backend` | Archie |
| `~/projects/_worktrees/notient-faye/` | `faye/frontend` | Faye |

### Workflow

1. **Archie/Faye** do heavy work in their worktrees
2. **Sage** merges their work, reviews, simplifies
3. **CEO** merges `sage/simplify` → `beta-spec` when clean
4. **Milestone complete?** `beta-spec` → `main` + tag

### Quick Commands

```bash
# Launch agent in worktree
cd ~/projects/_worktrees/notient-archie && gemini

# Merge agent work through Sage
cd ~/projects/_worktrees/notient-sage
git merge archie/backend  # or faye/frontend

# Promote to beta-spec
cd ~/projects/notient
git merge sage/simplify

# Reset rogue agent
cd ~/projects/_worktrees/notient-archie
git reset --hard sage/simplify
```

### Rules

- **Never push agent branches** — All work is local
- **Sage is the gatekeeper** — Only reviewed code reaches beta-spec
- **Worktrees are disposable** — Reset freely if agent goes rogue
- **Main stays clean** — Only tagged releases

---

## Component Architecture

### Core Layers

```
src/core/
├── kernel.ts              # Service registry, dependency injection
├── events/                # Typed EventBus for decoupling
├── llm/                   # LLM abstraction layer
├── agents/                # Multi-agent system (White House Model)
│   ├── chiefOfStaff.ts    # Central orchestrator
│   ├── base.ts            # BaseAgent abstract class
│   ├── agentIdentity.ts   # Tier 2 specializations
│   ├── *Agent.ts          # Individual agent implementations
│   └── workflowAgents.ts  # Intelligence 2.0 wrappers
├── agent/                 # Legacy (Tier 1 identity here)
│   └── identity.ts        # Core Notient persona
├── intelligence/          # Workflow prompts
├── agentic/               # Trust levels, action applier
├── search/                # Vector search + LLM reranking
└── context/               # Vault context builder
```

---

## CLI Command Mapping Reference

| Action | Claude Code | Gemini CLI |
|--------|-------------|------------|
| Non-interactive | `claude --print "prompt"` | `gemini -p "prompt"` |
| Specify model | `--model haiku` | `--model gemini-2.5-pro` |
| Skip permissions | `--dangerously-skip-permissions` | `--yolo` or `-y` |
| JSON output | `--output-format json` | `--output-format json` |
| Resume session | `--resume` or `-r` | `--resume` or `-r` |

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

---

## Anti-Patterns (DON'Ts)

❌ **Don't use abbreviations**
- `context` not `ctx`
- `configuration` not `cfg`
- `message` not `msg`

❌ **Don't add debug logging**
- No `console.log` in production code
- Use proper error boundaries
