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
import type { ProgressiveSearchOrchestrator } from "../../../core/search/progressiveSearch";
import type { SearchResult } from "../../../types/search";
import type { SearchPreset } from "../../../types/settings";
import { useKernel } from "../context/KernelContext";
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
  const deepButtonRef = useRef<HTMLButtonElement>(null);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset index on suggestions length change
  useEffect(() => {
    setCommandSelectedIndex(0);
  }, [commandSuggestions.length]);

  // Reset search selected index when results change
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset index on results length change
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
    (event: { status: string; results?: SearchResult[] }, query: string) => {
      if (event.status === "started") {
        setSearchPhase("instant");
        return;
      }
      if (event.status === "complete" && event.results) {
        const items = event.results
          .slice(0, SEARCH_CONFIG.maxDropdownResults)
          .map((r) => toSearchResultItem(r, "instant", true));
        setSearchResults(items);
        onResults?.(event.results, query);
      }
    },
    [onResults, toSearchResultItem],
  );

  // Handle evolving phase events
  const handleEvolvingPhase = useCallback(
    (event: { status: string; results?: SearchResult[] }, query: string) => {
      if (event.status === "started") {
        setSearchPhase("evolving");
        return;
      }
      if (event.status === "complete" && event.results) {
        const items = event.results
          .slice(0, SEARCH_CONFIG.maxDropdownResults)
          .map((r) => toSearchResultItem(r, "evolving", false));
        setSearchResults(items);
        onResults?.(event.results, query);
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
    (event: { phase: string; status: string; results?: SearchResult[] }, query: string) => {
      if (event.phase === "instant") {
        handleInstantPhase(event, query);
      } else if (event.phase === "evolving") {
        handleEvolvingPhase(event, query);
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
      } catch (error) {
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

  // Execute single-note command
  const executeSingleCommand = useCallback(
    async (parsed: { command: string; actionType?: string }) => {
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

      const context = {
        notePath: activeFile.path,
        noteTitle: activeFile.basename,
        noteContent: content,
      };

      // biome-ignore lint/suspicious/noExplicitAny: actionType validated above
      for await (const event of actionOrchestrator.execute(parsed.actionType as any, context)) {
        if (event.type === "complete") kernel.obsidian.notice(`/${parsed.command} completed`);
        else if (event.type === "error")
          kernel.obsidian.notice(`/${parsed.command} failed: ${event.error}`);
      }
    },
    [kernel],
  );

  // Execute workflow command
  const executeWorkflowCommand = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: ParsedCommand passed from parser
    async (parsed: any) => {
      const workflowRunner = kernel.getService("workflowRunner");
      if (!workflowRunner) {
        kernel.obsidian.notice("Workflow system not available");
        return;
      }

      kernel.obsidian.notice(
        `Starting /${parsed.command} on ${parsed.scope}${parsed.target ? `:${parsed.target}` : ""}...`,
      );
      await workflowRunner.startFromCommand(parsed);
    },
    [kernel],
  );

  // Execute slash command
  const executeCommand = useCallback(
    async (commandStr: string) => {
      const parseResult = parseSlashCommand(commandStr, kernel.obsidian);
      if (!parseResult.success) {
        kernel.obsidian.notice(`Error: ${parseResult.error.message}`);
        return;
      }

      const { parsed } = parseResult;

      try {
        if (parsed.mode === "single") await executeSingleCommand(parsed);
        else await executeWorkflowCommand(parsed);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        kernel.obsidian.notice(`Command failed: ${msg}`);
      }

      setQuery("");
    },
    [kernel, executeSingleCommand, executeWorkflowCommand],
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
      const value = (e.target as HTMLInputElement).value;
      setQuery(value);

      if (isSlashCommand(value)) {
        // Abort any pending search and clear results
        abortRef.current?.abort();
        setSearchResults([]);
        setShowSearchDropdown(false);
        setSearchPhase("idle");
      } else {
        triggerDebouncedSearch(value);
      }
    },
    [triggerDebouncedSearch],
  );

  // Handle command dropdown key navigation - returns true if handled
  const handleCommandNavKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!showCommandDropdown) return false;
      const cmd = commandSuggestions[commandSelectedIndex];
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setCommandSelectedIndex((i) => Math.min(i + 1, commandSuggestions.length - 1));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setCommandSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Enter":
          if (cmd) {
            e.preventDefault();
            cmd.command.endsWith(":") ? setQuery(cmd.command) : executeCommand(cmd.command);
            return true;
          }
          return false;
        case "Tab":
          if (cmd) {
            e.preventDefault();
            setQuery(cmd.command);
            return true;
          }
          return false;
        default:
          return false;
      }
    },
    [showCommandDropdown, commandSuggestions, commandSelectedIndex, executeCommand],
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
      // Shift+Enter triggers deep search (non-command mode only)
      if (e.shiftKey && !isCommandMode) {
        executeDeepSearch();
        return;
      }
      // Command mode: execute the command
      if (isCommandMode) {
        executeCommand(query);
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
      isCommandMode,
      executeCommand,
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
      if (handleCommandNavKey(e)) return;
      if (handleSearchNavKey(e)) return;

      if (e.key === "Enter") {
        handleEnterKey(e);
        return;
      }

      if (e.key === "Escape") {
        handleEscapeKey();
      }
    },
    [handleCommandNavKey, handleSearchNavKey, handleEnterKey, handleEscapeKey],
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

  const containerClass = [
    "nv2-omnibar",
    isFocused && "nv2-omnibar--focused",
    isCommandMode && "nv2-omnibar--command",
  ]
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
          {isSearching && <div class="nv2-omnibar-spinner" />}
          {!isSearching && !isDeepSearching && (
            <span class="nv2-omnibar-kbd">{isCommandMode ? "Tab" : "Enter"}</span>
          )}
        </div>
      </div>

      {/* Command suggestions dropdown */}
      {showCommandDropdown && (
        // biome-ignore lint/a11y/useFocusableInteractive: listbox is focused via input
        // biome-ignore lint/a11y/useSemanticElements: no native listbox element exists
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
          deepButtonRef={deepButtonRef}
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  const itemClass = [
    "nv2-command-item",
    isSelected && "nv2-command-item--selected",
    suggestion.mode === "bulk" && "nv2-command-item--bulk",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      class={itemClass}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.preventDefault()}
      // biome-ignore lint/a11y/useSemanticElements: option requires select parent which doesn't fit this UX
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
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
