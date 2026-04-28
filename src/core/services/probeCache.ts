import type { EventBus } from "../events/eventBus";
import type { StartupProbeEvent } from "../events/types";

/**
 * Tiny in-memory cache for the latest daemon:startup_probe event. Lives
 * inside the daemon process, never persisted. Operators read it via
 * `daemon.status` so the TUI can surface a one-time warning at startup
 * (e.g., "configured budget exceeds loaded context").
 */
export class ProbeCache {
  private latest: StartupProbeEvent | null = null;

  constructor(bus: EventBus) {
    bus.on("daemon:startup_probe", (event) => {
      this.latest = {
        endpoint: event.endpoint,
        modelId: event.modelId,
        configuredContextTokens: event.configuredContextTokens,
        loadedContextLength: event.loadedContextLength,
        status: event.status,
        message: event.message,
      };
    });
  }

  get(): StartupProbeEvent | null {
    return this.latest;
  }
}
