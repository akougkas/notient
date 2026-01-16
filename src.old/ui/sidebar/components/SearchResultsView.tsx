/**
 * SearchResultsView - Display search results from the Omnibar
 */

import type { SearchResult } from "../../../types/search";

interface SearchResultsViewProps {
  results: SearchResult[];
  query: string;
  onOpenNote: (path: string) => void;
  onClear: () => void;
}

export function SearchResultsView({ results, query, onOpenNote, onClear }: SearchResultsViewProps) {
  return (
    <section class="nv2-search-results" aria-label="Search results">
      <div class="nv2-search-results-header">
        <span class="nv2-search-results-title">Results for "{query}"</span>
        <button
          type="button"
          class="nv2-search-results-clear"
          onClick={onClear}
          aria-label="Clear search results"
        >
          Clear
        </button>
      </div>
      {results.length === 0 ? (
        <div class="nv2-search-no-results">No notes found matching your query.</div>
      ) : (
        <div class="nv2-search-results-list">
          {results.map((result) => (
            <button
              key={result.path}
              type="button"
              class="nv2-search-result-item"
              onClick={() => onOpenNote(result.path)}
              aria-label={`Open note: ${result.title || result.path.split("/").pop()?.replace(".md", "") || result.path}`}
            >
              <div class="nv2-search-result-title">
                {result.title || result.path.split("/").pop()?.replace(".md", "") || result.path}
              </div>
              {result.chunks?.[0]?.text && (
                <div class="nv2-search-result-snippet">
                  {result.chunks[0].text.slice(0, 150)}...
                </div>
              )}
              <div class="nv2-search-result-meta">
                <span class="nv2-search-result-score">
                  {Math.round(result.bestScore * 100)}% match
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
