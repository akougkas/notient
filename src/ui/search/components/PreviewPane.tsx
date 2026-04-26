import { searchHits, searchPreviewPath, searchQuery } from "../state";

export function PreviewPane() {
  const path = searchPreviewPath.value;
  const hits = searchHits.value;
  const query = searchQuery.value;

  if (!path) {
    return (
      <section class="notient-search-preview__pane" aria-label="Preview">
        <p class="notient-search-empty">Hover a result to preview it here.</p>
      </section>
    );
  }

  const hit = hits.find((entry) => entry.notePath === path) ?? null;

  return (
    <section class="notient-search-preview__pane" aria-label="Preview">
      <header class="notient-search-preview__head">
        <h3 class="notient-search-preview__title">{path}</h3>
      </header>
      <div class="notient-search-preview__body">
        {hit ? (
          <p class="notient-search-preview__snippet">{renderHighlighted(hit.snippet, query)}</p>
        ) : (
          <p class="notient-search-empty">Loading preview…</p>
        )}
      </div>
    </section>
  );
}

function renderHighlighted(snippet: string, query: string) {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [snippet];
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${escaped})`, "gi");
  const parts = snippet.split(pattern);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <mark key={`hl-${String(index)}`} class="notient-search-preview__mark">
          {part}
        </mark>
      );
    }
    return part;
  });
}
