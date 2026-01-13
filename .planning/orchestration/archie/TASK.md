# Archie - Data Layer Completion
status: ready
phase: universe-completion
branch: archie/data-layer

## do

### D10: SQLite Full Migration
- src/core/db/schema.ts: Review messages table, redesign if ConversationStore needs more fields
- src/core/chat/conversationStore.ts: Replace JSON with SQLite
  - DELETE `import * as fs from "node:fs"`
  - Use DatabaseService for all CRUD operations
  - Hard cutover - no migration, no backward compat
- src/core/agentic/actionHistory.ts: Replace JSON with SQLite
  - DELETE `import * as fs from "node:fs"`
  - Use existing actions table schema
- src/core/intelligence/intelligenceDb.ts: Replace JSON with SQLite
  - DELETE `import * as fs from "node:fs"`
  - Use existing intelligence table schema

### D5: embed.worker
- src/workers/embed.worker.ts: CREATE new worker
  - 4 concurrent HTTP calls to Ollama
  - Simple queue: receive texts, return embeddings
  - Use Transferable for Float32Array (zero-copy)
- src/core/vector/embedBridge.ts: CREATE main thread proxy
  - Similar pattern to workerBridge.ts

### D3: Reranker Fix
- src/services/ollamaReranker.ts: Fix output parsing
  - Model outputs `SCORE: 0/3/7/10` lines, NOT JSON
  - Simple regex: `const match = output.match(/SCORE:\s*(\d+)/)`
  - Fallback to 0 if no match

## context
Interview decisions (2026-01-13):
- Hard cutover for JSON → SQLite (no backward compat, test data only)
- Redesign messages schema if ConversationStore needs it
- embed.worker just parallelizes HTTP calls (4 concurrent)
- Reranker uses qwen-based models that output SCORE lines

## anti-patterns
- NO migration logic (just delete JSON, start fresh)
- NO backward compatibility code
- NO keeping both JSON and SQLite
- NO complex batching in embed.worker (just parallel fetch)

## verify
- `bun run typecheck` → passes
- `bun run build` → passes
- `grep -r "node:fs" src/core/chat src/core/agentic src/core/intelligence` → no matches
- embed.worker compiles alongside vector.worker

## git
files: src/core/db/schema.ts, src/core/chat/conversationStore.ts, src/core/agentic/actionHistory.ts, src/core/intelligence/intelligenceDb.ts, src/workers/embed.worker.ts, src/core/vector/embedBridge.ts, src/services/ollamaReranker.ts
msg: "feat(universe): D10 SQLite migration + D5 embed.worker + D3 reranker fix"
