/**
 * Omnibar - Search & Command Input
 *
 * Unified input for:
 * - Progressive semantic search (INSTANT → EVOLVING → DEEP)
 * - Slash commands: /enhance, /connect, /atomize, etc. (single-note)
 * - Bulk workflows: /enrich vault, /classify folder: (multi-note)
 */

import { Notice, setIcon } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type CommandSuggestion,
  getCommandSuggestions,
  isSlashCommand,
  parseSlashCommand,
} from "../../../core/agentic/commandParser";
import type { ActionOrchestrator } from "../../../core/intelligence/actionOrchestrator";
import type { SearchPipeline } from "../../../core/search/pipeline";
import type { SearchResult } from "../../../types/search";
import type { SearchPreset } from "../../../types/settings";
import { useKernel } from "../context/KernelContext";
import { DeepSearchIndicator } from "./search/DeepSearchIndicator";
import { SearchDropdown, type SearchPhase, type SearchResultItemData } from "./search/SearchDropdown";

// ============================================================================
// Constants
// ============================================================================

const SEARCH_CONFIG = {
  debounceMs: 300,
  minQueryLength: 2,
  instantTimeoutMs: 500,
  evolvingTimeoutMs: 3000,
  deepTimeoutMs: 15000,
  maxDropdownResults: 10,
};

const PRESET_DISPLAY: Record<SearchPreset, { icon: string; label: string; tooltip: string }> = {
  quick: { icon: "zap", label: "Quick", tooltip: "Fast search, no AI reranking" },
  balanced: { icon: "scale", label: "Balanced", tooltip: "Vector search with AI reranking" },
  thorough: { icon: "brain", label: "Deep", tooltip: "Thorough search with extensive reranking" },
  custom: { icon: "settings", label: "Custom", tooltip: "Custom search settings" },
};

const PRESET_CYCLE: SearchPreset[] = ["quick", "balanced", "thorough"];

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
  placeholder = "Search or /command...",
}: OmnibarProps) {
  const kernel = useKernel();

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const modeIconRef = useRef<HTMLSpanElement>(null);
  const commandDropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const deepAbortRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [searchPreset, setSearchPreset] = useState<SearchPreset>(
    kernel.settings?.search?.preset || "balanced",
  );
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);

  // Search dropdown state
  const [searchResults, setSearchResults] = useState<SearchResultItemData[]>([]);
  const [searchPhase, setSearchPhase] = useState<SearchPhase>("idle");
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  const [aiUnavailable, setAiUnavailable] = useState(false);

  // Derived state
  const isCommandMode = isSlashCommand(query);
  const commandSuggestions = useMemo<CommandSuggestion[]>(() => {
    if (!isCommandMode) return [];
    return getCommandSuggestions(query);
  }, [query, isCommandMode]);

  const showCommandDropdown = isCommandMode && commandSuggestions.length > 0 && isFocused;
  const isSearching = searchPhase === "instant" || searchPhase === "evolving";

  // Set up icons
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, isCommandMode ? "terminal" : "search");
    }
  }, [isCommandMode]);

  useEffect(() => {
    if (modeIconRef.current) {
      const display = PRESET_DISPLAY[searchPreset];
      setIcon(modeIconRef.current, display.icon);
    }
  }, [searchPreset]);

  // Reset command selected index when suggestions change
  useEffect(() => {
    setCommandSelectedIndex(0);
  }, [commandSuggestions.length]);

  // Reset search selected index when results change
  useEffect(() => {
    setSearchSelectedIndex(0);
  }, [searchResults.length]);

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
        setIsFocused(false);
      }
    };

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

  // Cycle through search presets
  const cyclePreset = useCallback(() => {
    const currentIndex = PRESET_CYCLE.indexOf(searchPreset);
    const nextIndex = (currentIndex + 1) % PRESET_CYCLE.length;
    const nextPreset = PRESET_CYCLE[nextIndex];

    setSearchPreset(nextPreset);

    if (kernel.settings) {
      kernel.settings.search.preset = nextPreset;
    }
  }, [searchPreset, kernel]);

  // Convert SearchResult to SearchResultItemData
  const toSearchResultItem = useCallback(
    (result: SearchResult, tier: "instant" | "evolving" | "deep", isLoading: boolean): SearchResultItemData => ({
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

  // Execute progressive search
  const executeProgressiveSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (trimmed.length < SEARCH_CONFIG.minQueryLength) {
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
        return;
      }

      // Abort previous search
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      const searchPipeline = kernel.getService<SearchPipeline>("search");
      if (!searchPipeline) {
        console.warn("[Omnibar] SearchPipeline not available");
        return;
      }

      setSearchPhase("instant");
      setShowSearchDropdown(true);
      setAiUnavailable(false);
      onSearchStart?.(trimmed);

      try {
        // Phase 1: INSTANT (quick search - no reranking)
        const instantResults = await searchPipeline.search(trimmed, { enableReranking: false });
        if (signal.aborted) return;

        const instantItems = instantResults
          .slice(0, SEARCH_CONFIG.maxDropdownResults)
          .map((r) => toSearchResultItem(r, "instant", true));
        setSearchResults(instantItems);
        onResults?.(instantResults, trimmed);

        // Phase 2: EVOLVING (with AI reranking)
        setSearchPhase("evolving");

        try {
          const evolvedResults = await Promise.race([
            searchPipeline.search(trimmed, { enableReranking: true }),
            new Promise<SearchResult[]>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), SEARCH_CONFIG.evolvingTimeoutMs),
            ),
          ]);
          if (signal.aborted) return;

          const evolvedItems = evolvedResults
            .slice(0, SEARCH_CONFIG.maxDropdownResults)
            .map((r) => toSearchResultItem(r, "evolving", false));
          setSearchResults(evolvedItems);
          onResults?.(evolvedResults, trimmed);
        } catch (error) {
          // AI reranking failed or timed out - keep instant results
          if (!signal.aborted) {
            setAiUnavailable(true);
            setSearchResults((prev) => prev.map((r) => ({ ...r, isLoading: false })));
          }
        }

        setSearchPhase("idle");
      } catch (error) {
        if (!signal.aborted) {
          console.error("[Omnibar] Search failed:", error);
          setSearchResults([]);
          setSearchPhase("idle");
        }
      }
    },
    [kernel, onResults, onSearchStart, toSearchResultItem],
  );

  // Debounced search trigger
  const triggerDebouncedSearch = useCallback(
    (searchQuery: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!searchQuery.trim() || searchQuery.trim().length < SEARCH_CONFIG.minQueryLength) {
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
        return;
      }

      debounceRef.current = setTimeout(() => {
        executeProgressiveSearch(searchQuery);
      }, SEARCH_CONFIG.debounceMs);
    },
    [executeProgressiveSearch],
  );

  // Execute deep search
  const executeDeepSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const searchPipeline = kernel.getService<SearchPipeline>("search");
    if (!searchPipeline) {
      new Notice("Search system not available");
      return;
    }

    // Abort previous deep search
    deepAbortRef.current?.abort();
    deepAbortRef.current = new AbortController();

    setIsDeepSearching(true);
    setShowSearchDropdown(false);
    new Notice("Deep search started - results will appear in Insights");

    try {
      const results = await Promise.race([
        searchPipeline.search(trimmed, { enableReranking: true, topK: 50 }),
        new Promise<SearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), SEARCH_CONFIG.deepTimeoutMs),
        ),
      ]);

      const deepItems = results.map((r) => toSearchResultItem(r, "deep", false));
      new Notice(`Deep search found ${results.length} results`);
      onDeepSearchComplete?.(deepItems, trimmed);
    } catch (error) {
      if (error instanceof Error && error.message !== "timeout") {
        console.error("[Omnibar] Deep search failed:", error);
      }
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

  // Execute slash command
  const executeCommand = useCallback(
    async (commandStr: string) => {
      const parseResult = parseSlashCommand(commandStr, kernel.obsidian);

      if (!parseResult.success) {
        kernel.obsidian.notice(`Error: ${parseResult.error.message}`);
        return;
      }

      const { parsed } = parseResult;

      if (parsed.mode === "single") {
        const activeFile = kernel.obsidian.getActiveFile();
        if (!activeFile) {
          kernel.obsidian.notice("No active note. Open a note first.");
          return;
        }

        const actionOrchestrator = kernel.getService<ActionOrchestrator>("actionOrchestrator");
        if (!actionOrchestrator || !parsed.actionType) {
          kernel.obsidian.notice("Action system not available");
          return;
        }

        const content = await kernel.obsidian.readFile(activeFile);
        kernel.obsidian.notice(`Running /${parsed.command} on "${activeFile.basename}"...`);

        try {
          const context = {
            notePath: activeFile.path,
            noteTitle: activeFile.basename,
            noteContent: content,
          };

          for await (const event of actionOrchestrator.execute(parsed.actionType, context)) {
            if (event.type === "complete") {
              kernel.obsidian.notice(`/${parsed.command} completed`);
            } else if (event.type === "error") {
              kernel.obsidian.notice(`/${parsed.command} failed: ${event.error}`);
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          kernel.obsidian.notice(`Command failed: ${msg}`);
        }
      } else {
        const workflowRunner = kernel.getService("workflowRunner");
        if (!workflowRunner) {
          kernel.obsidian.notice("Workflow system not available");
          return;
        }

        kernel.obsidian.notice(
          `Starting /${parsed.command} on ${parsed.scope}${parsed.target ? `:${parsed.target}` : ""}...`,
        );

        try {
          await workflowRunner.startFromCommand(parsed);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          kernel.obsidian.notice(`Workflow failed: ${msg}`);
        }
      }

      setQuery("");
    },
    [kernel],
  );

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
      const target = e.target as HTMLInputElement;
      const value = target.value;
      setQuery(value);

      // Only trigger search if not in command mode
      if (!isSlashCommand(value)) {
        triggerDebouncedSearch(value);
      } else {
        // Clear search results when entering command mode
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
      }
    },
    [triggerDebouncedSearch],
  );

  // Handle key press
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Command mode navigation
      if (showCommandDropdown) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCommandSelectedIndex((i) => Math.min(i + 1, commandSuggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCommandSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && commandSuggestions[commandSelectedIndex]) {
          e.preventDefault();
          const cmd = commandSuggestions[commandSelectedIndex];
          if (cmd.command.endsWith(":")) {
            setQuery(cmd.command);
          } else {
            executeCommand(cmd.command);
          }
          return;
        }
        if (e.key === "Tab" && commandSuggestions[commandSelectedIndex]) {
          e.preventDefault();
          setQuery(commandSuggestions[commandSelectedIndex].command);
          return;
        }
      }

      // Search mode navigation
      if (showSearchDropdown && searchResults.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSearchSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSearchSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && searchResults[searchSelectedIndex]) {
          e.preventDefault();
          handleResultSelect(searchResults[searchSelectedIndex]);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          // Focus "Go Deeper" button (handled via SearchDropdown)
          return;
        }
      }

      // Shift+Enter for deep search
      if (e.key === "Enter" && e.shiftKey && !isCommandMode) {
        e.preventDefault();
        executeDeepSearch();
        return;
      }

      // Enter to execute search (if no results selected)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isCommandMode) {
          executeCommand(query);
        } else if (searchResults.length > 0 && searchResults[searchSelectedIndex]) {
          handleResultSelect(searchResults[searchSelectedIndex]);
        } else {
          executeProgressiveSearch(query);
        }
        return;
      }

      // Escape to clear and dismiss
      if (e.key === "Escape") {
        setQuery("");
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
        inputRef.current?.blur();
      }
    },
    [
      query,
      showCommandDropdown,
      showSearchDropdown,
      commandSelectedIndex,
      searchSelectedIndex,
      commandSuggestions,
      searchResults,
      isCommandMode,
      executeCommand,
      executeDeepSearch,
      executeProgressiveSearch,
      handleResultSelect,
    ],
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

  // Click command suggestion
  const handleSuggestionClick = useCallback(
    (suggestion: CommandSuggestion) => {
      if (suggestion.command.endsWith(":")) {
        setQuery(suggestion.command);
        inputRef.current?.focus();
      } else {
        executeCommand(suggestion.command);
      }
    },
    [executeCommand],
  );

  return (
    <div
      ref={containerRef}
      class={`nv2-omnibar${isFocused ? " nv2-omnibar--focused" : ""}${isCommandMode ? " nv2-omnibar--command" : ""}`}
    >
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
          {/* Search mode toggle (only show when not in command mode and not deep searching) */}
          {!isCommandMode && !isDeepSearching && (
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
          )}
          {isSearching ? (
            <div class="nv2-omnibar-spinner" />
          ) : !isDeepSearching ? (
            <span class="nv2-omnibar-kbd">{isCommandMode ? "Tab" : "Enter"}</span>
          ) : null}
        </div>
      </div>

      {/* Command suggestions dropdown */}
      {showCommandDropdown && (
        <div class="nv2-omnibar-dropdown" ref={commandDropdownRef} role="listbox">
          {commandSuggestions.map((suggestion, idx) => (
            <CommandItem
              key={suggestion.command}
              suggestion={suggestion}
              isSelected={idx === commandSelectedIndex}
              onClick={() => handleSuggestionClick(suggestion)}
            />
          ))}
        </div>
      )}

      {/* Search results dropdown */}
      {showSearchDropdown && !isCommandMode && (
        <SearchDropdown
          isOpen={showSearchDropdown}
          results={searchResults}
          phase={searchPhase}
          selectedIndex={searchSelectedIndex}
          onSelect={handleResultSelect}
          onDeepSearch={executeDeepSearch}
          aiUnavailable={aiUnavailable}
          isDeepSearching={isDeepSearching}
        />
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

interface CommandItemProps {
  suggestion: CommandSuggestion;
  isSelected: boolean;
  onClick: () => void;
}

function CommandItem({ suggestion, isSelected, onClick }: CommandItemProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, suggestion.icon);
    }
  }, [suggestion.icon]);

  return (
    <div
      class={`nv2-command-item${isSelected ? " nv2-command-item--selected" : ""}${suggestion.mode === "bulk" ? " nv2-command-item--bulk" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      role="option"
      aria-selected={isSelected}
    >
      <span class="nv2-command-icon" ref={iconRef} />
      <div class="nv2-command-content">
        <span class="nv2-command-label">{suggestion.label}</span>
        <span class="nv2-command-desc">{suggestion.description}</span>
      </div>
      <code class="nv2-command-shortcut">{suggestion.command}</code>
    </div>
  );
}
