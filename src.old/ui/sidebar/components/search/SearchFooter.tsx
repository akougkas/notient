/**
 * SearchFooter - "Go Deeper" button with keyboard hint
 */

import type { JSX, Ref } from "preact";
import { Icon } from "../Icon";

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
        <Icon name={isDeepSearching ? "loader" : "search"} className={iconClass} />
        <span class="nv2-search-deep-label">{isDeepSearching ? "Searching..." : "Go Deeper"}</span>
      </button>
      <span class="nv2-search-footer-hint">
        <kbd>Shift</kbd>+<kbd>Enter</kbd>
      </span>
    </div>
  );
}
