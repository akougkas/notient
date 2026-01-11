# External Integrations

**Analysis Date:** 2026-01-11

## APIs & External Services

**LM Studio (Local LLM Reasoning):**
- SDK/Client: `@lmstudio/sdk 0.3.0` (`package.json`)
- Default Host: `http://127.0.0.1:1234` (`src/types/settings.ts`)
- Implementation: `src/core/llm/providers/lmstudio.ts`, `src/services/lmstudio.ts`
- Endpoints:
  - `POST /v1/chat/completions` - Chat completions (streaming)
  - `GET /v1/models` - List available models
- Supported Models: Falcon H1R, DeepSeek R1, OpenAI-compatible
- Features: Streaming, thinking tag extraction for reasoning models

**Ollama (Local Embeddings & Reranking):**
- SDK/Client: `ollama 0.5.0` (`package.json`)
- Default Host: `http://127.0.0.1:11434` (`src/types/settings.ts`)
- Implementation:
  - Embeddings: `src/services/ollama.ts`
  - Reranking: `src/services/ollamaReranker.ts`
- Endpoints:
  - `POST /api/embed` - Generate embeddings (batch support)
  - `POST /api/show` - Model capabilities discovery
- Default Models:
  - Embedding: `qwen3-embedding:0.6b`
  - Reranker: `B-A-M-N/Qwen3-Reranker-4B` (locked after benchmarking)

## Data Storage

**Vector Store:**
- Technology: HNSW via `hnswlib-wasm 0.8.2`
- Implementation: `src/services/hnswVectorStore.ts`
- Features:
  - O(log N) search performance
  - Configurable HNSW parameters (M=16, efConstruction=200)
  - Cosine distance metric
  - Serialization for persistence

**File Storage:**
- All data stored in vault: `.obsidian/plugins/notient/`
- Managed via: `src/services/storagePaths.ts`
- Structure:
  - `data/chunks/` - Model-agnostic chunk content
  - `data/embeddings/active/` - Current model index
  - `data/intelligence/topics/` - Per-tag intelligence
  - `data/conversations/notes/` - Per-note chat history
  - `data/actions/` - Time-bucketed action history

**Caching:**
- Search results: LRU cache (max 100 queries) in `src/core/search/pipeline.ts`
- No Redis or external cache (all in-memory or file-based)

## Authentication & Identity

**Auth Provider:**
- None - Local-only plugin, no external auth
- User profile stored locally: `data/profile/profile.json`

**OAuth Integrations:**
- None - Privacy-first design

## Monitoring & Observability

**Health Monitoring:**
- Implementation: `src/services/healthMonitor.ts`
- Tracks: Ollama status, LM Studio status, capability availability
- Updates via EventBus: `"system:status-changed"`

**Error Tracking:**
- console.error for runtime errors
- No external error tracking (Sentry, etc.)

**Analytics:**
- None - Privacy-first design

**Logs:**
- console.log with component prefixes
- No external log aggregation

## CI/CD & Deployment

**Hosting:**
- Distributed as Obsidian community plugin
- Plugin files: `main.js`, `manifest.json`, `styles.css`

**CI Pipeline:**
- Not configured (manual builds)
- Build command: `bun run build`

**Deployment:**
- Copy to vault: `bun run dev`
- Target vault: `/mnt/c/Users/akougk/Projects/vaultex`

## Environment Configuration

**Development:**
- Required services: LM Studio (port 1234), Ollama (port 11434)
- Settings: `data.json` in plugin folder
- Test vault: `/mnt/c/Users/akougk/Projects/vaultex`

**Production:**
- Same as development (local-first)
- User controls LLM model selection via settings

## Webhooks & Callbacks

**Incoming:**
- None - Local plugin

**Outgoing:**
- None - Privacy-first design

## Platform Integration

**Obsidian API:**
- Package: `obsidian 1.4.11`
- Entry: `src/main.ts`
- Facade: `src/adapters/obsidianFacade.ts`
- Features used:
  - Vault (file operations)
  - MetadataCache (frontmatter, links)
  - Workspace (views, leaves)
  - Plugin API (settings, commands, views)

**Markdown Processing:**
- Parser: `marked 17.0.1`
- Syntax highlighting: `prismjs 1.30.0`
- Implementation: `src/ui/sidebar/components/chat/MarkdownRenderer.tsx`

## Security Notes

**Privacy Guarantees:**
- No cloud APIs (OpenAI, Claude, etc.)
- All LLM processing is local
- No data leaves the user's machine
- No telemetry or analytics

**Local Services:**
- LM Studio: User controls which models run
- Ollama: User controls which models run
- Both require explicit user setup

---

*Integration audit: 2026-01-11*
*Update when adding/removing external services*
