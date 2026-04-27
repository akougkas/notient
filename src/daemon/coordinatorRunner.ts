import type { Coordinator } from "../core/coordinator/coordinator";
import type { EventBus } from "../core/events/eventBus";

export interface CoordinatorRunnerOptions {
  bus: EventBus;
  coordinator: Coordinator;
}

export class CoordinatorRunner {
  private armed = false;
  private started = false;
  private unsub: (() => void) | null = null;

  constructor(private readonly options: CoordinatorRunnerOptions) {}

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.unsub = this.options.bus.on("indexer:complete", () => {
      if (this.started) return;
      if (!this.armed) return;
      this.started = true;
      this.options.coordinator.start();
    });
  }

  disarm(): void {
    this.armed = false;
    if (this.unsub) this.unsub();
    this.unsub = null;
  }
}
