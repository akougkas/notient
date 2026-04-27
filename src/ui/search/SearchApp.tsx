import { signal } from "@preact/signals";
import type { SearchMode } from "../../core/search/types";
import { FilterRow } from "./components/FilterRow";
import { PreviewPane } from "./components/PreviewPane";
import { QueryBar } from "./components/QueryBar";
import { ResultList } from "./components/ResultList";
import { SynthesisCard } from "./components/SynthesisCard";
import { searchActions, searchMode, searchResult, searchSynthesis } from "./state";

const MODE_HINTS: Record<SearchMode, string> = {
  quick: "Title and chunk lookup. No model calls.",
  balanced: "Vector recall, model rerank.",
  deep: "Graph expansion plus a synthesis with citations.",
};

export const filtersOpen = signal<boolean>(false);

export function SearchApp() {
  const synthesis = searchSynthesis.value;
  const result = searchResult.value;
  const mode = searchMode.value;
  const open = filtersOpen.value;
  return (
    <div class="notient-search notient-search-app">
      <aside class="notient-search__results notient-search-results">
        <header class="notient-search__head">
          <h1 class="notient-search__title">Search</h1>
          <div class="notient-search__modes" aria-label="Search mode">
            <button
              type="button"
              class="notient-search__mode"
              aria-pressed={mode === "quick"}
              onClick={() => {
                searchMode.value = "quick";
              }}
            >
              Quick
            </button>
            <button
              type="button"
              class="notient-search__mode"
              aria-pressed={mode === "balanced"}
              onClick={() => {
                searchMode.value = "balanced";
              }}
            >
              Balanced
            </button>
            <button
              type="button"
              class="notient-search__mode"
              aria-pressed={mode === "deep"}
              onClick={() => {
                searchMode.value = "deep";
              }}
            >
              Deep
            </button>
          </div>
          <p class="notient-search__mode-hint">{MODE_HINTS[mode]}</p>
          <QueryBar
            filtersOpen={open}
            onToggleFilters={() => {
              filtersOpen.value = !filtersOpen.value;
            }}
          />
        </header>
        <FilterRow open={open} />
        {result ? (
          <div class="notient-search__results-actions notient-search-results__actions">
            <button
              type="button"
              class="notient-button notient-search-results__canvas"
              data-emphasis="ghost"
              onClick={() => searchActions.value?.viewAsCanvas()}
            >
              View as canvas
            </button>
          </div>
        ) : null}
        {synthesis ? <SynthesisCard /> : null}
        <ResultList />
      </aside>
      <main class="notient-search__reader notient-search-preview">
        <PreviewPane />
      </main>
    </div>
  );
}
