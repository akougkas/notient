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
├── styles.css                 # Design system (59KB)
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
│   │   └── workflowRunner.ts
│   ├── context/vaultContextBuilder.ts
│   ├── search/pipeline.ts     # LLM-reranked search
│   ├── indexer/
│   │   ├── simpleIndexer.ts   # Batch processing
│   │   ├── simpleChunker.ts
│   │   └── tieredSemanticChunker.ts
│   ├── intelligence/
│   │   ├── noteIntelligence.ts
│   │   └── intelligenceDb.ts
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
│   ├── sidebar.ts             # Main sidebar (59KB - largest)
│   ├── dashboard.ts           # Vault vitals dashboard (31KB)
│   ├── taskModal.ts           # Chat modal (23KB)
│   ├── setupWizard.ts         # First-run setup (27KB)
│   └── indexOptionsModal.ts
└── types/
    ├── settings.ts            # NotientSettings
    ├── events.ts              # Event types
    ├── indexer.ts
    ├── search.ts
    └── vitals.ts
```

---

## Build Health

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | PASS | `bun run typecheck` |
| ESBuild | PASS | 278KB minified, 1.8MB dev |
| Biome Lint | WARN | Complexity warnings in agentLoop.ts, actionApplier.ts |

### Known Lint Warnings

- `agentLoop.ts:77` - `executeStreaming()` complexity 44 (max 15)
- `agentLoop.ts:298` - `parseActionPlan()` complexity 24 (max 15)
- `actionApplier.ts:111` - `validateAction()` complexity warning

---

## Data Files

Stored in `.obsidian/plugins/notient/`:

```
data.json                # Plugin settings
index-{modelKey}.json    # Hybrid embeddings
state-{modelKey}.json    # Index state per model
intelligence-*.json      # Note intelligence data
conversations.json       # Chat history
cache/                   # Search result cache
locks/                   # Multi-window safety
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

### 5. Workflow
`/enrich folder` → Progress updates → Review queue → Apply/Reject → Undo

### 6. Reinit
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

Production build: **278.9KB**

| Category | Size | % |
|----------|------|---|
| Views (UI) | ~76KB | 27% |
| Services | ~35KB | 12% |
| Core logic | ~65KB | 23% |
| Settings | ~14KB | 5% |
| Dependencies | ~16KB | 6% |
| Other | ~70KB | 25% |

---

## Planning Documents

- `planning/PRD.md` - Product requirements
- `planning/prompts/bootstrap.md` - Architecture spec

---

## Version

- **Current:** 0.1.0
- **Min Obsidian:** 1.4.0
