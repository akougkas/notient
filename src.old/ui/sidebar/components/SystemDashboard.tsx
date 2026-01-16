import type { Signal } from "@preact/signals";

import type { IndexStatus, ProviderStatus } from "../types";
import { Icon } from "./Icon";

interface SystemDashboardProps {
  providers: Signal<ProviderStatus>;
  index: Signal<IndexStatus>;
  onSettingsClick?: () => void;
  onModelClick?: () => void;
  onIndexClick?: () => void;
}

export function SystemDashboard({
  providers,
  index,
  onSettingsClick,
  onModelClick,
  onIndexClick,
}: SystemDashboardProps) {
  const { lmstudio, ollama } = providers.value;
  const { isIndexing } = index.value;

  // Determine overall AI health
  const isHealthy = lmstudio.connected || ollama.connected;
  const activeModel = lmstudio.model || ollama.model || "Select Model";

  return (
    <header class="nv2-dashboard">
      {/* Left: Brand */}
      <div class="nv2-dashboard-brand">
        <span class="nv2-brand-text">Notient</span>
      </div>

      {/* Right: Status Pills */}
      <div class="nv2-dashboard-status">
        {/* Model Pill */}
        <button
          type="button"
          class="nv2-status-pill"
          onClick={onModelClick}
          title={isHealthy ? `Active: ${activeModel}` : "AI Disconnected"}
          aria-label={`AI Model Status: ${isHealthy ? activeModel : "Disconnected"}`}
          aria-haspopup="true"
        >
          <div class="nv2-pill-icon-wrapper">
            <Icon name="brain-circuit" className="nv2-pill-icon" />
            <span
              class={`nv2-status-dot ${isHealthy ? "nv2-status-dot--healthy" : "nv2-status-dot--error"}`}
            />
          </div>
          <span class="nv2-pill-label">Model</span>
        </button>

        {/* Index Pill */}
        <button
          type="button"
          class="nv2-status-pill"
          onClick={onIndexClick}
          title={isIndexing ? "Indexing..." : "Index Ready"}
          aria-label="Index Status"
        >
          <div class="nv2-pill-icon-wrapper">
            <Icon name="database" className="nv2-pill-icon" />
            <span
              class={`nv2-status-dot ${isIndexing ? "nv2-status-dot--indexing" : "nv2-status-dot--healthy"}`}
            />
          </div>
          <span class="nv2-pill-label">Index</span>
        </button>

        {/* Settings Button */}
        <button
          type="button"
          class="nv2-settings-btn"
          onClick={onSettingsClick}
          aria-label="Open Settings"
        >
          <Icon name="settings" className="nv2-settings-icon" />
          <span class="nv2-pill-label">Settings</span>
        </button>
      </div>
    </header>
  );
}
