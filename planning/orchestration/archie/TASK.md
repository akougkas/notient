# Archie - Phase 2: Progressive Search Backend
status: ready
phase: p2-s1
branch: ALPHA-SPEC-SPRINT

## context
Phase 2 transforms search from discrete modes (Quick/Balanced/Thorough) into progressive enhancement.
Users see INSTANT results (<200ms) that refine via EVOLVING (AI reranking 1-2s).
DEEP search is separate, async, cancellable - results go to Insights Stream.

Spec: `planning/orchestration/phase-2-progressive-search.md`

## do

### 1. Add progressive search event types (P0)
- src/types/events.ts
  - Add event types to EventType union:
    ```typescript
    | "search:progressive-instant"
    | "search:progressive-evolving"
    | "search:deep-started"
    | "search:deep-complete"
    | "search:deep-cancelled"
    ```
  - Add event payload interfaces:
    ```typescript
    interface ProgressiveInstantEvent {
      query: string;
      results: SearchResult[];
    }
    interface ProgressiveEvolvingEvent {
      query: string;
      results: SearchResult[];
      reordered: boolean;
    }
    interface DeepSearchStartedEvent {
      searchId: string;
      query: string;
    }
    interface DeepSearchCompleteEvent {
      searchId: string;
      query: string;
      results: SearchResult[];
      durationMs: number;
    }
    interface DeepSearchCancelledEvent {
      searchId: string;
    }
    ```
  - Add to EventPayloads mapping

### 2. Create ProgressiveSearchOrchestrator (P0)
- src/core/search/progressiveSearch.ts (NEW FILE)
  - Class that coordinates three-tier search:
    ```typescript
    export class ProgressiveSearchOrchestrator {
      constructor(
        private pipeline: SearchPipeline,
        private eventBus: EventBus,
      ) {}

      async *search(query: string, signal?: AbortSignal): AsyncIterable<ProgressiveSearchEvent>
      async deepSearch(query: string, signal?: AbortSignal): Promise<DeepSearchResult>
      cancelDeepSearch(searchId: string): void
    }
    ```
  - `search()` generator:
    - Phase 1 (INSTANT): Use pipeline.search() with preset="quick", topK=20, timeout 500ms
    - Yield `{ phase: "instant", status: "started" }` then `{ phase: "instant", status: "complete", results }`
    - Phase 2 (EVOLVING): Use pipeline.search() with preset="balanced", timeout 3s
    - Yield `{ phase: "evolving", status: "started" }` then `{ phase: "evolving", status: "complete", results }`
    - On failure: yield `{ phase: "evolving", status: "failed", error }`, keep INSTANT results
  - `deepSearch()`:
    - Generate unique searchId (crypto.randomUUID or Date.now().toString(36))
    - Store in activeDeepSearches Map for cancellation
    - Use pipeline.search() with preset="thorough", topK=50, timeout 15s
    - Emit "search:deep-started" event
    - On complete: emit "search:deep-complete" event
    - On cancel: emit "search:deep-cancelled" event
    - Return { searchId, results, cancelled }
  - `cancelDeepSearch(searchId)`:
    - Abort via stored AbortController
    - Remove from activeDeepSearches

### 3. Add config constants (P1)
- src/core/search/progressiveSearch.ts
  - Add SEARCH_CONFIG object (matching spec):
    ```typescript
    const SEARCH_CONFIG = {
      debounceMs: 300,
      minQueryLength: 2,
      instantTimeoutMs: 500,
      evolvingTimeoutMs: 3000,
      deepTimeoutMs: 15000,
      maxDropdownResults: 10,
      deepConcurrency: 1,
    };
    ```

### 4. Register with Kernel (P1)
- src/core/kernel.ts
  - Import ProgressiveSearchOrchestrator
  - Create instance during startup (after SearchPipeline)
  - Register as service: `this.services.set("progressiveSearch", orchestrator)`

### 5. Export from search index (P0)
- src/core/search/index.ts
  - Export ProgressiveSearchOrchestrator class
  - Export SEARCH_CONFIG constants
  - Export ProgressiveSearchEvent type

## anti-patterns
- Don't modify SearchPipeline.search() - progressive orchestrator wraps it
- Don't block on EVOLVING failure - yield error and keep INSTANT results
- Don't allow multiple concurrent deep searches - cancel previous first
- Don't hardcode timeouts in multiple places - use SEARCH_CONFIG

## verify
- `bun run typecheck` → pass
- `bun run build` → pass
- manual: import ProgressiveSearchOrchestrator → no errors
- manual: kernel.getService("progressiveSearch") → returns instance

## git
files: src/types/events.ts, src/core/search/progressiveSearch.ts, src/core/search/index.ts, src/core/kernel.ts, planning/orchestration/archie/REPORT.md
msg: "feat(search): Add ProgressiveSearchOrchestrator for three-tier search"
