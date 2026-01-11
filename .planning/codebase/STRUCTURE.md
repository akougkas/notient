# Codebase Structure

**Analysis Date:** 2026-01-11

## Directory Layout

```
notient/
├── src/                    # Source code
│   ├── main.ts            # Plugin entry point
│   ├── adapters/          # External API wrappers
│   ├── core/              # Business logic
│   ├── services/          # Infrastructure services
│   ├── types/             # TypeScript interfaces
│   ├── ui/                # User interface
│   ├── utils/             # Shared utilities
│   └── styles.css         # Design tokens, component styles
├── scripts/               # Build tooling
├── testbench/             # Benchmarking scripts
├── .planning/             # Project planning docs
├── package.json           # Project manifest
├── tsconfig.json          # TypeScript configuration
└── biome.json             # Linter/formatter config
```

## Directory Purposes

**src/adapters/**
- Purpose: Thin wrappers over external APIs for testability
- Contains: `obsidianFacade.ts` - Vault, MetadataCache, Workspace abstraction
- Key files: Single file, may expand for other integrations

**src/core/**
- Purpose: All business logic organized by domain
- Contains: Agents, chat, indexing, search, intelligence, agentic actions
- Key files: `kernel.ts` (service registry), `constants.ts` (global constants)
- Subdirectories:
  - `agent/` - Tier 1 identity, task queue, profile manager
  - `agents/` - Multi-agent system (ChiefOfStaff, specialized agents)
  - `agentic/` - Action application, trust levels, workflow runner
  - `chat/` - Chat service, conversation persistence, thinking parser
  - `context/` - Vault context builder for RAG
  - `events/` - Typed EventBus
  - `evolution/` - User preference learning
  - `importer/` - External data import
  - `indexer/` - Tiered semantic chunking
  - `intelligence/` - Note intelligence generation
  - `llm/` - LLM provider abstraction
  - `para/` - PARA folder detection
  - `search/` - Search pipeline and strategies
  - `services/` - Initialization state machine
  - `vitals/` - Note health metrics

**src/services/**
- Purpose: Low-level infrastructure services
- Contains: Vector storage, health monitoring, LLM connectors, persistence
- Key files:
  - `healthMonitor.ts` - Provider health checks
  - `hnswVectorStore.ts` - HNSW vector search (WASM)
  - `indexManager.ts` - Index file I/O and state
  - `storagePaths.ts` - Single source of truth for paths
  - `ollama.ts`, `lmstudio.ts` - LLM service connectors
  - `vaultLock.ts` - Multi-window write locking

**src/types/**
- Purpose: TypeScript interfaces and type definitions
- Contains: Settings schema, event types, search types, profile types
- Key files:
  - `settings.ts` - NotientSettings, AgentSettings, TrustPolicy
  - `events.ts` - EventType, EventPayloads map
  - `indexer.ts` - NoteChunk, EmbeddedChunk, IndexProgress

**src/ui/**
- Purpose: All user interface components
- Contains: Preact sidebar, modals, settings panel, dashboard
- Subdirectories:
  - `sidebar/` - Main sidebar UI
    - `App.tsx` - Root component
    - `state.ts` - Preact signals state
    - `components/` - UI components
    - `hooks/` - Custom hooks
    - `context/` - Kernel context provider
  - `modals/` - Dialogs (SetupWizard, IndexDashboard, ProfileEdit)
  - `settings/` - Settings panel
  - `dashboard/` - Full-page dashboard view

**scripts/**
- Purpose: Build and development tooling
- Contains: `build.ts` - Custom Bun-based build system
- Key files: Single build script with dev/prod/clean/reset modes

## Key File Locations

**Entry Points:**
- `src/main.ts` - Plugin lifecycle (onload, onunload)
- `src/ui/sidebar/SidebarView.tsx` - Sidebar view factory

**Configuration:**
- `tsconfig.json` - TypeScript compiler options, path aliases
- `biome.json` - Linting and formatting rules
- `manifest.json` - Obsidian plugin metadata
- `package.json` - Dependencies, scripts

**Core Logic:**
- `src/core/kernel.ts` - Service registry and DI
- `src/core/agents/chiefOfStaff.ts` - Agent orchestrator
- `src/core/search/pipeline.ts` - Search execution
- `src/core/chat/chatService.ts` - Chat orchestration
- `src/core/indexer/tieredSemanticChunker.ts` - TSI v2 chunking

**Testing:**
- `testbench/reranking/` - Reranking model benchmarks
- `testbench/embedding/` - Embedding model benchmarks
- No unit tests in src/ (manual testing only)

**Documentation:**
- `README.md` - User-facing documentation
- `.claude/CLAUDE.md` - AI context and project instructions
- `.planning/` - Project planning artifacts

## Naming Conventions

**Files:**
- camelCase.ts for source files (`simpleIndexer.ts`, `chatAgent.ts`)
- PascalCase.tsx for React/Preact components (`App.tsx`, `NoteCard.tsx`)
- index.ts for barrel exports

**Directories:**
- kebab-case or camelCase (consistent within project)
- Plural for collections (`agents/`, `modals/`, `components/`)

**Special Patterns:**
- `*Agent.ts` for agent implementations
- `types.ts` for type definitions within directories
- `index.ts` for module re-exports

## Where to Add New Code

**New Agent:**
- Implementation: `src/core/agents/{name}Agent.ts`
- Type definition: Add to `src/core/agents/types.ts` (AgentType union)
- Specialization: Add to `src/core/agents/agentIdentity.ts`
- Wire in ChiefOfStaff: `src/core/agents/chiefOfStaff.ts`

**New UI Component:**
- Implementation: `src/ui/sidebar/components/{Name}.tsx`
- Types (if needed): `src/ui/sidebar/types.ts`
- State (if needed): `src/ui/sidebar/state.ts`

**New Service:**
- Implementation: `src/services/{name}.ts` or `src/core/{domain}/{name}.ts`
- Register in Kernel: `src/core/kernel.ts`
- Types: `src/types/{domain}.ts`

**New Workflow Prompt:**
- Implementation: `src/core/intelligence/prompts/{name}.ts`
- Export: `src/core/intelligence/prompts/index.ts`
- Config: `src/core/agents/workflowAgents.ts`

## Special Directories

**data/** (in vault plugin folder)
- Purpose: All plugin persistent data
- Source: Created at runtime, managed by plugin
- Committed: No (user data)
- Contents: chunks/, embeddings/, conversations/, actions/, intelligence/

**_operational/** (in vault plugin folder)
- Purpose: Volatile operational data
- Source: Runtime locks, caches, logs
- Committed: No (ephemeral)
- Safe to delete: Yes

---

*Structure analysis: 2026-01-11*
*Update when directory structure changes*
