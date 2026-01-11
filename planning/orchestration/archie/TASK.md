# Archie - 🔴 CODE RED: Vector Store Migration
status: ready
phase: code-red
branch: ALPHA-SPEC-SPRINT

## context
Gemini audit found: SimpleVectorStore is O(N). Searches 50k chunks by scanning every array. Blocks UI thread. Will freeze on 20k+ note vaults.

CEO Decision: WASM only, no Docker sidecar.

## do

### 1. Research WASM HNSW options (P0)
- hnswlib-wasm (most common)
- usearch (newer, faster)
- vectra (simpler API)

Evaluate: bundle size, API, Obsidian compatibility.

### 2. Create VectorStoreV2 interface (P0)
- src/services/vectorStoreV2.ts
- Same interface as current VectorStore
- Swap implementation without breaking consumers

### 3. Implement WASM-based store (P0)
- Initialize HNSW index on startup
- Migrate existing embeddings
- Ensure persist/load cycle works
- Handle index rebuild on model change

### 4. Migration path (P1)
- Detect old format, convert on first load
- Keep backup of old index
- Atomic write for crash safety

## constraints
- WASM only, no external processes
- Must work in Obsidian sandbox
- Keep VectorStore interface unchanged
- Don't break existing consumers

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- Search 10k chunks < 50ms (vs current 500ms+)
- Memory footprint reasonable

## git
files: src/services/vectorStoreV2.ts, src/services/simpleVectorStore.ts, planning/orchestration/archie/REPORT.md
msg: "feat(perf): Migrate to WASM HNSW vector store"
