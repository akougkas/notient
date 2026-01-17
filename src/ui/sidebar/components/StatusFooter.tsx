/**
 * Status Footer - Clickable system health display
 * Shows connection status, note count, version
 * Click opens system health modal (wired in G6)
 */

import type { Signal } from "@preact/signals";
import { openSettings } from "../App";
import type { SystemStatus } from "../types";

interface StatusFooterProps {
  status: Signal<SystemStatus>;
}

export function StatusFooter({ status }: StatusFooterProps) {
  const { connected, noteCount, version } = status.value;

  const handleClick = () => {
    openSettings();
  };

  return (
    <output class="nv2-status-footer">
      <button
        type="button"
        class="nv2-status-button"
        onClick={handleClick}
        aria-label="Open system health"
      >
        <span class={`nv2-status-indicator ${connected ? "nv2-status-indicator--connected" : ""}`}>
          ●
        </span>
        <span class="nv2-status-text">{connected ? "Ready" : "Offline"}</span>
        <span class="nv2-status-separator">│</span>
        <span class="nv2-status-notes">{noteCount.toLocaleString()} notes</span>
        <span class="nv2-status-separator">│</span>
        <span class="nv2-status-version">v{version}</span>
      </button>
    </output>
  );
}
