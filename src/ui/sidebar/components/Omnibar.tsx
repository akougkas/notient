/**
 * Omnibar - Semantic Search Input
 *
 * Progressive semantic search (INSTANT -> EVOLVING -> DEEP).
 * Slash commands have been moved to Chat UI.
 */

import { Notice, setIcon } from "obsidian";
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ProgressiveSearchOrchestrator } from "../../../core/search/progressiveSearch";
import type { SearchResult } from "../../../types/search";
import { useKernel } from "../context/KernelContext";
import { searchQuery } from "../state";
import { DeepSearchIndicator } from "./search/DeepSearchIndicator";
import {
  SearchDropdown,
  type SearchPhase,
  type SearchResultItemData,
} from "./search/SearchDropdown";

// ============================================================================
// Constants
// ============================================================================

const SEARCH_CONFIG = {
  debounceMs: 300,
  minQueryLength: 2,
  maxDropdownResults: 10,
};

// ============================================================================
// Types
// ============================================================================

interface OmnibarProps {
  /** Callback when search results are returned (for legacy/external use) */
  onResults?: (results: SearchResult[], query: string) => void;
  /** Callback when search starts */
  onSearchStart?: (query: string) => void;
  /** Callback when a result is selected */
  onResultSelect?: (path: string) => void;
  /** Callback when deep search completes */
  onDeepSearchComplete?: (results: SearchResultItemData[], query: string) => void;
  /** Placeholder text */
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

export function Omnibar({
  onResults,
  onSearchStart,
  onResultSelect,
  onDeepSearchComplete,
  placeholder = "Search notes...",
}: OmnibarProps): JSX.Element {
  const kernel = useKernel();

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const deepAbortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const deepButtonRef = useRef<HTMLButtonElement>(null);

  // State
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);

  // Search dropdown state
  const [searchResults, setSearchResults] = useState<SearchResultItemData[]>([]);
  const [searchPhase, setSearchPhase] = useState<SearchPhase>("idle");
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  const [aiUnavailable, setAiUnavailable] = useState(false);

  const isSearching = searchPhase === "instant" || searchPhase === "evolving";

  // Set up search icon
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "search");
    }
  }, []);

  // Reset search selected index when results change
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset index on results length change
  useEffect(() => {
    setSearchSelectedIndex(0);
  }, [searchResults.length]);

  // Click outside handler
  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
        setIsFocused(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
      deepAbortRef.current?.abort();
    };
  }, []);

  // Convert SearchResult to SearchResultItemData
  const toSearchResultItem = useCallback(
    (
      result: SearchResult,
      tier: "instant" | "evolving" | "deep",
      isLoading: boolean,
    ): SearchResultItemData => ({
      noteId: result.noteId || result.path,
      path: result.path,
      title: result.title,
      snippet: result.chunks?.[0]?.text?.slice(0, 100),
      score: result.bestScore,
      tier,
      isLoading,
      lastModified: result.mtimeMs || Date.now(),
    }),
    [],
  );

  // Handle instant phase events
  const handleInstantPhase = useCallback(
    (event: { status: string; results?: SearchResult[] }, searchQuery: string) => {
      if (event.status === "started") {
        setSearchPhase("instant");
        return;
      }
      if (event.status === "complete" && event.results) {
        const items = event.results
          .slice(0, SEARCH_CONFIG.maxDropdownResults)
          .map((r) => toSearchResultItem(r, "instant", true));
        setSearchResults(items);
        onResults?.(event.results, searchQuery);
      }
    },
    [onResults, toSearchResultItem],
  );

  // Handle evolving phase events
  const handleEvolvingPhase = useCallback(
    (event: { status: string; results?: SearchResult[] }, searchQuery: string) => {
      if (event.status === "started") {
        setSearchPhase("evolving");
        return;
      }
      if (event.status === "complete" && event.results) {
        const items = event.results
          .slice(0, SEARCH_CONFIG.maxDropdownResults)
          .map((r) => toSearchResultItem(r, "evolving", false));
        setSearchResults(items);
        onResults?.(event.results, searchQuery);
        return;
      }
      if (event.status === "failed") {
        setAiUnavailable(true);
        setSearchResults((prev) => prev.map((r) => ({ ...r, isLoading: false })));
      }
    },
    [onResults, toSearchResultItem],
  );

  // Process search event from progressive search orchestrator
  const processSearchEvent = useCallback(
    (event: { phase: string; status: string; results?: SearchResult[] }, searchQuery: string) => {
      if (event.phase === "instant") {
        handleInstantPhase(event, searchQuery);
      } else if (event.phase === "evolving") {
        handleEvolvingPhase(event, searchQuery);
      }
    },
    [handleInstantPhase, handleEvolvingPhase],
  );

  // Execute progressive search using ProgressiveSearchOrchestrator
  const executeProgressiveSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (trimmed.length < SEARCH_CONFIG.minQueryLength) {
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
        return;
      }

      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      const progressiveSearch =
        kernel.getService<ProgressiveSearchOrchestrator>("progressiveSearch");
      if (!progressiveSearch) return;

      setShowSearchDropdown(true);
      setAiUnavailable(false);
      onSearchStart?.(trimmed);

      try {
        for await (const event of progressiveSearch.search(trimmed, signal)) {
          if (signal.aborted) return;
          processSearchEvent(event, trimmed);
        }
        setSearchPhase("idle");
      } catch {
        if (!signal.aborted) {
          setSearchResults([]);
          setSearchPhase("idle");
        }
      }
    },
    [kernel, onSearchStart, processSearchEvent],
  );

  // Debounced search trigger
  const triggerDebouncedSearch = useCallback(
    (searchQuery: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        executeProgressiveSearch(searchQuery);
      }, SEARCH_CONFIG.debounceMs);
    },
    [executeProgressiveSearch],
  );

  // Sync with global search query signal
  useEffect(() => {
    // biome-ignore lint/correctness/useExhaustiveDependencies: manual subscription
    return searchQuery.subscribe((newValue) => {
      // Only update if different to avoid cursor jumps / loops
      // and only if we aren't currently typing (checked via focus?)
      // Actually, for "find related", we want to overwrite.
      if (newValue !== query) {
        setQuery(newValue);
        // If the query came from outside (e.g. context menu), trigger search immediately
        if (newValue && !isFocused) {
          triggerDebouncedSearch(newValue);
        }
      }
    });
  }, [triggerDebouncedSearch, query, isFocused]);

  // Execute deep search using ProgressiveSearchOrchestrator
  const executeDeepSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const progressiveSearch = kernel.getService<ProgressiveSearchOrchestrator>("progressiveSearch");
    if (!progressiveSearch) {
      new Notice("Search system not available");
      return;
    }

    // Abort previous deep search
    deepAbortRef.current?.abort();
    deepAbortRef.current = new AbortController();
    const signal = deepAbortRef.current.signal;

    setIsDeepSearching(true);
    setShowSearchDropdown(false);
    new Notice("Deep search started - results will appear in Insights");

    try {
      const result = await progressiveSearch.deepSearch(trimmed, signal);

      if (result.cancelled) {
        new Notice("Deep search cancelled");
      } else {
        const deepItems = result.results.map((r) => toSearchResultItem(r, "deep", false));
        new Notice(`Deep search found ${result.results.length} results`);
        onDeepSearchComplete?.(deepItems, trimmed);
      }
    } catch (error) {
      console.error("[Omnibar] Deep search failed:", error);
      new Notice("Deep search completed with partial results");
    } finally {
      setIsDeepSearching(false);
    }
  }, [query, kernel, toSearchResultItem, onDeepSearchComplete]);

  // Cancel deep search
  const cancelDeepSearch = useCallback(() => {
    deepAbortRef.current?.abort();
    setIsDeepSearching(false);
    new Notice("Deep search cancelled");
  }, []);

  // Handle result selection
  const handleResultSelect = useCallback(
    (result: SearchResultItemData) => {
      onResultSelect?.(result.path);
      kernel.obsidian.openFile(result.path);
      setShowSearchDropdown(false);
      setQuery("");
    },
    [kernel, onResultSelect],
  );

  // Handle input change
  const handleInput = useCallback(
    (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      setQuery(value);
      triggerDebouncedSearch(value);
    },
    [triggerDebouncedSearch],
  );

  // Handle search dropdown key navigation - returns true if handled
  const handleSearchNavKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!showSearchDropdown || searchResults.length === 0) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSearchSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSearchSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Enter":
          if (!e.shiftKey && searchResults[searchSelectedIndex]) {
            e.preventDefault();
            handleResultSelect(searchResults[searchSelectedIndex]);
            return true;
          }
          return false;
        case "Tab":
          e.preventDefault();
          deepButtonRef.current?.focus();
          return true;
        default:
          return false;
      }
    },
    [showSearchDropdown, searchResults, searchSelectedIndex, handleResultSelect],
  );

  // Handle Enter key press
  const handleEnterKey = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      // Shift+Enter triggers deep search
      if (e.shiftKey) {
        executeDeepSearch();
        return;
      }
      // Search mode with selected result: open the result
      if (searchResults[searchSelectedIndex]) {
        handleResultSelect(searchResults[searchSelectedIndex]);
        return;
      }
      // Fallback: trigger progressive search
      executeProgressiveSearch(query);
    },
    [
      query,
      searchSelectedIndex,
      searchResults,
      executeDeepSearch,
      executeProgressiveSearch,
      handleResultSelect,
    ],
  );

  // Handle Escape key press
  const handleEscapeKey = useCallback(() => {
    setQuery("");
    setSearchResults([]);
    setShowSearchDropdown(false);
    setSearchPhase("idle");
    inputRef.current?.blur();
  }, []);

  // Handle key press
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (handleSearchNavKey(e)) return;

      if (e.key === "Enter") {
        handleEnterKey(e);
        return;
      }

      if (e.key === "Escape") {
        handleEscapeKey();
      }
    },
    [handleSearchNavKey, handleEnterKey, handleEscapeKey],
  );

  // Handle focus/blur
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => {
    // Delay to allow click on dropdown items
    setTimeout(() => {
      // Don't blur if search dropdown is open (handled by click outside)
      if (!showSearchDropdown) {
        setIsFocused(false);
      }
    }, 150);
  }, [showSearchDropdown]);

  const containerClass = ["nv2-omnibar", isFocused && "nv2-omnibar--focused"]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={containerRef} class={containerClass}>
      <div class="nv2-omnibar-wrapper">
        <div class="nv2-omnibar-icon" ref={iconRef} />
        {isDeepSearching ? (
          <DeepSearchIndicator onCancel={cancelDeepSearch} />
        ) : (
          <input
            ref={inputRef}
            type="text"
            class="nv2-omnibar-input"
            placeholder={placeholder}
            value={query}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            disabled={isSearching}
            autoComplete="off"
            spellcheck={false}
          />
        )}
        <div class="nv2-omnibar-right">
          {isSearching && <div class="nv2-omnibar-spinner" />}
          {!isSearching && !isDeepSearching && <span class="nv2-omnibar-kbd">Enter</span>}
        </div>
      </div>

      {/* Search results dropdown */}
      {showSearchDropdown && (
        <SearchDropdown
          isOpen={showSearchDropdown}
          results={searchResults}
          phase={searchPhase}
          selectedIndex={searchSelectedIndex}
          onSelect={handleResultSelect}
          onDeepSearch={executeDeepSearch}
          aiUnavailable={aiUnavailable}
          isDeepSearching={isDeepSearching}
          deepButtonRef={deepButtonRef}
        />
      )}
    </div>
  );
}
