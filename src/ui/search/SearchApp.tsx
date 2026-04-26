import { FilterRow } from "./components/FilterRow";
import { PreviewPane } from "./components/PreviewPane";
import { QueryBar } from "./components/QueryBar";
import { ResultList } from "./components/ResultList";
import { SynthesisCard } from "./components/SynthesisCard";
import { searchActions, searchResult, searchSynthesis } from "./state";

export function SearchApp() {
  const synthesis = searchSynthesis.value;
  const result = searchResult.value;
  return (
    <div class="notient-search-app">
      <QueryBar />
      <FilterRow />
      <main class="notient-search-body">
        <section class="notient-search-results">
          {result ? (
            <div class="notient-search-results__actions">
              <button
                type="button"
                class="notient-search-results__canvas"
                onClick={() => searchActions.value?.viewAsCanvas()}
              >
                View as canvas
              </button>
            </div>
          ) : null}
          {synthesis ? <SynthesisCard /> : null}
          <ResultList />
        </section>
        <aside class="notient-search-preview">
          <PreviewPane />
        </aside>
      </main>
    </div>
  );
}
