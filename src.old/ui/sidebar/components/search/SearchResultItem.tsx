/**
 * SearchResultItem - Individual search result with shimmer loading state
 */

import { formatTimeAgo, truncatePath } from "../../utils/formatters";
import { Icon } from "../Icon";

export interface SearchResultItemData {
  noteId: string;
  path: string;
  title: string;
  snippet?: string;
  score: number;
  tier: "instant" | "evolving" | "deep";
  isLoading: boolean;
  paraType?: "projects" | "areas" | "resources" | "archive" | "inbox";
  lastModified: number;
}

interface SearchResultItemProps {
  result: SearchResultItemData;
  isSelected: boolean;
  onClick: () => void;
}

export function SearchResultItem({ result, isSelected, onClick }: SearchResultItemProps) {
  const timeAgo = formatTimeAgo(result.lastModified);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      class={`nv2-search-result${isSelected ? " nv2-search-result--selected" : ""}${result.isLoading ? " nv2-search-result--loading" : ""}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.preventDefault()}
      // biome-ignore lint/a11y/useSemanticElements: option requires select parent which doesn't fit this UX
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      data-noteid={result.noteId}
    >
      <Icon name={getParaIcon(result.paraType)} className="nv2-search-result-icon" />
      <div class="nv2-search-result-content">
        <span class="nv2-search-result-title">{result.title}</span>
        <div class="nv2-search-result-meta">
          <span class="nv2-search-result-path" title={result.path}>
            {truncatePath(result.path)}
          </span>
          <span class="nv2-search-result-dot">·</span>
          <span class="nv2-search-result-time">{timeAgo}</span>
        </div>
        {result.snippet && <span class="nv2-search-result-snippet">{result.snippet}</span>}
      </div>
      {result.tier === "evolving" && !result.isLoading && (
        <span
          class="nv2-search-result-score"
          title={`Relevance: ${Math.round(result.score * 100)}%`}
        >
          {result.score.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function getParaIcon(paraType?: string): string {
  switch (paraType) {
    case "projects":
      return "target";
    case "areas":
      return "compass";
    case "resources":
      return "book";
    case "archive":
      return "archive";
    case "inbox":
      return "inbox";
    default:
      return "file-text";
  }
}
