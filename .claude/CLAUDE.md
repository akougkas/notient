# Notient - AI Assistant Context

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
cd ~/projects/_worktrees/notient-archie && claude

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
│   ├── provider.ts        # LLMProvider interface
│   └── providers/         # LMStudio, Ollama implementations
├── agents/                # Multi-agent system (White House Model)
│   ├── chiefOfStaff.ts    # Central orchestrator
│   ├── base.ts            # BaseAgent abstract class
│   ├── agentIdentity.ts   # Tier 2 specializations
│   ├── *Agent.ts          # Individual agent implementations
│   └── workflowAgents.ts  # Intelligence 2.0 wrappers
├── agent/                 # Legacy (Tier 1 identity here)
│   └── identity.ts        # Core Notient persona
├── intelligence/          # Workflow prompts
│   └── prompts/           # Individual prompt builders
├── agentic/               # Trust levels, action applier
├── search/                # Vector search + LLM reranking
└── context/               # Vault context builder
```

### Key Patterns

**Kernel Pattern**
- All services registered in `kernel.ts`
- Dependency injection via `kernel.get<T>(ServiceName)`
- Startup orchestration with health checks

**Skills Architecture (Brain & Hands)**
- **Brain:** `SkillRegistry` injects specialized schemas (Canvas, Bases) into agents.
- **Hands:** `ObsidianFacade` handles atomic writes for all file types.
- **Dynamic:** Agents "equip" skills only when needed, keeping context light.

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

### Adding a New Core Agent

1. **Create agent file** in `src/core/agents/`:
   ```typescript
   // newAgent.ts
   export class NewAgent extends BaseAgent {
     constructor(llm: LLMProvider, profile?: UserProfile) {
       super(llm, "new-agent");  // Must match AgentType
       this.profile = profile;
     }
     
     protected buildSystemPrompt(context: AgentContext): string {
       return buildAgentSystemPrompt("new-agent", this.profile, ...);
     }
     
     protected parseOutput(raw: string, context: AgentContext): AgentOutput { ... }
     
     async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> { ... }
   }
   ```

2. **Add type** to `src/core/agents/types.ts`:
   ```typescript
   export type AgentType = "chat" | "note-editor" | ... | "new-agent";
   ```

3. **Add specialization** to `src/core/agents/agentIdentity.ts`:
   ```typescript
   "new-agent": {
     role: "Role Title",
     mission: "What this agent does...",
     expertise: ["area1", "area2"],
     outputFormat: { type: "structured-json", instructions: "..." }
   }
   ```

4. **Wire into ChiefOfStaff** in `chiefOfStaff.ts`:
   - Add to constructor
   - Add routing logic in `determineRouting()`
   - Add to `getAgent()` switch

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

❌ **Don't bypass ChiefOfStaff**
- All agent execution goes through `ChiefOfStaff.execute()`
- Don't instantiate agents directly in UI code

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
| `src/core/agents/chiefOfStaff.ts` | Agent orchestrator |
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
