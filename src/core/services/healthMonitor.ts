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
  }

  current(): { label: string; ok: boolean }[] {
    return this.endpoints.map((endpoint) => ({
      label: endpoint.label,
      ok: this.lastResults.get(endpoint.label) ?? false,
    }));
  }

  private async probeAll(): Promise<void> {
    const timeoutMs = Math.max(20, Math.floor(this.config.intervalMs / 2));
    await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        let ok = false;
        try {
          ok = await endpoint.provider.isAvailable(controller.signal);
        } catch {
          ok = false;
        } finally {
          clearTimeout(timer);
        }
        const latencyMs = Date.now() - start;
        this.lastResults.set(endpoint.label, ok);
        this.bus.emit({ type: "llm:health", endpoint: endpoint.label, ok, latencyMs });
      }),
    );
  }
}
