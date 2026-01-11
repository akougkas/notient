/**
 * SearchResultItem - Individual search result with shimmer loading state
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

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
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      const icon = getParaIcon(result.paraType);
      setIcon(iconRef.current, icon);
    }
  }, [result.paraType]);

  const timeAgo = formatTimeAgo(result.lastModified);

  return (
    <div
      class={`nv2-search-result${isSelected ? " nv2-search-result--selected" : ""}${result.isLoading ? " nv2-search-result--loading" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      role="option"
      aria-selected={isSelected}
      data-noteid={result.noteId}
    >
      <span class="nv2-search-result-icon" ref={iconRef} aria-hidden="true" />
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

function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return path.slice(0, maxLen) + "...";
  return `.../${parts.slice(-2).join("/")}`;
}

function formatTimeAgo(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
