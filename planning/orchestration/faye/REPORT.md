# Faye Report
status: partial
commit: 0876be2

## did

### P0 Complete
- src/ui/sidebar/components/search/SearchResultItem.tsx: New component with shimmer loading state
- src/ui/sidebar/components/search/SearchFooter.tsx: "Go Deeper" button with Shift+Enter hint
- src/ui/sidebar/components/search/DeepSearchIndicator.tsx: Inline progress during deep search
- src/ui/sidebar/components/search/SearchDropdown.tsx: Main container with FLIP reorder animation
- src/ui/sidebar/components/search/index.ts: Re-exports
- src/ui/sidebar/components/Omnibar.tsx: Full rewrite with progressive search integration
  - 300ms debounce, min 2 chars
  - INSTANT phase (no reranking) → EVOLVING phase (AI reranking)
  - 3s evolving timeout, 15s deep timeout
  - Keyboard navigation: Arrow Up/Down, Enter, Shift+Enter, ESC, Tab
  - Click outside to dismiss
  - Deep search with toast notifications
  - AI unavailable fallback warning
- styles.css: Added ~300 lines for search dropdown, shimmer, footer, warning, empty states

### P1 Pending
- Wire deep search to Insights Stream (task item 5)
- App.tsx needs onDeepSearchComplete callback to add results to Insights

## verify
typecheck: pass
build: pass

## issues
- Deep search results callback exists (onDeepSearchComplete) but not wired in App.tsx yet
- Needs App.tsx integration to complete P1

## next
Wire onDeepSearchComplete in App.tsx to add deep search results to InsightStream
