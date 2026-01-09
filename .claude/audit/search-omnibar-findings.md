# Search & Omnibar Audit Findings

## Critical Issues (Blocking)

### 1. Service Key Mismatch - BLOCKING
- [ ] `getService("searchPipeline")` should be `getService("search")` | File: `src/core/intelligence/noteIntelligence.ts:503` | **Impact: findRelated() always returns []**

```typescript
// Wrong:
const search = this.kernel.getService<SearchPipeline>("searchPipeline");

// Correct (main.ts:298):
this.kernel.registerService("search", this.searchPipeline);
```

### 2. Omnibar Component NOT IMPLEMENTED
- [ ] CSS exists but no React component | File: `src/ui/styles/components/omnibar.css` (122 lines) | **Impact: No search UI**

**Infrastructure exists but unused:**
- `parseSlashCommand()` - defined but never called
- `getCommandSuggestions()` - defined but never called
- `getCommandDescription()` - defined but never called
- `isSlashCommand()` - defined but never called

---

## Implementation Gaps (Missing Features)

### 3. Search UI Integration Missing
- [ ] CSS classes exist but no Preact component | Expected: `Omnibar.tsx` | **Current: Nonexistent**

Missing components:
- Search results display component
- Hint/autocomplete panel
- Results rendering

### 4. Command Execution Flow Incomplete
- [ ] CommandParser can parse but nobody calls it | File: `src/core/agentic/commandParser.ts` | **Impact: Slash commands can't execute**

### 5. Search Events Not Consumed by UI
- [ ] `search:started` and `search:complete` events emitted but no listeners | File: `src/core/search/pipeline.ts:110, 117-122, 181-187` | **Impact: No progress feedback**

---

## Type Errors / Runtime Errors

### 6. Null Reference in NoteIntelligence
- [ ] `search.findRelated()` throws when search is null | File: `src/core/intelligence/noteIntelligence.ts:507` | **Impact: Crash on "Find related"**

### 7. Cache Key Generation Bug
- [ ] `getCacheKey()` includes `reranking` flag but lookup sometimes omits it | File: `src/core/search/pipeline.ts:416-427, 104-108` | **Impact: Wrong cached results**

---

## Mock/Stub Code

### 8. Fallback Reranker May Never Execute
- [ ] Fallback to vector scores when LLMProvider unavailable | File: `src/core/search/pipeline.ts:166-172` | **Status: Dead code path**

---

## Integration Issues

### 9. SearchPipeline Disposal Incomplete
- [ ] `dispose()` sets flag but doesn't abort pending operations | File: `src/core/search/pipeline.ts:471-474` | **Impact: Queries in flight may crash**

### 10. Hierarchical Search Creates Inconsistent Results
- [ ] Fallback to legacy behavior if no tier-specific chunks | File: `src/core/search/pipeline.ts:131-161` | **Impact: Results vary after reindex**

### 11. Vector Store Corruption Handled Silently
- [ ] Corrupt indices moved to `.deleted` but SearchPipeline not notified | Impact: Old data lost without notice

---

## Performance Issues

### 12. LLM Reranking Bottleneck
- [ ] Reranking limited to top 25 but retrieval gets 120 chunks | File: `src/core/search/pipeline.ts:143, 209` | **Impact: May miss relevant results**

### 13. Embedding Cache Not Semantic
- [ ] "machine learning" vs "ML" create separate cache entries | Impact: Wasted embedding calls

### 14. Chunk Text Truncation
- [ ] Reranking truncates chunks to 1200 chars | File: `src/core/search/pipeline.ts:253-255` | **Impact: Context loss for large sections**

### 15. PARA Detection Always Runs
- [ ] Every result goes through `detectType(path)` even when filter not requested | Impact: Unnecessary CPU

---

## Summary Table

| Category | Count | Severity |
|----------|-------|----------|
| Critical Issues | 2 | BLOCKING |
| Implementation Gaps | 3 | MAJOR |
| Type/Runtime Errors | 2 | HIGH |
| Mock/Stub | 1 | MEDIUM |
| Integration Issues | 3 | MEDIUM |
| Performance Issues | 4 | LOW |

**Total Issues:** 15

**Most Critical:**
1. Service key mismatch breaks "find related notes" feature
2. Omnibar UI completely missing despite having CSS + parser infrastructure
