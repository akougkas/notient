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
        <div class="notient-empty">
          <span class="notient-empty__dot" />
          <h3 class="notient-empty__title">
            {running ? "Searching..." : "Listening for a query."}
          </h3>
          <p class="notient-search-empty notient-empty__hint">
            {running ? "Stand by." : "Type a query above to begin."}
          </p>
        </div>
      </section>
    );
  }

  const visible = hits.slice(0, windowSize);
  const hasMore = hits.length > visible.length;

  return (
    <section class="notient-search-results__body" aria-live="polite">
      <div class="notient-search-results__list">
        {visible.map((hit) => (
          <ResultRow
            key={`${hit.notePath}::${hit.chunkId ?? "_"}`}
            hit={hit}
            selected={preview === hit.notePath}
            onHover={(notePath) => {
              searchPreviewPath.value = notePath;
            }}
            onOpen={(notePath) => {
              searchActions.value?.openHit(notePath);
            }}
          />
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          class="notient-button notient-search-results__more"
          data-emphasis="ghost"
          onClick={() => setWindowSize((current) => current + WINDOW_STEP)}
        >
          Load {Math.min(WINDOW_STEP, hits.length - visible.length)} more
        </button>
      ) : null}
    </section>
  );
}
