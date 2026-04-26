import type { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";

export interface MonitoredEndpoint {
  label: string;
  baseUrl: string;
  provider: LLMProvider;
}

export interface HealthMonitorConfig {
  intervalMs: number;
}

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResults = new Map<string, boolean>();
  private inflight = new Set<AbortController>();

  constructor(
    private readonly endpoints: MonitoredEndpoint[],
    private readonly bus: EventBus,
    private readonly config: HealthMonitorConfig,
  ) {}

  start(): void {
    this.probeAll();
    this.timer = setInterval(() => this.probeAll(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.inflight) {
      controller.abort();
    }
    this.inflight.clear();
  }

  current(): { label: string; ok: boolean }[] {
    return this.endpoints.map((endpoint) => ({
      label: endpoint.label,
      ok: this.lastResults.get(endpoint.label) ?? false,
    }));
  }

  /**
   * Returns the set of in-flight probe controllers. Test-only accessor; the
   * production code paths should treat this as opaque internal state.
   */
  inflightControllers(): ReadonlySet<AbortController> {
    return this.inflight;
  }

  private async probeAll(): Promise<void> {
    const timeoutMs = Math.max(500, Math.floor(this.config.intervalMs / 2));
    await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const controller = new AbortController();
        this.inflight.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        let ok = false;
        try {
          ok = await endpoint.provider.isAvailable(controller.signal);
        } catch {
          ok = false;
        } finally {
          clearTimeout(timer);
          this.inflight.delete(controller);
        }
        const latencyMs = Date.now() - start;
        this.lastResults.set(endpoint.label, ok);
        this.bus.emit({ type: "llm:health", endpoint: endpoint.label, ok, latencyMs });
      }),
    );
  }
}
