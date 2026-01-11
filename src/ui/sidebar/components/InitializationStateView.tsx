/**
 * InitializationStateView - Displays initialization state with appropriate messaging
 */

import type { InitializationContext, InitializationState } from "../../../types/services";

interface InitializationStateViewProps {
  state: InitializationState;
  context: InitializationContext | null;
}

export function InitializationStateView({ state, context }: InitializationStateViewProps) {
  const display = getStateDisplay(state, context);
  const showSpinner = !display.isError && state !== "READY";

  return (
    <output
      class={`nv2-init-state ${display.isError ? "nv2-init-state--error" : ""}`}
      aria-live="polite"
    >
      {showSpinner && <div class="nv2-loading-spinner" aria-hidden="true" />}
      {display.isError && (
        <div class="nv2-init-state-icon nv2-init-state-icon--error" aria-hidden="true">
          {display.icon === "x-circle" ? "!" : "!!"}
        </div>
      )}
      <div class="nv2-init-state-title">{display.title}</div>
      <div class="nv2-init-state-message">{display.message}</div>
      {context?.capabilities && (
        <div class="nv2-init-state-capabilities">
          {context.capabilities.search && (
            <span class="nv2-capability nv2-capability--active">Search</span>
          )}
          {context.capabilities.chat && (
            <span class="nv2-capability nv2-capability--active">Chat</span>
          )}
          {context.capabilities.indexing && (
            <span class="nv2-capability nv2-capability--active">Indexing</span>
          )}
        </div>
      )}
    </output>
  );
}

function getStateDisplay(
  state: InitializationState,
  context: InitializationContext | null,
): {
  icon: string;
  title: string;
  message: string;
  isError: boolean;
} {
  switch (state) {
    case "UNINITIALIZED":
      return {
        icon: "hourglass",
        title: "Starting Up",
        message: "Preparing Notient...",
        isError: false,
      };
    case "CHECKING_PROVIDERS":
      return {
        icon: "hourglass",
        title: "Connecting",
        message: context?.progress?.message || "Checking Ollama and LM Studio connections...",
        isError: false,
      };
    case "LOADING_INDEX":
      return {
        icon: "hourglass",
        title: "Loading Index",
        message: context?.progress
          ? `${context.progress.message} (${context.progress.percent}%)`
          : "Loading vector index...",
        isError: false,
      };
    case "WARMING_SERVICES":
      return {
        icon: "hourglass",
        title: "Almost Ready",
        message: context?.progress?.message || "Warming up services...",
        isError: false,
      };
    case "DEGRADED":
      return {
        icon: "alert-triangle",
        title: "Limited Mode",
        message: getDegradedMessage(context?.degradedReason),
        isError: false,
      };
    case "FAILED":
      return {
        icon: "x-circle",
        title: "Connection Failed",
        message: context?.errorMessage || getFailedMessage(context?.failedReason),
        isError: true,
      };
    case "CRASHED":
      return {
        icon: "alert-octagon",
        title: "Recovery Needed",
        message: context?.errorMessage || getCrashedMessage(context?.crashedReason),
        isError: true,
      };
    case "READY":
      return {
        icon: "check-circle",
        title: "Ready",
        message: "Notient is ready to use.",
        isError: false,
      };
    default:
      return {
        icon: "hourglass",
        title: "Initializing",
        message: "Please wait...",
        isError: false,
      };
  }
}

function getDegradedMessage(reason?: string): string {
  switch (reason) {
    case "lmstudio_down":
      return "LM Studio is not connected. Search works, but chat is unavailable.";
    case "index_stale":
      return "Index may be outdated. Consider rebuilding for best results.";
    case "embedding_mismatch":
      return "Embedding model changed. Rebuild index for accurate search.";
    case "partial_init":
      return "Some services failed to initialize. Limited functionality available.";
    default:
      return "Running with limited capabilities.";
  }
}

function getFailedMessage(reason?: string): string {
  switch (reason) {
    case "ollama_down":
      return "Cannot connect to Ollama. Please ensure Ollama is running.";
    case "missing_config":
      return "Missing configuration. Please check your settings.";
    case "connection_failed":
      return "Connection failed. Check that Ollama and LM Studio are running.";
    case "index_corrupt":
      return "Index appears corrupted. Try rebuilding from settings.";
    case "critical_error":
      return "A critical error occurred. Please restart Obsidian.";
    default:
      return "Initialization failed. Check settings and try again.";
  }
}

function getCrashedMessage(reason?: string): string {
  switch (reason) {
    case "indexing_interrupted":
      return "Indexing was interrupted. Resume or rebuild the index.";
    case "recovery_needed":
      return "Recovery is needed. Try reopening Obsidian.";
    default:
      return "An unexpected error occurred. Restart may be required.";
  }
}
