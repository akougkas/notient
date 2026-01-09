/**
 * Omnibar - Search input component for the sidebar
 *
 * A simple search input that triggers semantic search via the SearchPipeline.
 */

import { signal } from "@preact/signals";
import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SearchPipeline } from "../../../core/search/pipeline";
import type { SearchResult } from "../../../types/search";
import { useEventBus, useKernel } from "../context/KernelContext";

interface OmnibarProps {
  /** Callback when search results are returned */
  onResults?: (results: SearchResult[], query: string) => void;
  /** Callback when search starts */
  onSearchStart?: (query: string) => void;
  /** Placeholder text */
  placeholder?: string;
}

export function Omnibar({
  onResults,
  onSearchStart,
  placeholder = "Search notes...",
}: OmnibarProps) {
  const kernel = useKernel();
  const inputRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // Set up the search icon
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "search");
    }
  }, []);

  // Handle search execution
  const executeSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed) return;

      const searchPipeline = kernel.getService<SearchPipeline>("search");
      if (!searchPipeline) {
        console.warn("[Omnibar] SearchPipeline not available");
        return;
      }

      setIsSearching(true);
      onSearchStart?.(trimmed);

      try {
        const results = await searchPipeline.search(trimmed);
        onResults?.(results, trimmed);
      } catch (error) {
        console.error("[Omnibar] Search failed:", error);
        onResults?.([], trimmed);
      } finally {
        setIsSearching(false);
      }
    },
    [kernel, onResults, onSearchStart],
  );

  // Handle input change
  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    setQuery(target.value);
  }, []);

  // Handle key press (Enter to search)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        executeSearch(query);
      }
      // Escape to clear and blur
      if (e.key === "Escape") {
        setQuery("");
        inputRef.current?.blur();
      }
    },
    [query, executeSearch],
  );

  // Handle focus/blur for styling
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);

  return (
    <div class={`nv2-omnibar${isFocused ? " nv2-omnibar--focused" : ""}`}>
      <div class="nv2-omnibar-wrapper">
        <div class="nv2-omnibar-icon" ref={iconRef} />
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
        />
        <div class="nv2-omnibar-right">
          {isSearching ? (
            <div class="nv2-omnibar-spinner" />
          ) : (
            <span class="nv2-omnibar-kbd">Enter</span>
          )}
        </div>
      </div>
    </div>
  );
}
