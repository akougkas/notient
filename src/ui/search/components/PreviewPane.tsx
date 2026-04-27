import { searchHits, searchPreviewPath, searchQuery } from "../state";

function titleFromPath(path: string): string {
  const stripped = path.replace(/^\/+/, "");
  const last = stripped.split("/").pop() ?? stripped;
  return last.replace(/\.md$/, "");
}

function breadcrumbFromPath(path: string): string {
  const stripped = path.replace(/^\/+/, "");
  const segments = stripped.split("/");
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join(" / ");
}

export function PreviewPane() {
  const path = searchPreviewPath.value;
  const hits = searchHits.value;
  const query = searchQuery.value;

  if (!path) {
    return (
      <section class="notient-search-preview__pane" aria-label="Preview">
        <div class="notient-empty">
          <span class="notient-empty__dot" />
          <h3 class="notient-empty__title">Select a result.</h3>
          <p class="notient-search-empty notient-empty__hint">
            Hover or click a result to read it here.
          </p>
        </div>
      </section>
    );
  }

  const hit = hits.find((entry) => entry.notePath === path) ?? null;
  const title = titleFromPath(path);
  const breadcrumb = breadcrumbFromPath(path);

  return (
    <article class="notient-search-preview__pane notient-search__reader-body" aria-label="Preview">
      <header class="notient-search-preview__head">
        <h2 class="notient-search__title notient-search-preview__title">{title}</h2>
        {breadcrumb ? <div class="notient-result__breadcrumb">{breadcrumb}</div> : null}
      </header>
      <div class="notient-search-preview__body">
        {hit ? (
          <p class="notient-search-preview__snippet">{renderHighlighted(hit.snippet, query)}</p>
        ) : (
          <p class="notient-search-empty">Loading preview...</p>
        )}
      </div>
    </article>
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
