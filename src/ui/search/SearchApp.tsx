import { FilterRow } from "./components/FilterRow";
import { PreviewPane } from "./components/PreviewPane";
import { QueryBar } from "./components/QueryBar";
import { ResultList } from "./components/ResultList";
import { SynthesisCard } from "./components/SynthesisCard";
import { searchSynthesis } from "./state";

export function SearchApp() {
  const synthesis = searchSynthesis.value;
  return (
    <div class="notient-search-app">
      <QueryBar />
      <FilterRow />
      <main class="notient-search-body">
        <section class="notient-search-results">
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
