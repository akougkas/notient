/**
 * SearchFooter - "Go Deeper" button with keyboard hint
 */

import { setIcon } from "obsidian";
import type { JSX, Ref } from "preact";
import { useEffect, useRef } from "preact/hooks";

interface SearchFooterProps {
  onDeepSearch: () => void;
  isDeepSearching: boolean;
  disabled?: boolean;
  deepButtonRef?: Ref<HTMLButtonElement>;
}

export function SearchFooter({
  onDeepSearch,
  isDeepSearching,
  disabled,
  deepButtonRef,
}: SearchFooterProps): JSX.Element {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, isDeepSearching ? "loader" : "search");
    }
  }, [isDeepSearching]);

  const buttonClass = isDeepSearching
    ? "nv2-search-deep-btn nv2-search-deep-btn--loading"
    : "nv2-search-deep-btn";

  const iconClass = isDeepSearching
    ? "nv2-search-deep-icon nv2-search-deep-icon--spin"
    : "nv2-search-deep-icon";

  return (
    <div class="nv2-search-footer">
      <button
        ref={deepButtonRef}
        type="button"
        class={buttonClass}
        onClick={onDeepSearch}
        disabled={disabled || isDeepSearching}
        aria-label="Trigger deep search"
      >
        <span class={iconClass} ref={iconRef} aria-hidden="true" />
        <span class="nv2-search-deep-label">{isDeepSearching ? "Searching..." : "Go Deeper"}</span>
      </button>
      <span class="nv2-search-footer-hint">
        <kbd>Shift</kbd>+<kbd>Enter</kbd>
      </span>
    </div>
  );
}
