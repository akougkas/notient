# Archie - Chat Model Decoupling + HNSW Race Fix
status: ready
phase: code-red-fixes-2
branch: ALPHA-SPEC-SPRINT

## context
User changed chat model (Mistral → Falcon) via header pill. This SHOULD only affect chat service, NOT indexing. Current code (main.ts:145-156) couples all LLM settings changes to full reinitialization, destroying the index and restarting from scratch.

Additionally, HNSW WASM loads asynchronously. If IndexManager tries to load index before HNSW library is ready, the index is incorrectly marked corrupt, moved to .deleted/, and 877 documents of work is lost.

## do

### 1. Split LLM Fields (P0)
- src/main.ts:145-156: Replace single `llmFields` array with two:
  ```typescript
  const embeddingFields = ["ollama.host", "ollama.embeddingModel"];
  const chatFields = ["lmstudio.host", "lmstudio.reasoningModel"];
  ```
- Update handler logic:
  - If `embeddingFields` changed → `reinitializeServices()` (full reset)
  - If ONLY `chatFields` changed → `reinitializeChatOnly()` (new method)

### 2. Create reinitializeChatOnly() (P0)
- src/main.ts: New method that ONLY recreates chat services:
  - Dispose: `lmStudioService`, `llmProvider`, `notientAgent`, `agentTaskQueue`
  - Recreate: same services with new model
  - Preserve: `vectorStore`, `indexManager`, `indexer`, `searchPipeline`, `conversationStore`
  - ConversationStore stays alive → chat history preserved
  - Log: `[Notient] Chat model changed, reconnecting...`

### 3. HNSW Ready Check (P0)
- src/services/hnswVectorStore.ts:
  - Add private `isLibraryReady: boolean = false`
  - Add private `libraryReadyPromise: Promise<void>`
  - In constructor, set up promise that resolves when HNSW loads
  - Add `async waitForReady(): Promise<void>` method
  - In `loadFromData()`: await `waitForReady()` BEFORE accessing HNSW lib
- src/services/indexManager.ts:
  - In `loadIndexFromPath()`: await `vectorStore.waitForReady()` first

### 4. Abort Indexing on Reinit (P1)
- src/main.ts: Store `private indexingAbortController: AbortController | null`
- src/main.ts: In `startBackgroundIndexing()`, create and store AbortController
- src/main.ts: In `reinitializeServices()`, call `this.indexingAbortController?.abort()` BEFORE dispose
- src/core/indexer/simpleIndexer.ts: Check abort signal in `syncVault()` loop

## anti-patterns
- ❌ Do NOT modify UI code (Faye's domain)
- ❌ Do NOT break embedding model change flow (still needs full reinit)
- ❌ Do NOT add polling loops for HNSW ready - use Promise
- ❌ Do NOT change index file format

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- Manual: Change chat model → chat reconnects, index stays intact
- Manual: Change chat model during indexing → indexing continues uninterrupted
- Manual: Reload plugin → index loads without "HNSW not initialized" error
- Manual: Change embedding model → full reinit as before

## git
files: src/main.ts, src/services/hnswVectorStore.ts, src/services/indexManager.ts, src/core/indexer/simpleIndexer.ts, planning/orchestration/archie/REPORT.md
msg: "fix(backend): Decouple chat model from indexing + HNSW race fix"
