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
import type { SearchPreset } from "../../../types/settings";
import { useEventBus, useKernel } from "../context/KernelContext";

const PRESET_DISPLAY: Record<SearchPreset, { icon: string; label: string; tooltip: string }> = {
  quick: { icon: "zap", label: "Quick", tooltip: "Fast search, no AI reranking" },
  balanced: {
    icon: "scale",
    label: "Balanced",
    tooltip: "Recommended - vector search with AI reranking",
  },
  thorough: { icon: "brain", label: "Deep", tooltip: "Thorough search with extensive reranking" },
  custom: { icon: "settings", label: "Custom", tooltip: "Custom search settings" },
};

const PRESET_CYCLE: SearchPreset[] = ["quick", "balanced", "thorough"];

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
  const modeIconRef = useRef<HTMLSpanElement>(null);
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchPreset, setSearchPreset] = useState<SearchPreset>(
    kernel.settings?.search?.preset || "balanced",
  );

  // Set up the search icon
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "search");
    }
  }, []);

  // Set up the mode icon
  useEffect(() => {
    if (modeIconRef.current) {
      const display = PRESET_DISPLAY[searchPreset];
      setIcon(modeIconRef.current, display.icon);
    }
  }, [searchPreset]);

  // Cycle through search presets
  const cyclePreset = useCallback(async () => {
    const currentIndex = PRESET_CYCLE.indexOf(searchPreset);
    const nextIndex = (currentIndex + 1) % PRESET_CYCLE.length;
    const nextPreset = PRESET_CYCLE[nextIndex];

    setSearchPreset(nextPreset);

    // Update kernel settings
    if (kernel.settings) {
      kernel.settings.search.preset = nextPreset;
      console.log(`[Omnibar] Search preset changed to: ${nextPreset}`);
    }
  }, [searchPreset, kernel]);

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
          {/* Search mode toggle */}
          <button
            type="button"
            class="nv2-mode-pill"
            onClick={cyclePreset}
            title={PRESET_DISPLAY[searchPreset].tooltip}
            aria-label={`Search mode: ${PRESET_DISPLAY[searchPreset].label}. Click to change.`}
          >
            <span class="nv2-mode-pill-icon" ref={modeIconRef} aria-hidden="true" />
            <span class="nv2-mode-pill-label">{PRESET_DISPLAY[searchPreset].label}</span>
          </button>
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
