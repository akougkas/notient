import type { EventBus } from "../events/eventBus";

export type SentienceRung = "link" | "synthesize" | "mature";

export type HumanActivitySource =
  | "vault:add"
  | "vault:change"
  | "vault:rename"
  | "vault:delete"
  | "chat"
  | "search"
  | "approval"
  | "note-focus";

export interface HumanActivity {
  source: HumanActivitySource;
  /**
   * Supplying a string selects that note. Supplying null clears focus.
   * Omitting the field preserves the currently engaged note.
   */
  notePath?: string | null;
}

export interface SentienceActivityOptions {
  loadActiveNote: () => Promise<string | null>;
  thresholds?: Record<SentienceRung, number>;
  now?: () => number;
  tickMs?: number;
}

export interface SentienceSnapshot {
  epoch: number;
  lastHumanActivityAt: number;
  activeNotePath: string | null;
  emittedRungs: ReadonlySet<SentienceRung>;
  ready: boolean;
}

const DEFAULT_THRESHOLDS: Record<SentienceRung, number> = {
  link: 30_000,
  synthesize: 300_000,
  mature: 1_800_000,
};

const RUNGS: readonly SentienceRung[] = ["link", "synthesize", "mature"];

/**
 * One authority for human activity, note engagement, and the vault's idle
 * cognition ladder. Every human action begins a new epoch. Idle events carry
 * that epoch and a snapshot of the engaged note, so the coordinator can
 * discard work that became stale when the human returned.
 */
export class SentienceActivity {
  private readonly thresholds: Record<SentienceRung, number>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly loadActiveNote: () => Promise<string | null>;
  private epoch = 0;
  private lastHumanActivityAt: number;
  private activeNotePath: string | null = null;
  private emittedRungs = new Set<SentienceRung>();
  private activityBeforeReady = false;
  private ready = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: EventBus,
    options: SentienceActivityOptions,
  ) {
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.now = options.now ?? (() => Date.now());
    this.tickMs = options.tickMs ?? 5_000;
    this.loadActiveNote = options.loadActiveNote;
    this.lastHumanActivityAt = this.now();
  }

  /**
   * Marks the runtime ready and starts a fresh epoch. Activity observed while
   * the watcher was coming online wins over the persisted focus snapshot.
   */
  async start(): Promise<void> {
    if (this.ready) return;
    const persistedActiveNote = await this.loadActiveNote();
    if (!this.activityBeforeReady) this.activeNotePath = persistedActiveNote;
    this.ready = true;
    this.beginEpoch(this.now());
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.ready = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.ready;
  }

  isCurrentEpoch(epoch: number): boolean {
    return this.ready && epoch === this.epoch;
  }

  recordHumanActivity(activity: HumanActivity): void {
    if (Object.hasOwn(activity, "notePath")) {
      this.activeNotePath = activity.notePath ?? null;
    }
    if (!this.ready) this.activityBeforeReady = true;
    this.beginEpoch(this.now());
    this.bus.emit({
      type: "sentience:activity",
      epoch: this.epoch,
      source: activity.source,
      activeNotePath: this.activeNotePath,
    });
  }

  recordDeletion(path: string): void {
    this.recordHumanActivity({
      source: "vault:delete",
      ...(this.activeNotePath === path ? { notePath: null } : {}),
    });
  }

  snapshot(): SentienceSnapshot {
    return {
      epoch: this.epoch,
      lastHumanActivityAt: this.lastHumanActivityAt,
      activeNotePath: this.activeNotePath,
      emittedRungs: new Set(this.emittedRungs),
      ready: this.ready,
    };
  }

  /** Exposed for deterministic fake-clock tests. */
  tick(): void {
    if (!this.ready) return;
    const idleForMs = this.now() - this.lastHumanActivityAt;
    for (const rung of RUNGS) {
      if (idleForMs < this.thresholds[rung] || this.emittedRungs.has(rung)) continue;
      this.emittedRungs.add(rung);
      this.bus.emit({
        type: "sentience:idle",
        epoch: this.epoch,
        rung,
        idleForMs,
        activeNotePath: this.activeNotePath,
      });
    }
  }

  private beginEpoch(at: number): void {
    this.epoch += 1;
    this.lastHumanActivityAt = at;
    this.emittedRungs = new Set();
  }
}
