import { useState } from "preact/hooks";
import { searchActions, searchError, searchHits, searchPreviewPath, searchRunning } from "../state";
import { ResultRow } from "./ResultRow";

const INITIAL_WINDOW = 30;
const WINDOW_STEP = 30;

export function ResultList() {
  const hits = searchHits.value;
  const preview = searchPreviewPath.value;
  const running = searchRunning.value;
  const error = searchError.value;
  const [windowSize, setWindowSize] = useState<number>(INITIAL_WINDOW);

  if (error) {
    return (
      <section class="notient-search-results__body" aria-live="polite">
        <p class="notient-search-error">{error}</p>
      </section>
    );
  }

  if (hits.length === 0) {
    return (
      <section class="notient-search-results__body" aria-live="polite">
        <p class="notient-search-empty">
          {running ? "Searching..." : "No results yet. Enter a query to begin."}
        </p>
      </section>
    );
  }

  const visible = hits.slice(0, windowSize);
  const hasMore = hits.length > visible.length;

  return (
    <section class="notient-search-results__body" aria-live="polite">
      <ol class="notient-search-results__list">
        {visible.map((hit) => (
          <li key={`${hit.notePath}::${hit.chunkId ?? "_"}`}>
            <ResultRow
              hit={hit}
              selected={preview === hit.notePath}
              onHover={(notePath) => {
                searchPreviewPath.value = notePath;
              }}
              onOpen={(notePath) => {
                searchActions.value?.openHit(notePath);
              }}
            />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <button
          type="button"
          class="notient-search-results__more"
          onClick={() => setWindowSize((current) => current + WINDOW_STEP)}
        >
          Load {Math.min(WINDOW_STEP, hits.length - visible.length)} more
        </button>
      ) : null}
    </section>
  );
}
