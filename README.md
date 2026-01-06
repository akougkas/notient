# Notient

> AI-powered vault management for Obsidian using local LLMs only

**Vision:** Notient replaces Smart Connections as #1 Obsidian AI plugin

## ✨ Features (Phase 1 MVP)

- **🔍 Semantic Search** - Find notes by meaning, not just keywords
- **🔗 Related Notes** - Discover connections between your ideas automatically
- **📊 Vault Vitals** - Dashboard showing vault health metrics
- **📁 PARA Detection** - Automatic classification based on folder structure
- **🔒 100% Local** - Your data never leaves your machine

## Prerequisites

- [Obsidian](https://obsidian.md/) desktop (v1.4.0+)
- [Ollama](https://ollama.ai/) running locally with an embedding model:
  ```bash
  ollama pull nomic-embed-text
  ```

## Installation (Dev Alpha)

1. Clone this repo into your vault's `.obsidian/plugins/` folder:
   ```bash
   cd your-vault/.obsidian/plugins
   git clone https://github.com/akougkas/notient.git
   cd notient
   ```

2. Install dependencies and build:
   ```bash
   bun install
   bun run build
   ```

3. Enable the plugin in Obsidian settings

## Development

```bash
# Install dependencies
bun install

# Build for production
bun run build

# Watch mode for development
bun run dev

# Type checking
bun run typecheck

# Run tests
bun test
```

## Architecture

```
src/
├── main.ts                 # Plugin entry point
├── settings.ts             # Settings management + UI
├── styles.css              # Theme-aware styling
├── types/                  # TypeScript type definitions
├── core/
│   ├── kernel.ts           # Service orchestration
│   ├── constants.ts        # Global constants
│   ├── events/             # Typed event bus
│   ├── queue/              # Persistent job queue
│   ├── indexer/            # Note indexing pipeline
│   ├── search/             # Semantic search
│   ├── vitals/             # Vault health metrics
│   └── para/               # PARA method detection
├── services/
│   ├── ollama.ts           # Embedding generation
│   ├── orama.ts            # Vector storage (pure JS)
│   ├── healthMonitor.ts    # Service health checks
│   ├── storagePaths.ts     # Path management
│   └── vaultLock.ts        # Multi-window safety
├── adapters/
│   └── obsidianFacade.ts   # Obsidian API wrapper
└── views/
    ├── sidebar.ts          # Search & related notes
    ├── dashboard.ts        # Vault vitals display
    └── setupWizard.ts      # First-run configuration
```

## Data Storage

All data is stored in `.obsidian/plugins/notient/`:

```
├── data.json              # Plugin settings
├── orama-*.json           # Vector embeddings (per model)
├── processing-queue/      # Background job state
├── cache/                 # Query caches
├── locks/                 # Multi-window locks
└── index-state.json       # Indexing progress
```

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Build:** Bun + esbuild
- **LLM Reasoning:** [LM Studio](https://lmstudio.ai/) (OpenAI-compatible API)
- **Embeddings:** [Ollama](https://ollama.ai/)
- **Vector DB:** [Orama](https://orama.com/) (pure JS, bundled)
- **UI:** Obsidian native API + CSS variables

## Roadmap

- [x] **Phase 1 (MVP):** Semantic search, related notes, basic vitals
- [ ] **Phase 2 (Intelligence):** Multi-pass processing, suggestions, context sidebar
- [ ] **Phase 3 (Agentic):** AI agent with confirmation dialogs, vault operations
- [ ] **Phase 4 (Polish):** Smart Connections migration, visualizations

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © Anthony Kougkas

---

*Built with ❤️ for the Obsidian community*
