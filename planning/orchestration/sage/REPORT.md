# Sage Report - Phase 2 Review
status: blocked
commit: none

## reviewed

### Backend (src/core/search/progressiveSearch.ts)
- Three-tier progressive search: INSTANT → EVOLVING → DEEP
- Proper timeout handling with Promise.race
- AbortController cleanup: combineSignals uses `{ once: true }` - no leak
- dispose() cancels all active deep searches
- Event emission: 5 new events properly wired

### Events (src/types/events.ts)
- 5 new event types: progressive-instant, progressive-evolving, deep-started, deep-complete, deep-cancelled
- Payload interfaces properly typed with SearchResult[]

### Kernel (src/core/kernel.ts)
- progressiveSearch registered in ServiceRegistry
- Added to getService/registerService switches
- Added to dispose() cleanup sequence

### Omnibar (src/ui/sidebar/components/Omnibar.tsx)
- Rewrite implements progressive search inline (not via orchestrator)
- Debounced input with abort on new query
- Cleanup on unmount: clears timeouts, aborts both search and deep search
- Click-outside handling for dropdown dismiss

### Search Components (src/ui/sidebar/components/search/*.tsx)
- SearchDropdown: FLIP animation for reorder during evolving phase
- SearchResultItem: Shimmer loading state, PARA icons
- SearchFooter: "Go Deeper" button with Shift+Enter hint
- DeepSearchIndicator: Spinner with cancel button

## issues

### CRITICAL: Missing CSS Styles
The following classes are used in components but NOT defined in styles.css:

**SearchDropdown:**
- `.nv2-search-dropdown`
- `.nv2-search-warning`, `.nv2-search-warning-icon`
- `.nv2-search-empty`, `.nv2-search-empty-text`, `.nv2-search-empty-hint`
- `.nv2-search-results`

**SearchResultItem:**
- `.nv2-search-result`, `.nv2-search-result--selected`, `.nv2-search-result--loading`
- `.nv2-search-result-icon`, `.nv2-search-result-content`
- `.nv2-search-result-title`, `.nv2-search-result-meta`
- `.nv2-search-result-path`, `.nv2-search-result-dot`, `.nv2-search-result-time`
- `.nv2-search-result-snippet`, `.nv2-search-result-score`

**SearchFooter:**
- `.nv2-search-footer`, `.nv2-search-footer-hint`
- `.nv2-search-deep-btn`, `.nv2-search-deep-btn--loading`
- `.nv2-search-deep-icon`, `.nv2-search-deep-icon--spin`
- `.nv2-search-deep-label`

**DeepSearchIndicator:**
- `.nv2-deep-search-indicator`
- `.nv2-deep-search-spinner`, `.nv2-deep-search-text`
- `.nv2-deep-search-cancel`

### Minor: itemRefs accumulation
SearchDropdown.tsx `itemRefs.current` Map is never cleared - stale refs accumulate over session.

## verify
typecheck: pass
build: pass (566.8kb)

## action required
Faye must add CSS styles for all missing classes before Phase 2 can be marked complete.
