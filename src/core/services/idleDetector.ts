import type { EventBus } from "../events/eventBus";

export type IdleLevel = "30s" | "5m" | "30m";

export interface IdleDetectorOptions {
  thresholds?: Record<IdleLevel, number>;
  now?: () => number;
  tickMs?: number;
}

const DEFAULT_THRESHOLDS: Record<IdleLevel, number> = {
  "30s": 30_000,
  "5m": 300_000,
  "30m": 1_800_000,
};

const ORDER: IdleLevel[] = ["30s", "5m", "30m"];

export class IdleDetector {
  private readonly thresholds: Record<IdleLevel, number>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private lastActivityAt: number;
  private highestEmitted: IdleLevel | null = null;
  private wasIdle = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: EventBus,
    opts: IdleDetectorOptions = {},
  ) {
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? 5_000;
    this.lastActivityAt = this.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  recordActivity(): void {
    this.lastActivityAt = this.now();
    if (this.wasIdle) {
      this.bus.emit({ type: "user:active" });
      this.wasIdle = false;
    }
    this.highestEmitted = null;
  }

  tick(): void {
    const elapsed = this.now() - this.lastActivityAt;
    let next: IdleLevel | null = null;
    for (const level of ORDER) {
      if (elapsed >= this.thresholds[level]) next = level;
    }
    if (next === null) return;
    if (this.highestEmitted === next) return;
    if (this.highestEmitted !== null && ORDER.indexOf(next) <= ORDER.indexOf(this.highestEmitted)) {
      return;
    }
    this.highestEmitted = next;
    this.wasIdle = true;
    this.bus.emit({ type: "user:idle", level: next });
  }
}
