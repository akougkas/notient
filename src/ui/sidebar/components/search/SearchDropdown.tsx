/**
 * SearchDropdown - Main dropdown container for progressive search results
 *
 * Shows results that shimmer during AI evaluation, then animate reorder.
 */

import { useLayoutEffect, useRef } from "preact/hooks";
import { SearchFooter } from "./SearchFooter";
import { SearchResultItem, type SearchResultItemData } from "./SearchResultItem";

export type SearchPhase = "idle" | "instant" | "evolving" | "deep";

interface SearchDropdownProps {
  isOpen: boolean;
  results: SearchResultItemData[];
  phase: SearchPhase;
  selectedIndex: number;
  onSelect: (result: SearchResultItemData) => void;
  onDeepSearch: () => void;
  aiUnavailable?: boolean;
  isDeepSearching?: boolean;
}

export function SearchDropdown({
  isOpen,
  results,
  phase,
  selectedIndex,
  onSelect,
  onDeepSearch,
  aiUnavailable,
  isDeepSearching = false,
}: SearchDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevResultsRef = useRef<SearchResultItemData[]>([]);

  // FLIP animation for reordering during evolving phase
  useLayoutEffect(() => {
    if (phase !== "evolving" || !listRef.current) return;

    const prevResults = prevResultsRef.current;
    if (prevResults.length === 0) {
      prevResultsRef.current = results;
      return;
    }

    // Record First positions
    const firstPositions = new Map<string, DOMRect>();
    for (const result of prevResults) {
      const el = itemRefs.current.get(result.noteId);
      if (el) {
        firstPositions.set(result.noteId, el.getBoundingClientRect());
      }
    }

    // After DOM update, calculate Last and apply Invert
    requestAnimationFrame(() => {
      for (const result of results) {
        const el = itemRefs.current.get(result.noteId);
        const first = firstPositions.get(result.noteId);
        if (!el || !first) continue;

        const last = el.getBoundingClientRect();
        const deltaY = first.top - last.top;

        if (Math.abs(deltaY) > 1) {
          // Invert: Apply transform to start from old position
          el.style.transform = `translateY(${deltaY}px)`;
          el.style.transition = "none";

          // Play: Animate to new position
          requestAnimationFrame(() => {
            el.style.transition = "transform 300ms ease-out";
            el.style.transform = "";
          });
        }
      }
    });

    prevResultsRef.current = results;
  }, [results, phase]);

  // Clear prev results when phase changes to non-evolving
  useLayoutEffect(() => {
    if (phase !== "evolving") {
      prevResultsRef.current = [];
    }
  }, [phase]);

  if (!isOpen) return null;

  const hasResults = results.length > 0;
  const showWarning = aiUnavailable && phase === "evolving";

  return (
    <div
      class="nv2-search-dropdown"
      role="listbox"
      aria-label="Search results"
      aria-activedescendant={hasResults ? `search-result-${results[selectedIndex]?.noteId}` : undefined}
    >
      {showWarning && (
        <div class="nv2-search-warning" role="alert">
          <span class="nv2-search-warning-icon" aria-hidden="true">
            ⚠️
          </span>
          <span>AI ranking unavailable - showing basic results</span>
        </div>
      )}

      {!hasResults ? (
        <div class="nv2-search-empty">
          <span class="nv2-search-empty-text">No notes match your search</span>
          <span class="nv2-search-empty-hint">Try a different query or Go Deeper</span>
        </div>
      ) : (
        <div class="nv2-search-results" ref={listRef}>
          {results.map((result, idx) => (
            <div
              key={result.noteId}
              id={`search-result-${result.noteId}`}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(result.noteId, el);
                }
              }}
            >
              <SearchResultItem
                result={result}
                isSelected={idx === selectedIndex}
                onClick={() => onSelect(result)}
              />
            </div>
          ))}
        </div>
      )}

      <SearchFooter
        onDeepSearch={onDeepSearch}
        isDeepSearching={isDeepSearching}
        disabled={!hasResults && phase === "idle"}
      />
    </div>
  );
}

// Re-export types for convenience
export type { SearchResultItemData };
