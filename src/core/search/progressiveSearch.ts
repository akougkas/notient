/**
 * Progressive Search Orchestrator
 *
 * Coordinates three-tier search for progressive enhancement:
 * - INSTANT (<500ms): Quick search for immediate results
 * - EVOLVING (<3s): Balanced search with AI reranking
 * - DEEP (async): Thorough agentic search, cancellable
 *
 * Users see INSTANT results immediately that refine via EVOLVING.
 * DEEP search runs separately and results go to Insights Stream.
 */

import type { SearchResult } from "../../types/search";
import type { EventBus } from "../events/eventBus";
import type { SearchPipeline } from "./pipeline";

// =============================================================================
// Configuration
// =============================================================================

/** Search configuration constants */
export const SEARCH_CONFIG = {
  /** Debounce delay for search input (ms) */
  debounceMs: 300,
  /** Minimum query length to trigger search */
  minQueryLength: 2,
  /** Timeout for INSTANT phase (ms) */
  instantTimeoutMs: 500,
  /** Timeout for EVOLVING phase (ms) */
  evolvingTimeoutMs: 3000,
  /** Timeout for DEEP search (ms) */
  deepTimeoutMs: 15000,
  /** Maximum results in dropdown */
  maxDropdownResults: 10,
  /** Maximum concurrent deep searches */
  deepConcurrency: 1,
} as const;

// =============================================================================
// Types
// =============================================================================

/** Phase of progressive search */
export type ProgressiveSearchPhase = "instant" | "evolving";

/** Status of a search phase */
export type ProgressiveSearchStatus = "started" | "complete" | "failed";

/** Event yielded by the search generator */
export interface ProgressiveSearchEvent {
  phase: ProgressiveSearchPhase;
  status: ProgressiveSearchStatus;
  results?: SearchResult[];
  error?: Error;
}

/** Result of a deep search */
export interface DeepSearchResult {
  searchId: string;
  results: SearchResult[];
  cancelled: boolean;
  durationMs: number;
}

/** Active deep search tracking */
interface ActiveDeepSearch {
  searchId: string;
  controller: AbortController;
  startTime: number;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Orchestrates progressive search with three tiers
 */
export class ProgressiveSearchOrchestrator {
  private activeDeepSearches: Map<string, ActiveDeepSearch> = new Map();
  private disposed = false;

  constructor(
    private pipeline: SearchPipeline,
    private eventBus: EventBus,
  ) {}

  /**
   * Progressive search generator - yields INSTANT then EVOLVING results
   *
   * @param query - Search query
   * @param signal - Optional abort signal
   * @yields ProgressiveSearchEvent for each phase
   */
  async *search(query: string, signal?: AbortSignal): AsyncIterable<ProgressiveSearchEvent> {
    if (this.disposed) return;

    // Phase 1: INSTANT
    yield { phase: "instant", status: "started" };

    try {
      const instantResults = await this.searchWithTimeout(
        query,
        "quick",
        SEARCH_CONFIG.instantTimeoutMs,
        signal,
      );

      if (signal?.aborted) return;

      yield { phase: "instant", status: "complete", results: instantResults };

      // Emit event for UI
      this.eventBus.emit("search:progressive-instant", {
        query,
        results: instantResults,
      });
    } catch (error) {
      yield {
        phase: "instant",
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
      // Don't return - try EVOLVING anyway
    }

    if (signal?.aborted) return;

    // Phase 2: EVOLVING
    yield { phase: "evolving", status: "started" };

    try {
      const evolvingResults = await this.searchWithTimeout(
        query,
        "balanced",
        SEARCH_CONFIG.evolvingTimeoutMs,
        signal,
      );

      if (signal?.aborted) return;

      yield { phase: "evolving", status: "complete", results: evolvingResults };

      // Emit event for UI - check if results were reordered
      this.eventBus.emit("search:progressive-evolving", {
        query,
        results: evolvingResults,
        reordered: true, // Balanced always reranks
      });
    } catch (error) {
      yield {
        phase: "evolving",
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
      // INSTANT results remain valid
    }
  }

  /**
   * Deep search - async, cancellable, results go to Insights
   *
   * @param query - Search query
   * @param signal - Optional abort signal
   * @returns Deep search result
   */
  async deepSearch(query: string, signal?: AbortSignal): Promise<DeepSearchResult> {
    if (this.disposed) {
      return { searchId: "", results: [], cancelled: true, durationMs: 0 };
    }

    // Cancel previous deep search if at concurrency limit
    if (this.activeDeepSearches.size >= SEARCH_CONFIG.deepConcurrency) {
      const [oldestId] = this.activeDeepSearches.keys();
      if (oldestId) {
        this.cancelDeepSearch(oldestId);
      }
    }

    // Generate unique search ID
    const searchId = `deep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const controller = new AbortController();
    const startTime = Date.now();

    // Combine external signal with our controller
    const combinedSignal = signal
      ? this.combineSignals(signal, controller.signal)
      : controller.signal;

    // Track active search
    this.activeDeepSearches.set(searchId, {
      searchId,
      controller,
      startTime,
    });

    // Emit started event
    this.eventBus.emit("search:deep-started", { searchId, query });

    try {
      const results = await this.searchWithTimeout(
        query,
        "thorough",
        SEARCH_CONFIG.deepTimeoutMs,
        combinedSignal,
      );

      const durationMs = Date.now() - startTime;

      // Remove from active
      this.activeDeepSearches.delete(searchId);

      // Check if cancelled during execution
      if (combinedSignal.aborted) {
        this.eventBus.emit("search:deep-cancelled", { searchId });
        return { searchId, results: [], cancelled: true, durationMs };
      }

      // Emit complete event
      this.eventBus.emit("search:deep-complete", {
        searchId,
        query,
        results,
        durationMs,
      });

      return { searchId, results, cancelled: false, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Remove from active
      this.activeDeepSearches.delete(searchId);

      // Check if aborted
      if (combinedSignal.aborted) {
        this.eventBus.emit("search:deep-cancelled", { searchId });
        return { searchId, results: [], cancelled: true, durationMs };
      }

      // Log error but return empty results
      console.error("[ProgressiveSearch] Deep search failed:", error);
      return { searchId, results: [], cancelled: false, durationMs };
    }
  }

  /**
   * Cancel an active deep search
   *
   * @param searchId - ID of the search to cancel
   */
  cancelDeepSearch(searchId: string): void {
    const active = this.activeDeepSearches.get(searchId);
    if (active) {
      active.controller.abort();
      this.activeDeepSearches.delete(searchId);
      this.eventBus.emit("search:deep-cancelled", { searchId });
    }
  }

  /**
   * Cancel all active deep searches
   */
  cancelAllDeepSearches(): void {
    for (const searchId of this.activeDeepSearches.keys()) {
      this.cancelDeepSearch(searchId);
    }
  }

  /**
   * Check if a deep search is active
   */
  isDeepSearchActive(searchId: string): boolean {
    return this.activeDeepSearches.has(searchId);
  }

  /**
   * Get count of active deep searches
   */
  getActiveDeepSearchCount(): number {
    return this.activeDeepSearches.size;
  }

  /**
   * Dispose of the orchestrator
   */
  dispose(): void {
    this.disposed = true;
    this.cancelAllDeepSearches();
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Search with timeout protection
   */
  private async searchWithTimeout(
    query: string,
    preset: "quick" | "balanced" | "thorough",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    // Create timeout promise
    const timeoutPromise = new Promise<SearchResult[]>((_, reject) => {
      setTimeout(() => reject(new Error(`Search timeout (${timeoutMs}ms)`)), timeoutMs);
    });

    // Create search promise with temporary settings override
    const searchPromise = this.pipeline.search(query, {
      // Use preset defaults by not overriding topK/minScore
      enableReranking: preset !== "quick",
    });

    // Race between search and timeout
    return Promise.race([searchPromise, timeoutPromise]);
  }

  /**
   * Combine multiple abort signals into one
   */
  private combineSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    const abort = () => controller.abort();

    if (signal1.aborted || signal2.aborted) {
      controller.abort();
    } else {
      signal1.addEventListener("abort", abort, { once: true });
      signal2.addEventListener("abort", abort, { once: true });
    }

    return controller.signal;
  }
}
