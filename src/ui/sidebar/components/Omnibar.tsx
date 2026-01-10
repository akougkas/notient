/**
 * Omnibar - Search & Command Input
 *
 * Unified input for:
 * - Semantic search (default)
 * - Slash commands: /enhance, /connect, /atomize, etc. (single-note)
 * - Bulk workflows: /enrich vault, /classify folder: (multi-note)
 */

import { setIcon } from "obsidian";
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

// ============================================================================
// Constants
// ============================================================================

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
  /** Callback when search results are returned */
  onResults?: (results: SearchResult[], query: string) => void;
  /** Callback when search starts */
  onSearchStart?: (query: string) => void;
  /** Placeholder text */
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

export function Omnibar({
  onResults,
  onSearchStart,
  placeholder = "Search or /command...",
}: OmnibarProps) {
  const kernel = useKernel();

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const modeIconRef = useRef<HTMLSpanElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // State
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchPreset, setSearchPreset] = useState<SearchPreset>(
    kernel.settings?.search?.preset || "balanced",
  );
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Derived state
  const isCommandMode = isSlashCommand(query);
  const commandSuggestions = useMemo<CommandSuggestion[]>(() => {
    if (!isCommandMode) return [];
    return getCommandSuggestions(query);
  }, [query, isCommandMode]);

  const showDropdown = isCommandMode && commandSuggestions.length > 0 && isFocused;

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

  // Reset selected index when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandSuggestions.length]);

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

  // Execute search
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
        // Single-note command - run on current note
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
          // Execute via ActionOrchestrator
          const context = {
            notePath: activeFile.path,
            noteTitle: activeFile.basename,
            noteContent: content,
          };

          // Stream events from the pipeline
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
        // Bulk command - use WorkflowRunner
        const workflowRunner = kernel.getService("workflowRunner");
        if (!workflowRunner) {
          kernel.obsidian.notice("Workflow system not available");
          return;
        }

        kernel.obsidian.notice(
          `Starting /${parsed.command} on ${parsed.scope}${parsed.target ? `:${parsed.target}` : ""}...`,
        );

        try {
          // Pass the full parsed command - WorkflowRunner expects the bulk format
          await workflowRunner.startFromCommand(parsed);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          kernel.obsidian.notice(`Workflow failed: ${msg}`);
        }
      }

      // Clear input after execution
      setQuery("");
    },
    [kernel],
  );

  // Handle input change
  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    setQuery(target.value);
  }, []);

  // Handle key press
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Command mode navigation
      if (showDropdown) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, commandSuggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && commandSuggestions[selectedIndex]) {
          e.preventDefault();
          const cmd = commandSuggestions[selectedIndex];
          // For commands that need additional input (folder:), set it in input
          if (cmd.command.endsWith(":")) {
            setQuery(cmd.command);
          } else {
            executeCommand(cmd.command);
          }
          return;
        }
        if (e.key === "Tab" && commandSuggestions[selectedIndex]) {
          e.preventDefault();
          setQuery(commandSuggestions[selectedIndex].command);
          return;
        }
      }

      // Enter to execute
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isCommandMode) {
          executeCommand(query);
        } else {
          executeSearch(query);
        }
        return;
      }

      // Escape to clear and blur
      if (e.key === "Escape") {
        setQuery("");
        inputRef.current?.blur();
      }
    },
    [
      query,
      showDropdown,
      selectedIndex,
      commandSuggestions,
      isCommandMode,
      executeCommand,
      executeSearch,
    ],
  );

  // Handle focus/blur
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => {
    // Delay to allow click on dropdown items
    setTimeout(() => setIsFocused(false), 150);
  }, []);

  // Click suggestion
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
      class={`nv2-omnibar${isFocused ? " nv2-omnibar--focused" : ""}${isCommandMode ? " nv2-omnibar--command" : ""}`}
    >
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
          autoComplete="off"
          spellcheck={false}
        />
        <div class="nv2-omnibar-right">
          {/* Search mode toggle (only show when not in command mode) */}
          {!isCommandMode && (
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
          ) : (
            <span class="nv2-omnibar-kbd">{isCommandMode ? "Tab" : "Enter"}</span>
          )}
        </div>
      </div>

      {/* Command suggestions dropdown */}
      {showDropdown && (
        <div class="nv2-omnibar-dropdown" ref={dropdownRef} role="listbox">
          {commandSuggestions.map((suggestion, idx) => (
            <CommandItem
              key={suggestion.command}
              suggestion={suggestion}
              isSelected={idx === selectedIndex}
              onClick={() => handleSuggestionClick(suggestion)}
            />
          ))}
        </div>
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
      onMouseDown={(e) => e.preventDefault()} // Prevent blur
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
