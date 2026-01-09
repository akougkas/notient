# Notient - Project Context

> AI-powered vault management for Obsidian using local LLMs only.

## Quick Reference

```bash
# Development
bun run dev              # Build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:reset        # Soft reset (clear settings, keep index)
bun run dev:hard-reset   # Hard reset (wipe everything)

# Production
bun run build            # Typecheck + production build (minified)
bun run build:dev        # Development build (with sourcemaps)
bun run build:analyze    # Bundle analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

## Architecture Overview

```
src/
├── main.ts                    # Plugin entry point (30KB)
├── settings.ts                # Settings tab UI (27KB)
├── styles.css                 # Design system (61KB)
├── adapters/
│   └── obsidianFacade.ts      # Obsidian API wrapper
├── core/
│   ├── kernel.ts              # Service registry & orchestration
│   ├── constants.ts           # View types, defaults
│   ├── events/eventBus.ts     # Typed pub/sub
│   ├── llm/                   # LLM abstraction layer
│   │   ├── types.ts           # ChatMessage, CompletionOptions
│   │   ├── provider.ts        # LLMProvider interface
│   │   └── providers/
│   │       ├── openai-compatible.ts  # Base OpenAI-style
│   │       └── lmstudio.ts           # LM Studio specific
│   ├── agent/                 # Notient agent module
│   │   ├── agentLoop.ts       # Core execution (high complexity)
│   │   ├── taskQueue.ts       # Sequential task queue
│   │   ├── promptBuilder.ts   # RAG formatting
│   │   └── taskInference.ts   # Task type detection
│   ├── chat/                  # Chat module
│   │   ├── session.ts         # History, sliding window
│   │   ├── streaming.ts       # Stream utilities
│   │   └── conversationStore.ts
│   ├── agentic/               # Autonomous operations
│   │   ├── trustLevelManager.ts
│   │   ├── actionApplier.ts
│   │   ├── actionHistory.ts
│   │   ├── workflowRunner.ts
│   │   ├── commandParser.ts   # Slash command parsing
│   │   └── types.ts           # ProposedAction, WorkflowRun types
│   ├── context/vaultContextBuilder.ts
│   ├── search/pipeline.ts     # LLM-reranked search
│   ├── indexer/
│   │   ├── simpleIndexer.ts   # Batch processing
│   │   ├── simpleChunker.ts   # Legacy chunker
│   │   └── tieredSemanticChunker.ts  # 3-tier chunking (note/section/block)
│   ├── intelligence/          # Intelligence 2.0
│   │   ├── noteIntelligence.ts      # Background note analysis
│   │   ├── intelligenceDb.ts        # Persistence layer
│   │   ├── actionOrchestrator.ts    # Dispatches 7 action types
│   │   ├── actionPipeline.ts        # 5-phase execution pipeline
│   │   ├── types.ts                 # IntelligenceRecord types
│   │   └── prompts/                 # 7 specialized LLM prompts
│   │       ├── atomic.ts            # Split into atomic notes
│   │       ├── synthesis.ts         # Create synthesis notes
│   │       ├── clipping.ts          # Process web clippings
│   │       ├── task.ts              # Extract tasks/deadlines
│   │       ├── brand.ts             # Brand alignment check
│   │       ├── connection.ts        # Find semantic connections
│   │       └── enhance.ts           # Enhance informal notes
│   ├── para/detector.ts       # PARA classification
│   └── vitals/simpleVitals.ts # Vault health metrics
├── services/
│   ├── simpleVectorStore.ts   # Brute-force cosine similarity (25KB)
│   ├── indexManager.ts        # Coordinates vector + state (32KB)
│   ├── lmstudio.ts            # LM Studio service
│   ├── ollama.ts              # Ollama embeddings
│   ├── healthMonitor.ts       # Service health tracking
│   ├── vaultLock.ts           # Multi-window safety
│   └── storagePaths.ts        # Data file paths
├── views/
│   ├── sidebar.ts             # Main sidebar (60KB - largest)
│   ├── dashboard.ts           # Vault vitals dashboard (31KB)
│   ├── taskModal.ts           # Chat modal (23KB)
│   ├── setupWizard.ts         # First-run setup (27KB)
│   └── indexOptionsModal.ts
└── types/
    ├── settings.ts            # NotientSettings
    ├── events.ts              # Event types (includes workflow events)
    ├── indexer.ts
    ├── search.ts
    └── vitals.ts
```

---

## Build Health

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | PASS | `bun run typecheck` |
| ESBuild | PASS | 290KB minified, ~1.9MB dev |
| Biome Lint | WARN | Complexity warnings (expected), `any` in noteIntelligence.ts |

### Known Lint Warnings

- `agentLoop.ts:77` - `executeStreaming()` complexity 44 (max 15)
- `agentLoop.ts:298` - `parseActionPlan()` complexity 24 (max 15)
- `actionApplier.ts:111` - `validateAction()` complexity warning
- `noteIntelligence.ts` - `any` type warnings in JSON parsing (expected)

---

## Implementation Status

### Fully Complete
- ✅ Kernel & service orchestration
- ✅ Agent loop + task queue + streaming
- ✅ Trust levels + action history (undo)
- ✅ LLM abstraction layer (providers)
- ✅ Search pipeline (3 modes: quick/balanced/thorough)
- ✅ Chat sessions + conversation store
- ✅ TieredSemanticChunker (3-tier: note/section/block)
- ✅ NoteIntelligenceService (summaries, entities, tags, health)
- ✅ WorkflowRunner (queue, progress, review queue, error tracking)
- ✅ Dual-view sidebar + omnibar
- ✅ Dashboard (vitals/actions/index tabs)
- ✅ Setup wizard + settings

### Intelligence 2.0 (Core Ready, UI Pending)
- ✅ ActionOrchestrator - 7 action types dispatched
- ✅ ActionPipeline - 5-phase execution with events
- ✅ All 7 prompt templates defined
- ✅ Action converters (atomic, synthesis, clipping, task, brand, connection, enhance)
- ✅ Review queue → ActionApplier flow connected
- ⏳ **UI event consumers** - Sidebar doesn't yet render PipelineEvents

---

## Data Files

Stored in `.obsidian/plugins/notient/`:

```
data.json                      # Plugin settings
idx_*_{modelKey}_Xd.json       # Vector index (new format)
state-{modelKey}.json          # Index state per model
intelligence-{modelKey}.json   # Note intelligence data
conversations.json             # Chat history
action-history.json            # Applied actions for undo
cache/                         # Search result cache
locks/                         # Multi-window safety
```

---

## Key Flows

### 1. Fresh Install
Setup Wizard → Service connection → Model selection → Index creation → Search

### 2. Note Intelligence
Open note → Vitals render → Quick Action → Task completes → Action history

### 3. Search
Omnibar → Vector search (top-50) → LLM reranking → Results with reasoning

### 4. Chat
TaskModal → Send message → Streaming response → Citations as [[links]]

### 5. Workflow (Bulk Operations)
`/enrich folder` → Progress updates → Review queue → Apply/Reject → Undo

### 6. Intelligence 2.0 Actions
Trigger action → ActionOrchestrator.execute() → 5-phase pipeline → PipelineEvents → Actions proposed → Apply/Dismiss

### 7. Reinit
Change LLM settings → Services reinitialize → No leaks → Index preserved

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun
- **Build:** esbuild (see `scripts/build.ts`)
- **Lint:** Biome
- **LLM (Reasoning):** LM Studio (OpenAI-compatible)
- **LLM (Embeddings):** Ollama
- **Vector Store:** Custom brute-force cosine similarity (zero deps)
- **UI:** Obsidian API + native components

---

## Development Notes

### Embedding Strategy
- **Note-level:** Whole-note vectors for broad matching
- **Section-level:** Heading-aware chunks for precision
- **Updates:** Debounced, incremental (content-hash detection)

### Search Strategy
1. Vector search → top-50 candidates (<100ms)
2. LM Studio reranks by relevance (~500ms)
3. Results with reasoning/citations

### Core Principles
1. **Local-only** - No cloud APIs ever
2. **Human-in-steering-wheel** - Trust levels, universal undo
3. **Theme-aware** - Respects Obsidian themes
4. **Simplicity** - Clean abstractions, no debug cruft

---

## File Size Reference (Top 10)

| File | Size | Purpose |
|------|------|---------|
| sidebar.ts | 59KB | Main UI surface |
| styles.css | 59KB | Design system |
| dashboard.ts | 31KB | Vault vitals |
| main.ts | 30KB | Entry point |
| setupWizard.ts | 27KB | First-run |
| settings.ts | 27KB | Settings tab |
| simpleVectorStore.ts | 25KB | Vector operations |
| taskModal.ts | 23KB | Chat interface |
| indexManager.ts | 32KB | Index coordination |

---

## Bundle Composition

Production build: **~290KB**

| Category | Size | % |
|----------|------|---|
| Views (UI) | ~78KB | 27% |
| Services | ~35KB | 12% |
| Core logic | ~75KB | 26% |
| Intelligence 2.0 | ~20KB | 7% |
| Settings | ~14KB | 5% |
| Dependencies | ~16KB | 5% |
| Other | ~52KB | 18% |

---

## Planning Documents

- `planning/PRD.md` - Product requirements
- `planning/prompts/bootstrap.md` - Architecture spec

---

## Version

- **Current:** 0.1.0
- **Min Obsidian:** 1.4.0
