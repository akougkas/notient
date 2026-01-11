/**
 * DeepSearchIndicator - Inline progress shown in Omnibar during deep search
 */

import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

interface DeepSearchIndicatorProps {
  onCancel: () => void;
}

export function DeepSearchIndicator({ onCancel }: DeepSearchIndicatorProps) {
  const spinnerRef = useRef<HTMLSpanElement>(null);
  const cancelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (spinnerRef.current) {
      setIcon(spinnerRef.current, "loader");
    }
    if (cancelRef.current) {
      setIcon(cancelRef.current, "x");
    }
  }, []);

  return (
    <div class="nv2-deep-search-indicator">
      <span class="nv2-deep-search-spinner" ref={spinnerRef} aria-hidden="true" />
      <span class="nv2-deep-search-text">Deep searching...</span>
      <button
        type="button"
        class="nv2-deep-search-cancel"
        onClick={onCancel}
        title="Cancel deep search"
        aria-label="Cancel deep search"
      >
        <span ref={cancelRef} aria-hidden="true" />
      </button>
    </div>
  );
}
