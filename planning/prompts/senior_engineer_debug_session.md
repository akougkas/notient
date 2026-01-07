# Notient Critical Debug Session - Senior Engineer Handover

## Executive Summary

Notient is an Obsidian plugin providing AI-powered note intelligence with local LLM support (Ollama for embeddings, LM Studio for chat/reasoning). After recent changes to the index naming system, multiple critical regressions have occurred. This document catalogs all known issues requiring immediate attention.

---

## Critical Issues (P0)

### 1. Index Discovery Completely Broken

**Symptom:** Every plugin restart triggers full reindexing. Previously indexed content is never discovered.

**Observed Behavior:**
```
[SetupWizard] Found 0 indices for model 'qwen3-embedding:0.6b' (expected dim: unknown)
[SimpleVectorStore] Created fresh index (1024-dim)
```

**Expected Behavior:** Should discover existing `idx_*.json` files and resume from them.

**Root Cause Investigation Needed:**
1. Audit `IndexManager.discoverIndices()` in `src/services/indexManager.ts`
2. Audit `SimpleVectorStore.discoverExistingIndex()` in `src/services/simpleVectorStore.ts`
3. Check if files are actually being written to disk (debounced save at 10s)
4. Verify regex patterns match actual filenames
5. Check `setupComplete` flag persistence in settings

**Files to Audit:**
- `src/services/indexManager.ts` - lines 507-620 (discoverIndices)
- `src/services/simpleVectorStore.ts` - lines 547-610 (discoverExistingIndex)
- `src/main.ts` - setup wizard flow and `setupComplete` handling
- `src/types/settings.ts` - settings persistence

### 2. LM Studio Provider Not Loading Models

**Symptom:** Health check shows model exists but isn't loaded. User claims there IS code to load models that I'm missing.

**Observed Error:**
```
[Notient] LLM Provider initialization failed: Error: lmstudio: Model 'iquest-coder-v1-40b-instruct' exists but is not loaded.
```

**Investigation Required:**
1. **CRITICAL**: Audit entire codebase for LM Studio model loading logic - the user states this existed and worked before
2. Check `src/services/lmstudio.ts` for any `load` or `activate` methods
3. Check `src/core/llm/providers/` for provider initialization
4. Search for any `/v1/models/load` or similar API calls
5. Check if there's CLI invocation (`lms load`) anywhere

**Files to Audit:**
- `src/services/lmstudio.ts`
- `src/core/llm/providers/openai-compatible.ts`
- `src/core/llm/providers/lmstudio.ts` (if exists)
- `src/services/healthMonitor.ts`

### 3. State File / Index File Mismatch

**Symptom:** State file loads with 79 notes but index file is not found.

**Observed:**
```
[IndexManager] Loading state from: state-qwen3-embedding_0_6b_d1024.json
[IndexManager] Loaded state: 79 notes
[SimpleVectorStore] Created fresh index (1024-dim)  # WHY FRESH?
```

**Investigation:**
1. State file naming: `state-{modelKey}.json` (legacy)
2. Index file naming: `idx_{timestamp}_{vaultHash}_{model}_{dim}d.json` (new)
3. These don't match! State uses legacy naming, index uses new naming
4. Need to ensure state path derivation matches index path

---

## High Priority Issues (P1)

### 4. Setup Wizard Runs Every Restart

**Symptom:** `setupComplete = false` persists, forcing wizard on every load.

**Check:**
- When is `setupComplete` set to `true`?
- Is settings being saved after wizard completion?
- Is there a race condition in initialization?

### 5. Reranking Failures

**Symptom:** Reranking calls fail with 400 errors even when model appears loaded.

**Files:**
- `src/core/search/pipeline.ts` - `rerankChunksWithLLM()`
- `src/core/llm/providers/openai-compatible.ts` - `rerank()`

### 6. Health Monitor Shows Green When Service is Broken

**Symptom:** Footer shows green health indicator but completions fail.

**Recent Changes Made (may have bugs):**
- Added test completion to `healthMonitor.ts` - verify this works
- Added test completion to `openai-compatible.ts` - verify this works

---

## Architecture Overview (For Context)

### Service Initialization Flow
```
main.ts: onload()
  → kernel.initialize()
  → showSetupWizard() if !setupComplete
  → initializeServicesAsync()
    → OllamaService.initialize()
    → LMStudioService.initialize()
    → SimpleVectorStore.initialize()
    → IndexManager.initialize()
    → SearchPipeline (uses above)
    → NotientAgent (uses LLM provider)
```

### Index Naming Convention (Recently Changed!)

**Old Format:**
- Index: `index-{modelKey}-{dim}d.json`
- State: `state-{modelKey}.json`

**New Format:**
- Index: `idx_{YYYYMMDD}T{HHMMSS}_{vaultHash}_{modelKey}_{dim}d.json`
- State: `state_{YYYYMMDD}T{HHMMSS}_{vaultHash}_{modelKey}_{dim}d.json`

**Problem:** Migration/discovery between formats may be broken.

### Key Services

| Service | File | Purpose |
|---------|------|---------|
| OllamaService | `src/services/ollama.ts` | Embeddings |
| LMStudioService | `src/services/lmstudio.ts` | Chat/Reasoning (legacy) |
| LMStudioProvider | `src/core/llm/providers/` | Chat/Reasoning (new) |
| SimpleVectorStore | `src/services/simpleVectorStore.ts` | Vector storage |
| IndexManager | `src/services/indexManager.ts` | Index coordination |
| HealthMonitor | `src/services/healthMonitor.ts` | Service health |
| SearchPipeline | `src/core/search/pipeline.ts` | Search + reranking |

---

## UI Wiring Audit Required

### Sidebar (`src/views/sidebar.ts`)
- [ ] Search triggers → SearchPipeline
- [ ] Chat triggers → NotientAgent
- [ ] Health indicators → HealthMonitor
- [ ] Index stats → IndexManager
- [ ] Footer status → serviceHealth

### Settings (`src/settings.ts`)
- [ ] Index grid → IndexManager.discoverIndices()
- [ ] Switch index → IndexManager.switchToIndex()
- [ ] Export/Import → IndexManager methods
- [ ] Model selection → saves to settings, triggers reinit

### Setup Wizard (`src/views/setupWizard.ts`)
- [ ] Index discovery → IndexManager.discoverIndices()
- [ ] Model verification → HealthMonitor
- [ ] Selection persistence → settings

---

## Specific Code Locations to Fix

### 1. Index Discovery
```typescript
// src/services/indexManager.ts:507-620
static async discoverIndices(storagePaths: any): Promise<DiscoveredIndex[]>

// src/services/simpleVectorStore.ts:547-610
private async discoverExistingIndex(): Promise<string | null>
```

### 2. State/Index Path Matching
```typescript
// src/services/indexManager.ts:728-741
private getStatePath(): string

// src/services/indexManager.ts:713-721
private generateIndexPath(): string
```

### 3. LM Studio Connection
```typescript
// src/services/lmstudio.ts - ENTIRE FILE
// src/core/llm/providers/openai-compatible.ts:44-85 - initialize()
// src/services/healthMonitor.ts:108-159 - checkLMStudio()
```

### 4. Setup Completion
```typescript
// src/main.ts - search for "setupComplete"
// src/views/setupWizard.ts - result handling
```

---

## Testing Checklist

After fixes, verify:

1. [ ] Fresh install: wizard runs once, completes, never shows again
2. [ ] Existing index: discovered on restart, no reindexing
3. [ ] LM Studio: model loads or clear error shown
4. [ ] Health indicators: accurately reflect service state
5. [ ] Settings page: shows all indices with correct metadata
6. [ ] Index operations: trim, rebuild, export all work
7. [ ] Search: returns results with proper reranking
8. [ ] Chat: NotientAgent responds using LLM

---

## Commands for Debugging

```bash
# Build and watch for errors
npm run build

# Check what index files exist
ls -la .obsidian/plugins/notient/idx_*.json
ls -la .obsidian/plugins/notient/index-*.json
ls -la .obsidian/plugins/notient/state*.json

# Search for model loading code
grep -r "load.*model" src/
grep -r "/v1/models" src/
grep -r "lms load" src/
```

---

## Recent Changes That May Have Caused Regressions

1. **Index naming refactor** - Changed from `index-{model}-{dim}d.json` to `idx_{timestamp}_{vaultHash}_{model}_{dim}d.json`
2. **Added vaultHash** to StoragePaths
3. **Changed discoverIndices()** to return richer metadata
4. **Added test completion** to health checks
5. **Modified getStatePath()** to derive from index path

---

## Success Criteria

1. Plugin starts without forcing reindex if index exists
2. LM Studio connection works (model loads or is already loaded)
3. Health indicators accurately reflect state
4. Setup wizard only runs on first install
5. All UI elements properly wired to backend
6. No console errors during normal operation

---

## Notes for Engineer

- The user has been debugging for hours - treat their observations as reliable
- They explicitly said LM Studio model loading code EXISTS - find it
- The index discovery worked before the naming refactor - compare git history
- Focus on getting the basics working before adding features
- Test on Windows (user's platform has backslash path issues potentially)
