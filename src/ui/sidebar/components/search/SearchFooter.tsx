/**
 * SearchFooter - "Go Deeper" button with keyboard hint
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

interface SearchFooterProps {
  onDeepSearch: () => void;
  isDeepSearching: boolean;
  disabled?: boolean;
}

export function SearchFooter({ onDeepSearch, isDeepSearching, disabled }: SearchFooterProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, isDeepSearching ? "loader" : "search");
    }
  }, [isDeepSearching]);

  return (
    <div class="nv2-search-footer">
      <button
        type="button"
        class={`nv2-search-deep-btn${isDeepSearching ? " nv2-search-deep-btn--loading" : ""}`}
        onClick={onDeepSearch}
        disabled={disabled || isDeepSearching}
        aria-label="Trigger deep search"
      >
        <span
          class={`nv2-search-deep-icon${isDeepSearching ? " nv2-search-deep-icon--spin" : ""}`}
          ref={iconRef}
          aria-hidden="true"
        />
        <span class="nv2-search-deep-label">
          {isDeepSearching ? "Searching..." : "Go Deeper"}
        </span>
      </button>
      <span class="nv2-search-footer-hint">
        <kbd>Shift</kbd>+<kbd>Enter</kbd>
      </span>
    </div>
  );
}
