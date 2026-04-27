import type { EventBus } from "../core/events/eventBus";

export interface ProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type ProbeFn = () => Promise<ProbeResult>;

export interface ObsidianProbeOptions {
  bus: EventBus;
  intervalMs: number;
  probe: ProbeFn;
}

/**
 * Polls the Obsidian CLI on a fixed interval and emits bridge:up / bridge:down
 * via the EventBus. Probes never throw; failures surface as bridge:down with
 * an error string. Consecutive identical states are deduped so the bus only
 * sees transitions plus the first tick.
 */
export class ObsidianProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastState: "up" | "down" | null = null;

  constructor(private readonly options: ObsidianProbeOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    setImmediate(() => {
      void this.tickOnce();
    });
  }

  async tickOnce(): Promise<void> {
    let result: ProbeResult;
    try {
      result = await this.options.probe();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const next: "up" | "down" = result.ok ? "up" : "down";
    if (this.lastState === next) return;
    this.lastState = next;
    if (result.ok) {
      this.options.bus.emit({ type: "bridge:up", version: result.version });
    } else {
      this.options.bus.emit({ type: "bridge:down", error: result.error });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
