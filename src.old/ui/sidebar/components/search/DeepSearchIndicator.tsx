/**
 * DeepSearchIndicator - Inline progress shown in Omnibar during deep search
 */

import { Icon } from "../Icon";

interface DeepSearchIndicatorProps {
  onCancel: () => void;
}

export function DeepSearchIndicator({ onCancel }: DeepSearchIndicatorProps) {
  return (
    <div class="nv2-deep-search-indicator">
      <Icon name="loader" className="nv2-deep-search-spinner" />
      <span class="nv2-deep-search-text">Deep searching...</span>
      <button
        type="button"
        class="nv2-deep-search-cancel"
        onClick={onCancel}
        title="Cancel deep search"
        aria-label="Cancel deep search"
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
