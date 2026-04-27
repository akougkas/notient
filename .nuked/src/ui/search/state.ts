import { signal } from "@preact/signals";
import type {
  SearchEvent,
  SearchFilters,
  SearchHit,
  SearchMode,
  SearchQuery,
  SearchResult,
  SynthesisCard,
} from "../../core/search/types";

/**
 * SearchView state. Pure signals + a single injected runner. The runner is set
 * by main.ts (Task 16) once the SearchPipeline service is available; tests can
 * stub it via {@link setSearchRunner} without booting any pipeline.
 */
export const searchQuery = signal<string>("");
export const searchMode = signal<SearchMode>("quick");
export const searchFilters = signal<SearchFilters>({});
export const searchRunning = signal<boolean>(false);
export const searchHits = signal<SearchHit[]>([]);
export const searchResult = signal<SearchResult | null>(null);
export const searchSynthesis = signal<SynthesisCard | null>(null);
export const searchPreviewPath = signal<string | null>(null);
export const searchHistory = signal<string[]>([]);
export const searchError = signal<string | null>(null);

/**
 * Pure adapter signature: given a query and an abort signal, yield search
 * events. Mirrors {@link SearchPipeline.run} but lets us inject a fake in tests.
 */
export type SearchRunner = (query: SearchQuery, signal: AbortSignal) => AsyncIterable<SearchEvent>;

let activeRunner: SearchRunner | null = null;
let activeAbort: AbortController | null = null;

export function setSearchRunner(runner: SearchRunner | null): void {
  activeRunner = runner;
}

export function getSearchRunner(): SearchRunner | null {
  return activeRunner;
}

export interface SearchAppActions {
  runSearch: () => void;
  cancelSearch: () => void;
  openHit: (notePath: string) => void;
  pinPreview: (notePath: string | null) => void;
  viewAsCanvas: () => void;
  saveQuery: () => void;
  newChatFromResults: () => void;
  openLink: (linkText: string) => void;
}

export const searchActions = signal<SearchAppActions | null>(null);

/**
 * Resets every search-related signal to its empty state. Useful between tests
 * and when the user clears the QueryBar.
 */
export function resetSearchState(): void {
  searchQuery.value = "";
  searchMode.value = "quick";
  searchFilters.value = {};
  searchRunning.value = false;
  searchHits.value = [];
  searchResult.value = null;
  searchSynthesis.value = null;
  searchPreviewPath.value = null;
  searchError.value = null;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/**
 * Drive a single search through the injected runner, mutating signals as
 * events arrive. Returns once the underlying iterable completes. Repeated
 * calls cancel any in-flight run.
 */
export async function dispatchSearch(): Promise<void> {
  const runner = activeRunner;
  if (!runner) {
    searchError.value = "Search runner not configured.";
    return;
  }
  const query = searchQuery.value.trim();
  if (query.length === 0) {
    searchHits.value = [];
    searchSynthesis.value = null;
    searchResult.value = null;
    searchError.value = null;
    return;
  }
  if (activeAbort) {
    activeAbort.abort();
  }
  const controller = new AbortController();
  activeAbort = controller;
  searchRunning.value = true;
  searchError.value = null;
  searchHits.value = [];
  searchSynthesis.value = null;
  searchResult.value = null;
  try {
    const iterable = runner(
      {
        query,
        mode: searchMode.value,
        filters: cloneFilters(searchFilters.value),
      },
      controller.signal,
    );
    for await (const event of iterable) {
      applySearchEvent(event);
      if (event.type === "search:done" || event.type === "search:error") {
        break;
      }
    }
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (activeAbort === controller) {
      activeAbort = null;
    }
    searchRunning.value = false;
  }
}

export function cancelDispatch(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  searchRunning.value = false;
}

function applySearchEvent(event: SearchEvent): void {
  switch (event.type) {
    case "search:hits":
      searchHits.value = event.hits;
      break;
    case "search:synthesis-done":
      searchSynthesis.value = event.card;
      break;
    case "search:done":
      searchResult.value = event.result;
      searchHits.value = event.result.hits;
      if (event.result.synthesis) {
        searchSynthesis.value = event.result.synthesis;
      }
      break;
    case "search:error":
      searchError.value = event.message;
      break;
    default:
      break;
  }
}

function cloneFilters(filters: SearchFilters): SearchFilters {
  return {
    maturity: filters.maturity ? [...filters.maturity] : undefined,
    agents: filters.agents ? [...filters.agents] : undefined,
    minConfidence: filters.minConfidence,
    folders: filters.folders ? [...filters.folders] : undefined,
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    connectivityTiers: filters.connectivityTiers ? [...filters.connectivityTiers] : undefined,
    hasPendingProposals: filters.hasPendingProposals,
  };
}

export function pushHistory(query: string): void {
  const trimmed = query.trim();
  if (trimmed.length === 0) return;
  const next = [trimmed, ...searchHistory.value.filter((entry) => entry !== trimmed)];
  searchHistory.value = next.slice(0, 50);
}
