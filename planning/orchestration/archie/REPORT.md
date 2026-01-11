# Archie Report
status: complete
commit: 7314bb1

## did
- src/types/settings.ts:117-133: Added SearchSettings.progressive interface
  - enabled: boolean (default true) - toggle progressive vs legacy
  - showScores: boolean (default false) - display AI scores in results
  - autoDeep: boolean (default false) - auto-trigger deep for complex queries
- src/types/settings.ts:197: Added progressive defaults to DEFAULT_SETTINGS.search
- src/main.ts:31: Added ProgressiveSearchOrchestrator import
- src/main.ts:63: Added progressiveSearch member variable
- src/main.ts:412-414: Instantiated and registered ProgressiveSearchOrchestrator after SearchPipeline
- src/main.ts:218,1004: Added progressiveSearch?.dispose() cleanup in both unload paths
- src/ui/sidebar/components/Omnibar.tsx:19: Changed import from SearchPipeline to ProgressiveSearchOrchestrator
- src/ui/sidebar/components/Omnibar.tsx:189-257: Refactored executeProgressiveSearch to use orchestrator's generator
- src/ui/sidebar/components/Omnibar.tsx:280-316: Refactored executeDeepSearch to use orchestrator's deepSearch

## architecture
CEO decision: Wire Omnibar to ProgressiveSearchOrchestrator (Option A)
- Omnibar now uses kernel.getService("progressiveSearch") instead of inline search logic
- Progressive search generator yields INSTANT then EVOLVING events
- Deep search uses orchestrator's async deepSearch() with AbortController support

## verify
typecheck: pass
build: pass

## issues
none
