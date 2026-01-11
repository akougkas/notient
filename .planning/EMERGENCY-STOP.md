---
status: EMERGENCY_STOP
reason: Application fundamentally broken - CPU 100%, laptop overheating, UI frozen
created: 2026-01-11T11:15:00
priority: P0 - CRITICAL
---

# EMERGENCY: Full Stop on Beta Development

## What Happened

After a week of beta development, the application is fundamentally broken:
- **CPU spins at 100%** when plugin loads
- **Laptop overheating** - fans at maximum
- **UI freezes** - Obsidian becomes unresponsive
- **No meaningful output** - agents fail to produce results
- **Load time ~1 minute** for a plugin that should load in <2s

## Evidence From Console Logs

### 1. LLM Pipeline Completely Broken
```
[lmstudio] Using reasoning_content text (no JSON found)  // REPEATED 6+ TIMES
[lmstudio] Extracted JSON from reasoning_content
[Note Editor] JSON parse error:
[Note Editor] Generated 0 edit proposals  // TOTAL FAILURE
```

### 2. Reranker Making Excessive Blocking Calls
```
[OllamaRerankerService] Inferred no from "afterno..."
[OllamaRerankerService] Inferred no from "ersno..."
[OllamaRerankerService] Inferred no from "codno..."
// 13+ sequential blocking calls for ONE search query
// Each call waits for LLM response
```

### 3. Resource Exhaustion
```
[ChunkStore] Loaded 29050 chunks from 542 notes  // ALL IN MEMORY AT ONCE
[HNSWVectorStore] Loaded 22313 chunks, 471 note states  // MORE MEMORY
```

## Root Cause Analysis

### Critical Path Issues

1. **thinkingParser.ts** - Stripping valid JSON from reasoning model responses
   - Thinking models put JSON in `reasoning_content`, not `content`
   - Parser strips thinking tags but loses the JSON payload
   - Result: Every structured agent call fails

2. **ollamaReranker.ts** - Synchronous blocking nightmare
   - Makes 10-15 sequential LLM calls per search
   - Each call blocks the main thread
   - No batching, no caching, no parallelization
   - CPU spins waiting for each response

3. **No Resource Management**
   - 29K chunks loaded synchronously at startup
   - No lazy loading, no pagination, no streaming
   - Memory balloons, GC thrashes

4. **Preact/Obsidian Conflict**
   - Plugin uses Preact but Obsidian expects vanilla JS
   - Signal subscriptions may not clean up properly
   - React-like re-renders fighting Obsidian's DOM

5. **Index Loading Blocks UI**
   - All index operations are synchronous
   - UI thread frozen during load
   - No progress feedback

## Files That Need Major Surgery

| File | Problem | Impact |
|------|---------|--------|
| `src/core/chat/thinkingParser.ts` | Destroys JSON from thinking models | All agents fail |
| `src/services/ollamaReranker.ts` | 13+ blocking LLM calls per search | CPU 100%, UI freeze |
| `src/services/hnswVectorStore.ts` | Loads everything into memory | Memory exhaustion |
| `src/core/llm/providers/openai-compatible.ts` | Doesn't handle reasoning_content | JSON extraction fails |
| `src/ui/sidebar/App.tsx` | Too many signal subscriptions | Re-render storms |

## What Must Be Fixed Before ANY Beta Work

### Phase 0: Foundation Repair (NEW PHASE)

1. **Fix LLM Response Pipeline** (P0)
   - Handle `reasoning_content` vs `content` properly
   - Extract JSON from thinking model outputs
   - Test with actual reasoning models (falcon-h1r, qwen3)

2. **Fix or Remove Reranker** (P0)
   - Option A: Batch all candidates in ONE LLM call
   - Option B: Cache results aggressively
   - Option C: Remove entirely, use vector scores only

3. **Async Everything** (P0)
   - Index loading must be async with progress
   - Chunk loading must stream/paginate
   - Never block UI thread

4. **Memory Management** (P1)
   - Lazy load chunks on demand
   - LRU cache for embeddings
   - Dispose unused data

5. **UI Performance Audit** (P1)
   - Profile Preact renders
   - Check signal subscription cleanup
   - Minimize DOM updates

## Immediate Next Steps

When resuming:

1. **First**: Read this file completely
2. **Second**: Run `bun run dev` and watch console for the errors described above
3. **Third**: Start with `thinkingParser.ts` - this is blocking ALL agent functionality
4. **Fourth**: Address reranker - this is causing CPU spin

## Session Recovery Command

```bash
# Resume with:
/gsd:resume-work

# Or manually:
cd ~/projects/notient
cat .planning/EMERGENCY-STOP.md
```

## State of Codebase

- Branch: `beta-spec`
- Last commit: `ace3b84` - fix: resolve all lint warnings across codebase
- Working tree: clean
- But: The code compiles, it just doesn't WORK

## The Hard Truth

We spent a week adding features to a broken foundation. The lint fixes today were cosmetic - the real problems are architectural:

1. We never tested with actual thinking models
2. We never profiled resource usage
3. We assumed async would "just work"
4. We kept adding complexity without validating basics

**Must validate these work BEFORE any new features:**
- [ ] Chat produces responses
- [ ] Search returns results in <1s
- [ ] Agent actions complete successfully
- [ ] Plugin loads in <3s
- [ ] CPU stays <20% at idle
