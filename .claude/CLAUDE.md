# Notient - AI Assistant Context

> AI-powered vault management for Obsidian using local LLMs only.

## Core Mission

**Notient = Note + Sentient** — Transform Obsidian notes from passive files into living entities with health, context, and agency. Local-only. Privacy-first. Human-in-the-steering-wheel.

**Mental Model: 4-Agent Swarm** (Updated 2026-01-14)
- User = President (decision maker, commands agents)
- Orchestrator = Brain (reasoning model, makes plans, delegates)
- NoteEditor = Obsidian I/O specialist (edit, create, verify)
- ContextBuilder = Vault awareness specialist (search, relationships)
- Worker = Workflow executor (classify, enhance, atomize, etc.)

See `.planning/SWARM-ARCHITECTURE.md` for full specification.

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
main                              ← Tagged releases only (production-ready)
  └── beta-spec                   ← Active development (Orchestrator workspace)
        ├── archie/swarm-phase-N  ← Backend phase work
        ├── sage/swarm-phase-N    ← Review/simplify phase work
        └── faye/swarm-phase-N    ← Frontend phase work
```

### Worktree Layout

| Path | Branch Pattern | Owner |
|------|----------------|-------|
| `~/projects/notient/` | `beta-spec` | Orchestrator (main workspace) |
| `~/projects/_worktrees/notient-archie/` | `archie/{task}` | Archie |
| `~/projects/_worktrees/notient-sage/` | `sage/{task}` | Sage |
| `~/projects/_worktrees/notient-faye/` | `faye/{task}` | Faye |

### Phase-Based Workflow

**Branch Naming:** `{agent}/swarm-phase-{N}` or `{agent}/{task-description}`

**Lifecycle:**
1. **Orchestrator** prepares worktree via `git-prepare.sh`
2. **Agent** works on assigned branch, commits incrementally
3. **Agent** completes, writes REPORT.md with commit hash
4. **Orchestrator** merges to `beta-spec` via `git merge --no-ff`
5. **Old branch** kept as safety net until validation passes

### Quick Commands

```bash
# Prepare agent worktree for new task
.claude/agents/git-prepare.sh archie archie/swarm-phase-3

# Prepare all agents
.claude/agents/git-prepare-all.sh

# Dispatch task to agent
uv run .claude/agents/dispatch.py archie "Execute Phase 3 per TASK.md"

# Merge agent work to beta-spec
git merge archie/swarm-phase-3 --no-ff -m "Merge archie: Phase 3 NoteEditor"

# Check agent responses
uv run .claude/agents/dispatch.py --responses archie
```

### Rules

- **Never push agent branches** — All work is local
- **Orchestrator owns merges** — Agents only commit, never merge
- **Worktrees are disposable** — Reset freely via `git-prepare.sh`
- **Main stays clean** — Only tagged releases
- **Phase branches persist** — Delete only after validation

---

## Component Architecture

### Core Layers

```
src/core/
├── kernel.ts              # Service registry, dependency injection
├── events/                # Typed EventBus for decoupling
├── llm/                   # LLM abstraction layer
│   ├── provider.ts        # LLMProvider interface
│   └── providers/         # LMStudio, Ollama implementations
├── agents/                # 4-Agent Swarm Architecture
│   ├── chiefOfStaff.ts    # Orchestrator (brain) - Phase 1 complete
│   ├── base.ts            # BaseAgent abstract class
│   ├── agentIdentity.ts   # Tier 2 specializations
│   ├── noteEditorAgent.ts # Obsidian I/O specialist - Phase 3 in progress
│   ├── contextBuilderAgent.ts # Vault awareness - Phase 4 in progress
│   ├── workerAgent.ts     # Unified workflow executor - Phase 2 complete
│   ├── classifierAgent.ts # → DELETE after D4 (absorbed by Worker)
│   ├── connectionAgent.ts # → DELETE after D4 (absorbed by Worker)
│   └── workflowAgents.ts  # → DELETE after D4 (absorbed by Worker)
├── agent/                 # Tier 1 identity
│   └── identity.ts        # Core Notient persona
├── intelligence/          # Workflow prompts (used by Worker)
│   └── prompts/           # Individual prompt builders
├── skills/                # Dynamic capabilities (used by NoteEditor)
│   └── registry.ts        # SkillRegistry for Canvas, Bases, Markdown
├── agentic/               # Trust levels, action applier
├── search/                # Vector search + LLM reranking
└── context/               # Vault context builder
```

### Key Patterns

**Kernel Pattern**
- All services registered in `kernel.ts`
- Dependency injection via `kernel.get<T>(ServiceName)`
- Startup orchestration with health checks

**4-Agent Swarm Architecture** (2026-01-14)
- **Orchestrator:** Reasoning brain. Receives all requests, makes plans, delegates.
- **NoteEditor:** Obsidian I/O specialist. Uses Skills (Canvas, Bases, Markdown).
- **ContextBuilder:** Vault awareness. Uses Search Pipeline, Embeddings.
- **Worker:** Unified workflow executor. Uses Prompts + Context + Search.

**Three Triggers → Orchestrator:**
1. UI (Quick Actions, Agent Streams)
2. ChatService (hybrid mode)
3. Editor Decorations (D8, future)

**Skills Architecture (NoteEditor only)**
- **Brain:** `SkillRegistry` injects specialized schemas (Canvas, Bases) into NoteEditor.
- **Hands:** `ObsidianFacade` handles atomic writes for all file types.
- **Dynamic:** NoteEditor "equips" skills only when needed, keeping context light.

**Two-Tier Identity**
- Tier 1: `src/core/agent/identity.ts` — Core persona, shared by ALL agents
- Tier 2: `src/core/agents/agentIdentity.ts` — Agent-specific mission/expertise
- ALWAYS compose: `buildAgentSystemPrompt()` calls `buildBaseIdentity()` internally

**Event-Driven UI**
- Views subscribe to EventBus
- Services emit events
- No direct view-to-view communication

**Streaming First**
- All LLM calls support streaming via `AsyncIterable<AgentEvent>`
- AbortController for cancellation
- Never block UI

---

## Extending the System

### Adding a New Workflow (Preferred)

With the 4-Agent Swarm, most new capabilities should be **workflows** in the Worker agent:

1. **Create prompt builder** in `src/core/intelligence/prompts/`:
   ```typescript
   // newworkflow.ts
   export const NEWWORKFLOW_PROMPT: AgentPrompt = {
     system: "You are a specialized workflow agent...",
     userTemplate: "Process this note: {{noteTitle}}\n\n{{noteContent}}"
   };
   
   export function buildNewWorkflowPrompt(profile?: UserProfile): string {
     const base = buildBaseIdentity(profile);
     return `${base}\n\n${NEWWORKFLOW_PROMPT.system}`;
   }
   ```

2. **Register in Worker** — Worker agent loads prompts dynamically.

### Adding a New Core Agent (Rare)

Only add a new agent if the capability requires:
- Self-verification/correction loop
- Complex multi-step reasoning
- Distinct LLM model requirements

The 4-agent swarm should cover most needs:
- **Orchestrator** — Reasoning, planning
- **NoteEditor** — Obsidian I/O (with Skills)
- **ContextBuilder** — Vault awareness
- **Worker** — Workflow execution (with Prompts)

If truly needed, follow the same pattern as existing agents.

### Adding a New Workflow Command

1. **Create prompt builder** in `src/core/intelligence/prompts/`:
   ```typescript
   // newworkflow.ts
   export const NEWWORKFLOW_PROMPT = `...`;
   
   export function buildNewWorkflowPrompt(profile?: UserProfile): string {
     const base = buildBaseIdentity(profile);
     return `${base}\n\n${NEWWORKFLOW_PROMPT}`;
   }
   ```

2. **Export** from `src/core/intelligence/prompts/index.ts`

3. **Add to workflow configs** in `src/core/agents/workflowAgents.ts`:
   ```typescript
   export const WORKFLOW_CONFIGS: Record<WorkflowAgentType, WorkflowConfig> = {
     // ...existing...
     "newworkflow": {
       type: "newworkflow",
       command: "/newcommand",
       promptBuilder: buildNewWorkflowPrompt,
       temperature: 0.3,
       outputType: "structured"
     }
   };
   ```

4. ChiefOfStaff routes `/newcommand` automatically via `isWorkflowCommand()`

### Adding a New LLM Provider

1. **Extend base** in `src/core/llm/providers/`:
   ```typescript
   export class NewProvider extends OpenAICompatibleProvider {
     constructor() {
       super({
         baseUrl: "http://localhost:PORT",
         defaultModel: "model-name"
       });
     }
   }
   ```

2. **Register** in Kernel startup if needed

---

## Anti-Patterns (DON'Ts)

### Architecture

❌ **Don't duplicate Tier 1 identity**
- NEVER copy persona prompts into agent files
- ALWAYS call `buildBaseIdentity()` or `buildAgentSystemPrompt()`

❌ **Don't put business logic in views**
- Views are UI only
- Delegate to services via Kernel

❌ **Don't bypass Orchestrator**
- All agent execution goes through Orchestrator
- Don't instantiate agents directly in UI code
- ChatService can trigger Orchestrator for agent tasks (hybrid mode)

❌ **Don't create parallel type systems**
- Reuse existing types from `types.ts`
- Extend, don't duplicate

### Code Style

❌ **Don't use abbreviations**
- `context` not `ctx`
- `configuration` not `cfg`
- `message` not `msg`

❌ **Don't add debug logging**
- No `console.log` in production code
- Use proper error boundaries

❌ **Don't use `any` without justification**
- TypeScript strict mode is enforced
- Comment why if `any` is necessary (e.g., LLM JSON parsing)

### LLM Integration

❌ **Don't assume LLM availability**
- Always handle connection failures gracefully
- Provide fallbacks where possible

❌ **Don't ignore abort signals**
- All streaming must respect `AbortController`
- Clean up resources on cancellation

❌ **Don't hardcode prompts in agents**
- Prompts belong in `agentIdentity.ts` (core) or `prompts/*.ts` (workflows)
- Agents build prompts from these sources

### UI

❌ **Don't change sidebar structure**
- Layout is locked: Note Vitals | Agent Streams | Chat
- Content is dynamic, structure is static

❌ **Don't use inline styles**
- Use CSS classes with `nv2-*` prefix
- Design system tokens in `styles.css`

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin entry point |
| `src/core/kernel.ts` | Service registry |
| `src/core/agents/chiefOfStaff.ts` | Orchestrator (brain) — Phase 1 complete |
| `src/core/agents/workerAgent.ts` | Worker (workflow executor) — Phase 2 complete |
| `src/core/agents/agentIdentity.ts` | Tier 2 agent prompts |
| `src/core/agent/identity.ts` | Tier 1 core identity |
| `src/core/llm/provider.ts` | LLM interface |
| `src/core/chat/chatService.ts` | Chat orchestrator (streaming, thinking, stats) |
| `src/core/chat/thinkingParser.ts` | Parse `<think>` tags from reasoning models |
| `src/core/agentic/trustLevelManager.ts` | Action risk evaluation |
| `src/core/search/pipeline.ts` | Vector + reranking |
| `src/ui/sidebar/App.tsx` | Main sidebar UI (Preact) |
| `src/ui/sidebar/components/chat/` | Rich chat components |
| `src/ui/sidebar/components/AgentStreamsView.tsx` | Agent activity dashboard |
| `planning/PRD.md` | Product requirements |
| `planning/ROADMAP.md` | Deferred features |

---

## UI Architecture

### Sidebar Views (Three-Tab Layout)

```
┌─────────────────────────────────────────┐
│ NavDeck (Note | Agents | Chat tabs)     │
├─────────────────────────────────────────┤
│                                         │
│  View Content (based on active tab)     │
│                                         │
├─────────────────────────────────────────┤
│ SystemDashboard (status footer)         │
└─────────────────────────────────────────┘
```

**Note Vitals View:**
- NoteCard (health, links, freshness metrics)
- VitalsCards (detailed breakdown)
- QuickActions (agentic triggers)
- InsightStream (AI insights + agent results)

**Agent Streams View:**
- CapabilityCards (Search, Context, Chat status)
- ActiveAgents (running/completed with progress)
- PendingReview (actions awaiting approval)
- RecentActivity (completed actions with undo)

**Chat View:**
- RichChatView (markdown, thinking blocks, streaming)
- Direct ChatService integration (not via taskQueue)

### Quick Actions Pipeline

```
Vitals Quick Actions → triggerAgenticAction() → TaskQueue
                                                    ↓
                                              ChiefOfStaff
                                                    ↓
                                              Agent executes
                                                    ↓
                              ┌─────────────────────┴──────────────────────┐
                              ↓                                            ↓
                    Agent Streams View                           InsightStream (Vitals)
                    (card with progress,                         (1-liner insight from
                     View Results button)                         agent result)
```

### Chat Pipeline (Separate)

```
Chat Input → ChatService.chat() → LLM Stream → RichChatView
                                      ↓
                              ThinkingParser
                              (separates <think> from content)
                                      ↓
                              MessageBubble + ThinkingBlock
```

**Key distinction:**
- Quick Actions → Background agents → Results in Agent Streams + Insights
- Chat → Direct conversation → Results in Chat UI

---

## Deferred Features

Track in `ROADMAP.md` with structure:
- Title, Description
- Why Deferred, Blockers
- Priority (High/Medium/Low)
- Effort Estimate

---

## Version

- **Current:** 0.3.1 (Chat + Agent Streams UI)
- **Min Obsidian:** 1.4.0

---

## Code Map (Complete Source Tree)

**CRITICAL**: All implementation tasks MUST work within this existing structure. Do NOT create new files or folders unless absolutely necessary. If you believe a new file is required, you MUST:
1. Explain why existing files cannot accommodate the change
2. Get explicit user approval before creating

```
src/
├── main.ts                           # Plugin entry point, lifecycle hooks
├── adapters/
│   └── obsidianFacade.ts             # Obsidian API wrapper (file ops, metadata)
│
├── core/
│   ├── kernel.ts                     # Service registry, DI container
│   ├── constants.ts                  # PLUGIN_ID, VIEW_TYPES, STORAGE_PATHS
│   │
│   ├── events/
│   │   ├── eventBus.ts               # Typed pub/sub system
│   │   └── types.ts                  # Event type definitions
│   │
│   ├── llm/
│   │   ├── provider.ts               # LLMProvider interface
│   │   └── providers/
│   │       ├── openai-compatible.ts  # Base for OpenAI-style APIs
│   │       └── ...
│   │
│   ├── agent/                        # TIER 1 IDENTITY (legacy location)
│   │   ├── identity.ts               # Core Notient persona (buildBaseIdentity)
│   │   ├── profileManager.ts         # User profile CRUD
│   │   └── taskQueue.ts              # Background task execution
│   │
│   ├── agents/                       # MULTI-AGENT SYSTEM
│   │   ├── types.ts                  # AgentType, AgentContext, AgentOutput
│   │   ├── base.ts                   # BaseAgent abstract class
│   │   ├── agentIdentity.ts          # TIER 2 specializations (buildAgentSystemPrompt)
│   │   ├── chiefOfStaff.ts           # Central orchestrator, routing
│   │   ├── workflowAgents.ts         # Workflow command configs
│   │   ├── chatAgent.ts              # Conversational agent
│   │   ├── noteEditorAgent.ts        # Note modification agent
│   │   └── ...Agent.ts               # Other specialized agents
│   │
│   ├── chat/
│   │   ├── chatService.ts            # Chat orchestration, streaming
│   │   ├── conversationStore.ts      # Persistence (note-keyed)
│   │   ├── thinkingParser.ts         # <think> tag extraction
│   │   ├── session.ts                # Session management
│   │   └── types.ts                  # ChatMessage, ExtendedChatMessage
│   │
│   ├── indexer/
│   │   ├── simpleIndexer.ts          # Vault sync orchestration
│   │   ├── simpleChunker.ts          # Content hashing, note ID generation
│   │   └── tieredSemanticChunker.ts  # TSI v2: 3-tier hierarchical chunking
│   │
│   ├── intelligence/
│   │   ├── noteIntelligence.ts       # Background intelligence generation
│   │   ├── intelligenceDb.ts         # Persistence (model-keyed, TO BE: tag-keyed)
│   │   ├── types.ts                  # IntelligenceRecord, Health, Entities
│   │   └── prompts/                  # Workflow prompt builders
│   │       ├── index.ts
│   │       └── *.ts
│   │
│   ├── agentic/
│   │   ├── actionApplier.ts          # Execute approved actions
│   │   ├── actionHistory.ts          # Undo history persistence
│   │   ├── trustLevelManager.ts      # Risk evaluation
│   │   ├── workflowRunner.ts         # Workflow execution
│   │   └── types.ts                  # AppliedActionRecord, UndoPayload
│   │
│   ├── search/
│   │   ├── pipeline.ts               # SearchPipeline, preset strategies
│   │   └── strategies/
│   │       ├── quick.ts              # Obsidian native search
│   │       ├── balanced.ts           # Vector + reranking
│   │       └── deep.ts               # Agentic exploration
│   │
│   ├── context/
│   │   └── vaultContextBuilder.ts    # Build context for LLM prompts
│   │
│   ├── vitals/
│   │   └── simpleVitals.ts           # Note health computation
│   │
│   ├── importer/
│   │   ├── importerService.ts        # External data import
│   │   └── migrationService.ts       # Data migration utilities
│   │
│   └── evolution/
│       └── userEvolutionService.ts   # User preference learning
│
├── services/
│   ├── storagePaths.ts               # Single source of truth for all paths
│   ├── indexManager.ts               # Index file I/O, discovery, migration
│   ├── vectorStore.ts                # VectorStore interface
│   ├── simpleVectorStore.ts          # In-memory brute-force implementation
│   ├── vaultLock.ts                  # Multi-window write locking
│   ├── ollama.ts                     # Ollama embedding service
│   ├── ollamaReranker.ts             # LLM-based reranking
│   ├── lmstudio.ts                   # LM Studio reasoning service
│   └── healthMonitor.ts              # Service health checks
│
├── types/
│   ├── settings.ts                   # NotientSettings interface
│   ├── indexer.ts                    # NoteChunk, EmbeddedChunk, IndexProgress
│   ├── search.ts                     # SearchOptions, SearchResult, ChunkSearchResult
│   └── profile.ts                    # UserProfile, DomainInferenceResult
│
├── ui/
│   ├── sidebar/
│   │   ├── App.tsx                   # Main sidebar component (Preact)
│   │   ├── hooks/                    # Custom Preact hooks
│   │   └── components/
│   │       ├── NavDeck.tsx           # Tab navigation
│   │       ├── SystemDashboard.tsx   # Status footer
│   │       ├── NoteVitalsView.tsx    # Note health + insights
│   │       ├── AgentStreamsView.tsx  # Agent activity
│   │       ├── chat/                 # Chat UI components
│   │       │   ├── RichChatView.tsx
│   │       │   ├── MessageBubble.tsx
│   │       │   └── ThinkingBlock.tsx
│   │       └── ...
│   │
│   ├── settings/
│   │   ├── SettingsTab.ts            # Settings panel
│   │   └── panels/                   # Individual setting panels
│   │
│   ├── modals/
│   │   ├── SetupWizard.ts            # First-run wizard
│   │   ├── IndexDashboardModal.ts    # Index management
│   │   ├── ProfileEditModal.ts       # Profile editor
│   │   └── TaskModal.ts              # Task progress
│   │
│   └── dashboard/
│       └── DashboardView.ts          # Full-page dashboard
│
├── utils/
│   └── atomicWrite.ts                # Crash-safe file writes
│
└── styles.css                        # Design tokens, component styles
```

---

## Data Storage Architecture

### Current Structure (TO BE MIGRATED)

```
.obsidian/plugins/notient/
├── main.js, manifest.json, styles.css  # Core (Obsidian-required)
├── data.json                           # Settings
├── conversations.json                  # All chats (single file)
├── intelligence-{model}.json           # AI insights (model-keyed)
├── idx_*.json                          # Vector index (316MB+)
├── profile.json                        # User profile
├── cache/, locks/, logs/               # Operational
```

### Target Structure (PLANNED)

```
.obsidian/plugins/notient/
├── main.js, manifest.json, styles.css  # Core (Obsidian-required)
├── data.json                           # Settings ONLY
│
└── data/                               # All plugin data
    │
    ├── chunks/                         # MODEL-AGNOSTIC chunk content
    │   ├── meta.json                   # Chunker version, config
    │   └── notes/
    │       └── {noteId}.json           # Chunks per note (no vectors)
    │
    ├── embeddings/                     # MODEL-SCOPED vectors
    │   ├── active/
    │   │   └── {modelKey}-{dim}d.json  # Current model index
    │   ├── _rebuilding/                # During model transition
    │   └── _archived/                  # Previous model indices
    │
    ├── intelligence/                   # TAG-KEYED learning (keep forever)
    │   ├── meta.json                   # Schema version
    │   └── topics/
    │       ├── {tag}.json              # e.g., research.json, project.json
    │       └── _uncategorized.json     # Notes without matching tags
    │
    ├── conversations/                  # PER-NOTE + ON-DEMAND ROLLUPS
    │   ├── notes/
    │   │   └── {noteId}.json           # Per-note conversation
    │   ├── rollups/                    # Generated on-demand
    │   │   └── {para-folder}.json      # Folder-level summaries
    │   └── _root.json                  # Notes outside PARA
    │
    ├── actions/                        # TIME-BUCKETED (keep forever)
    │   ├── hot/
    │   │   └── current.json            # Recent 200 actions
    │   └── archive/
    │       └── {YYYY-MM}.json          # Monthly archives
    │
    ├── profile/
    │   └── profile.json                # User identity
    │
    └── _operational/                   # VOLATILE (safe to delete)
        ├── locks/
        ├── cache/
        ├── temp/
        │   ├── _incomplete/            # Interrupted operations
        │   ├── _invalid/               # Validation failures
        │   └── _deleted/               # User-deleted, audit trail
        └── logs/
```

---

## Tiered Semantic Index (TSI v2)

### Three-Tier Hierarchy

```
Note (Tier 0) → exactly 1 per note
  └── Sections (Tier 1) → per H1-H3 heading
       └── Blocks (Tier 2) → paragraphs, lists, tables, code, etc.
```

### Tier Details

| Tier | Name | Count | Size | Content |
|------|------|-------|------|---------|
| 0 | Note | 1 | ~3.6KB | Title, path, outline, sketch (NOT full text) |
| 1 | Section | per H1-H3 | ~2.4KB | Heading path + section content |
| 2 | Block | per semantic unit | ~1.2KB | Heading path + individual block |

### Key Design Decisions

1. **Heading paths embedded in text**: `## Overview > Implementation > Architecture`
2. **Parent linking**: `parentChunkId` chains blocks → sections → notes
3. **Stable chunk IDs**: SHA256 of `noteId:tier:anchor` (deterministic)
4. **Frontmatter merged**: Tags, aliases in note chunk text (not separate)
5. **No folder/vault aggregates**: Brute-force search is fast enough (<50ms)

### Chunk Structure

```typescript
interface NoteChunk {
  id: string;               // Stable: {noteId}-{tier}-{hash}
  noteId: string;           // Parent note
  path: string;             // Vault path
  tier: "note" | "section" | "block";
  kind: ChunkKind;          // paragraph, list, code, table, etc.
  parentChunkId: string | null;
  headingPath: string[];    // ["Part 1", "Section A"]
  text: string;             // Embedding input (includes header)
  blockRef: string | null;  // Obsidian ^blockId
  startLine: number | null;
  endLine: number | null;
  tags: string[];           // From frontmatter
  frontmatter: Record<string, unknown>;
}
```

---

## Implementation Rules

### Working With Existing Code

1. **Extend, don't replace**: Add methods to existing classes before creating new files
2. **Use existing types**: Check `types/*.ts` before defining new interfaces
3. **Follow patterns**: New services register in `kernel.ts`, use `EventBus`
4. **Preserve hierarchy**: TSI v2 chunk structure is foundational—don't flatten

### Storage Modifications

1. **Always use `storagePaths.ts`**: Never hardcode paths
2. **Atomic writes**: Use `atomicWriteFile()` for all persistence
3. **Migration support**: Add version fields, handle schema upgrades
4. **Keep forever**: Move to `_archived/` or `_deleted/`, never truly delete

### Data Flow Patterns

```
User Action → Service → EventBus → UI Update
                 ↓
            Persistence (debounced)
```

### Embedding Model Coupling

- **Chunks**: Model-agnostic (content + structure only)
- **Embeddings**: Model-scoped (dimension must match)
- **On model switch**: Re-embed all chunks, archive old index
