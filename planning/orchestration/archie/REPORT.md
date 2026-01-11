# Archie Report
status: complete
commit: 3f12695, 5dfaa98 (init order fix)

## did

### Chat Model Decoupling (P0)
- src/main.ts:145-161: Split `llmFields` into `embeddingFields` and `chatFields`
  - Embedding changes (`ollama.host`, `ollama.embeddingModel`) → full reinit
  - Chat changes (`lmstudio.host`, `lmstudio.reasoningModel`) → `reinitializeChatOnly()`
- src/main.ts:1030-1104: Created `reinitializeChatOnly()` method
  - Disposes: lmStudioService, llmProvider, notientAgent, agentTaskQueue
  - Recreates: same services with new model
  - Preserves: vectorStore, indexManager, indexer, searchPipeline, conversationStore

### HNSW Race Fix (P0)
- src/services/hnswVectorStore.ts:136-150: Added ready state tracking
  - `isLibraryReady: boolean = false`
  - `libraryReadyPromise: Promise<void>` (resolves when WASM loads)
- src/services/hnswVectorStore.ts:224-227: Resolve promise in `initialize()`
- src/services/hnswVectorStore.ts:235-242: Added `async waitForReady(): Promise<void>`
- src/services/vectorStore.ts:70-74: Added optional `waitForReady()` to interface
- src/services/indexManager.ts:319-321: Call `waitForReady()` in `loadIndexFromPath()` BEFORE loading data
- src/main.ts:388-391: **FIX** - Call `vectorStore.initialize()` BEFORE `indexManager.initialize()` (was causing timeout)

### Abort Indexing on Reinit (P1)
- src/main.ts:96: Added `indexingAbortController: AbortController | null` field
- src/main.ts:1002-1006: Call `abort()` in `reinitializeServices()` BEFORE dispose
- src/main.ts:1191-1230: Updated `startBackgroundIndexing()` to create/pass AbortController signal
- src/core/indexer/simpleIndexer.ts:77-91: Added `signal?: AbortSignal` param to `syncVault()`
- src/core/indexer/simpleIndexer.ts:97-113: Listen for abort signal in `doSyncVault()`
- src/core/indexer/simpleIndexer.ts:183-198: Added `signal?: AbortSignal` param to `fullReindex()`

## verify
typecheck: pass
build: pass

## issues
none
