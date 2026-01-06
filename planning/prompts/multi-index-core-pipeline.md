# Notient Backend Implementation - Multi-Index Architecture & Core Pipeline

## Context
We have an Obsidian plugin called Notient that provides AI-powered semantic search and vault management. 
The UI (wizard + settings) has been built but the backend needs proper implementation.

## Current State
- Setup wizard and settings page exist with UI for:
  - Separate Ollama/LM Studio configuration (host, port, model selection)
  - Chunk size slider (32-8192)
  - Excluded folders
  - Index management UI (export/import/trim/delete placeholders)

- Core services exist but may have broken integration:
  - `SimpleVectorStore` - brute-force cosine similarity
  - `IndexManager` - tracks note state per model
  - `SimpleIndexer` - batch embedding
  - `SearchPipeline` - cached semantic search
  - `HealthMonitor` - service health checks

## What Needs Implementation

### 1. Multi-Index Architecture
Currently index is tied to single model. Need:
- Store multiple indexes by model key (e.g., `index-nomic-embed-text_d768.json`)
- Allow switching between indexes without destroying old ones
- IndexManager should support: `listAvailableIndices()`, `switchIndex(modelKey)`, `deleteIndex(modelKey)`
- SearchPipeline could query MULTIPLE indexes for ensemble results

### 2. Model Auto-Detection
- When Ollama/LM Studio connects, fetch models via health monitor
- Auto-detect embedding dimensions by test embedding (or lookup table)
- Report dimension to UI for display
- Validate model compatibility before indexing

### 3. Crash Recovery / Session Resumption
- Track `indexingInProgress` and `indexingStartedAt` in state file
- On load, detect if previous session crashed mid-index
- Offer resume or restart options
- Show appropriate UI state (not stuck on "indexing...")

### 4. Index Management Operations
Implement the placeholder buttons:
- **Export**: Save index + state to single JSON/ZIP file
- **Import**: Load from exported file, validate model compatibility
- **Trim**: Remove vectors for notes that no longer exist in vault
- **Move**: Allow relocating index storage path

### 5. Settings → Service Integration
- Ensure wizard settings properly flow to kernel and services
- When model changes, detect if index rebuild needed
- Show clear warnings about index implications
- Re-test connections after settings change

### 6. Debug Current Pipeline
First priority: figure out why indexing isn't starting after wizard completion.
- Check console logs for errors
- Verify settings are saved correctly
- Ensure services initialize in correct order
- Test: wizard → settings saved → reinitialize → index starts

## Key Files
- `src/main.ts` - Plugin entry, service initialization
- `src/core/kernel.ts` - Service container
- `src/services/indexManager.ts` - Index state management
- `src/services/simpleVectorStore.ts` - Vector storage
- `src/core/indexer/simpleIndexer.ts` - Embedding pipeline
- `src/services/healthMonitor.ts` - Connection monitoring

## Success Criteria
1. Fresh install → wizard → indexing starts automatically
2. Model change → new index created, old preserved
3. Crash during indexing → recovery offered on restart
4. Export/Import round-trip works
5. Multiple models indexed → search works across all
