# Notient - AI Assistant Context

> AI-powered vault management for Obsidian using local LLMs only.

**Notient = Note + Sentient** — Local-only. Privacy-first. Human-in-the-steering-wheel.

**4-Agent Swarm**: User (President) → Orchestrator (brain) → [NoteEditor | ContextBuilder | Worker]

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict) |
| Runtime | Bun |
| Build | esbuild |
| Lint | Biome |
| UI | Preact + @preact/signals |
| Reasoning LLM | LM Studio |
| Embedding LLM | Ollama |
| Vector Store | HNSW (WASM) |

---

## Commands

```bash
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:clean        # Wipe plugin data + fresh build
bun run dev:reset        # Soft reset (settings only)
bun run dev:hard-reset   # Hard reset (everything)
bun run build            # Typecheck + production build
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

## Git Infrastructure

### Worktree Layout

| Path | Branch | Owner |
|------|--------|-------|
| `~/projects/notient/` | `beta-spec` | Orchestrator |
| `~/projects/_worktrees/notient-archie/` | `archie/{task}` | Archie (backend) |
| `~/projects/_worktrees/notient-sage/` | `sage/{task}` | Sage (review) |
| `~/projects/_worktrees/notient-faye/` | `faye/{task}` | Faye (frontend) |

### Quick Commands

```bash
# Prepare agent worktree
.claude/agents/git-prepare.sh archie archie/swarm-phase-3

# Dispatch task
uv run .claude/agents/dispatch.py archie "Execute Phase 3 per TASK.md"

# Check responses
uv run .claude/agents/dispatch.py --responses archie

# Merge agent work
git merge archie/swarm-phase-3 --no-ff -m "Merge archie: Phase 3"
```

### Rules

- Never push agent branches (all work is local)
- Orchestrator owns merges (agents only commit)
- Worktrees are disposable (reset via `git-prepare.sh`)
- Main stays clean (only tagged releases)

---

## 4-Agent Swarm Architecture

```
User (President)
       ↓
┌──────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                            │
│  (chiefOfStaff.ts) - Reasoning brain, makes plans, delegates │
└──────────────────────────────────────────────────────────────┘
       ↓                    ↓                    ↓
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐
│ NoteEditor  │    │ ContextBuilder  │    │   Worker    │
│ (I/O)       │    │ (search)        │    │ (workflows) │
│ Uses Skills │    │ Uses Embeddings │    │ Uses Prompts│
└─────────────┘    └─────────────────┘    └─────────────┘
```

**Three Triggers → Orchestrator:**
1. UI (Quick Actions, Agent Streams)
2. ChatService (hybrid mode)
3. Editor Decorations (future)

### Key Patterns

**Kernel Pattern**: All services in `kernel.ts`, DI via `kernel.get<T>(ServiceName)`

**Two-Tier Identity**:
- Tier 1: `src/core/agent/identity.ts` — Core persona (shared by ALL agents)
- Tier 2: `src/core/agents/agentIdentity.ts` — Agent-specific specialization
- ALWAYS use `buildAgentSystemPrompt()` (calls `buildBaseIdentity()` internally)

**Skills Architecture** (NoteEditor only):
- `SkillRegistry` injects schemas (Canvas, Bases, Markdown)
- `ObsidianFacade` handles atomic writes
- NoteEditor "equips" skills dynamically

**Streaming First**: All LLM calls via `AsyncIterable<AgentEvent>`, AbortController for cancellation

---

## Anti-Patterns (DON'Ts)

### Architecture
- ❌ Don't duplicate Tier 1 identity — ALWAYS call `buildBaseIdentity()` or `buildAgentSystemPrompt()`
- ❌ Don't put business logic in views — Delegate to services via Kernel
- ❌ Don't bypass Orchestrator — All agent execution goes through Orchestrator
- ❌ Don't create parallel type systems — Reuse existing types from `types.ts`

### Code Style
- ❌ Don't use abbreviations — `context` not `ctx`, `message` not `msg`
- ❌ Don't add debug logging — No `console.log` in production
- ❌ Don't use `any` without justification — TypeScript strict mode enforced

### LLM Integration
- ❌ Don't assume LLM availability — Handle connection failures gracefully
- ❌ Don't ignore abort signals — All streaming must respect `AbortController`
- ❌ Don't hardcode prompts in agents — Use `agentIdentity.ts` or `prompts/*.ts`

### UI
- ❌ Don't change sidebar structure — Layout locked: Note Vitals | Agent Streams | Chat
- ❌ Don't use inline styles — Use CSS classes with `nv2-*` prefix

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin entry point |
| `src/core/kernel.ts` | Service registry, DI container |
| `src/core/agents/chiefOfStaff.ts` | Orchestrator (brain) |
| `src/core/agents/workerAgent.ts` | Workflow executor |
| `src/core/agents/noteEditorAgent.ts` | Obsidian I/O specialist |
| `src/core/agents/contextBuilderAgent.ts` | Vault awareness |
| `src/core/agents/agentIdentity.ts` | Tier 2 agent prompts |
| `src/core/agent/identity.ts` | Tier 1 core identity |
| `src/core/llm/provider.ts` | LLM interface |
| `src/core/chat/chatService.ts` | Chat orchestration, streaming |
| `src/core/search/pipeline.ts` | Vector + reranking |
| `src/core/skills/registry.ts` | Skill injection for NoteEditor |
| `src/adapters/obsidianFacade.ts` | Obsidian API wrapper |
| `src/ui/sidebar/App.tsx` | Main sidebar UI (Preact) |

---

## Code Map

**CRITICAL**: Work within this structure. Don't create new files without explicit approval.

```
src/
├── main.ts                           # Plugin entry point
├── adapters/
│   └── obsidianFacade.ts             # Obsidian API wrapper
│
├── core/
│   ├── kernel.ts                     # Service registry, DI container
│   ├── constants.ts                  # PLUGIN_ID, VIEW_TYPES
│   │
│   ├── events/
│   │   ├── eventBus.ts               # Typed pub/sub
│   │   └── types.ts                  # Event definitions
│   │
│   ├── llm/
│   │   ├── provider.ts               # LLMProvider interface
│   │   └── providers/
│   │       └── openai-compatible.ts  # Base for OpenAI-style APIs
│   │
│   ├── agent/                        # TIER 1 IDENTITY
│   │   ├── identity.ts               # buildBaseIdentity()
│   │   ├── profileManager.ts         # User profile CRUD
│   │   └── taskQueue.ts              # Background tasks
│   │
│   ├── agents/                       # 4-AGENT SWARM
│   │   ├── types.ts                  # AgentType, AgentContext
│   │   ├── base.ts                   # BaseAgent abstract
│   │   ├── agentIdentity.ts          # TIER 2 - buildAgentSystemPrompt()
│   │   ├── chiefOfStaff.ts           # Orchestrator (brain)
│   │   ├── noteEditorAgent.ts        # Obsidian I/O
│   │   ├── contextBuilderAgent.ts    # Vault awareness
│   │   ├── workerAgent.ts            # Workflow executor
│   │   └── workflowAgents.ts         # Workflow configs
│   │
│   ├── chat/
│   │   ├── chatService.ts            # Chat orchestration
│   │   ├── conversationStore.ts      # Persistence
│   │   ├── thinkingParser.ts         # <think> extraction
│   │   └── types.ts                  # ChatMessage types
│   │
│   ├── indexer/
│   │   ├── simpleIndexer.ts          # Vault sync
│   │   ├── simpleChunker.ts          # Content hashing
│   │   └── tieredSemanticChunker.ts  # 3-tier chunking
│   │
│   ├── intelligence/
│   │   ├── noteIntelligence.ts       # Background generation
│   │   ├── intelligenceDb.ts         # Persistence
│   │   └── prompts/                  # Workflow prompts
│   │       ├── index.ts
│   │       ├── enhance.ts
│   │       ├── atomic.ts
│   │       ├── synthesis.ts
│   │       ├── connection.ts
│   │       └── ...
│   │
│   ├── agentic/
│   │   ├── actionApplier.ts          # Execute actions
│   │   ├── actionHistory.ts          # Undo history
│   │   ├── trustLevelManager.ts      # Risk evaluation
│   │   └── types.ts                  # Action types
│   │
│   ├── search/
│   │   ├── pipeline.ts               # SearchPipeline
│   │   └── strategies/
│   │       ├── quick.ts              # Obsidian native
│   │       ├── balanced.ts           # Vector + reranking
│   │       └── deep.ts               # Agentic exploration
│   │
│   ├── skills/                       # NoteEditor capabilities
│   │   ├── registry.ts               # SkillRegistry
│   │   ├── types.ts                  # Skill interface
│   │   └── definitions/
│   │       ├── jsonCanvas.ts
│   │       ├── obsidianBases.ts
│   │       └── obsidianMarkdown.ts
│   │
│   ├── context/
│   │   └── vaultContextBuilder.ts    # LLM context building
│   │
│   ├── vitals/
│   │   └── simpleVitals.ts           # Note health
│   │
│   ├── db/
│   │   ├── database.ts               # SQLite wrapper
│   │   ├── schema.ts                 # Table definitions
│   │   └── migrations.ts             # Schema migrations
│   │
│   └── evolution/
│       └── userEvolutionService.ts   # Preference learning
│
├── services/
│   ├── storagePaths.ts               # Path management
│   ├── indexManager.ts               # Index I/O
│   ├── vectorStore.ts                # VectorStore interface
│   ├── hnswVectorStore.ts            # HNSW WASM impl
│   ├── ollama.ts                     # Embedding service
│   ├── ollamaReranker.ts             # LLM reranking
│   ├── healthMonitor.ts              # Health checks
│   └── vaultLock.ts                  # Multi-window locking
│
├── types/
│   ├── settings.ts                   # NotientSettings
│   ├── indexer.ts                    # Chunk types
│   ├── search.ts                     # Search types
│   └── profile.ts                    # UserProfile
│
├── ui/
│   ├── sidebar/
│   │   ├── App.tsx                   # Main sidebar
│   │   ├── SidebarView.tsx           # Obsidian view wrapper
│   │   ├── hooks/                    # Preact hooks
│   │   └── components/
│   │       ├── NavDeck.tsx           # Tab navigation
│   │       ├── SystemDashboard.tsx   # Status footer
│   │       ├── NoteVitalsView.tsx    # Health + insights
│   │       ├── AgentStreamsView.tsx  # Agent activity
│   │       └── chat/
│   │           ├── RichChatView.tsx
│   │           ├── MessageBubble.tsx
│   │           └── ThinkingBlock.tsx
│   │
│   ├── settings/
│   │   └── SettingsTab.ts            # Settings panel
│   │
│   ├── modals/
│   │   ├── SetupWizard.ts
│   │   ├── IndexDashboardModal.ts
│   │   └── ProfileEditModal.ts
│   │
│   └── dashboard/
│       └── DashboardView.ts
│
├── workers/
│   ├── embed.worker.ts               # Embedding worker
│   └── vector.worker.ts              # HNSW worker
│
├── utils/
│   └── atomicWrite.ts                # Crash-safe writes
│
└── styles.css                        # Design tokens
```

---

## .claude Infrastructure

```
.claude/
├── CLAUDE.md                    # This file (project context)
├── agents/
│   ├── dispatch.py              # Task dispatcher
│   ├── queue-processor.py       # Agent runner
│   ├── watcher.py               # Response watcher
│   ├── git-prepare.sh           # Worktree setup
│   └── git-prepare-all.sh       # Prepare all agents
├── orchestration/
│   ├── archie/                  # Backend agent
│   │   ├── CLAUDE.md            # Agent identity
│   │   ├── TASK.md              # Current task
│   │   ├── queue/               # Pending tasks
│   │   └── responses/           # Completed tasks
│   ├── sage/                    # Review agent
│   ├── faye/                    # Frontend agent
│   └── orchestrator/
│       └── CLAUDE.md            # Orchestrator identity
└── hooks/                       # Session hooks
```

---

## Version

- **Current:** 0.3.1
- **Min Obsidian:** 1.4.0
