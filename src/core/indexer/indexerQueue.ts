import { type EventBus, assertEventBus } from "../events/eventBus";
import { IndexReadiness } from "./indexReadiness";
import { PriorityQueue } from "./priorityQueue";

/**
 * Per-note runtime context the queue forwards to `indexNote` when it dequeues.
 * `tierFilter` scopes `awaken --tier` and `reindex --tier`; callers that omit
 * it run every tier.
 */
export interface IndexNoteContext {
  tierFilter?: ReadonlyArray<number>;
}

export type IndexNoteFn = (path: string, context: IndexNoteContext) => Promise<unknown>;

export interface IndexerQueueOptions {
  readiness?: IndexReadiness;
  indexNote: IndexNoteFn;
  debounceMs: number;
  bus: EventBus;
  /**
   * Predicate that returns `true` when a path must be skipped by the indexer.
   * The producer (main.ts vault.on("modify")) is the primary defence, but the
   * queue keeps a defensive copy so Notient-owned conversation and proposal
   * folders can never be indexed even if a future caller forgets to pre-filter.
   */
  isExcluded: (path: string) => boolean;
}

const DEFAULT_PRIORITY = 2;

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  priority: number;
  tierFilter?: ReadonlyArray<number>;
}

interface ReadyEntry {
  tierFilter?: ReadonlyArray<number>;
}

export class IndexerQueue {
  readonly readiness: IndexReadiness;
  private readonly indexNote: IndexNoteFn;
  private readonly debounceMs: number;
  private readonly bus: EventBus;
  private readonly isExcluded: (path: string) => boolean;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly readyHeap = new PriorityQueue<string>();
  private readonly readyContext = new Map<string, ReadyEntry>();
  private readonly readySet = new Set<string>();
  private enqueueCounter = 0;
  private worker: Promise<void> | null = null;
  private accepting = true;
  private maintenancePaused = false;
  private disposed = false;

  constructor(opts: IndexerQueueOptions) {
    if (!Number.isInteger(opts.debounceMs) || opts.debounceMs < 0 || opts.debounceMs > 600_000) {
      throw new Error("IndexerQueue debounceMs must be an integer between 0 and 600000");
    }
    if (typeof opts.isExcluded !== "function") {
      throw new Error("IndexerQueue isExcluded must be a function");
    }
    assertEventBus(opts.bus, "IndexerQueue");
    this.readiness = opts.readiness ?? new IndexReadiness(opts.bus, opts.isExcluded);
    this.indexNote = opts.indexNote;
    this.debounceMs = opts.debounceMs;
    this.bus = opts.bus;
    this.isExcluded = opts.isExcluded;
  }

  enqueue(
    path: string,
    priority: number = DEFAULT_PRIORITY,
    tierFilter?: ReadonlyArray<number>,
  ): void {
    if (!this.accepting || this.maintenancePaused || this.disposed) return;
    if (this.isExcluded(path)) return;
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = this.pending.get(path);
      this.pending.delete(path);
      const finalPriority = entry ? entry.priority : priority;
      const finalFilter = entry ? entry.tierFilter : tierFilter;
      if (!this.readySet.has(path)) {
        const sequence = ++this.enqueueCounter;
        this.readyHeap.enqueue(path, finalPriority, sequence);
        this.readySet.add(path);
        this.readyContext.set(path, finalFilter === undefined ? {} : { tierFilter: finalFilter });
      }
      this.kickWorker();
    }, this.debounceMs);
    const next: PendingEntry = { timer, priority };
    if (tierFilter !== undefined) {
      next.tierFilter = tierFilter;
    }
    this.pending.set(path, next);
  }

  /**
   * Close queue admission without discarding work already accepted. Shutdown
   * calls this after stopping external producers, then drains and disposes in
   * that order.
   */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Temporarily reject new work while preserving and draining accepted work. */
  pause(): void {
    if (this.disposed) return;
    this.maintenancePaused = true;
  }

  /** Reopen maintenance admission unless permanent shutdown already began. */
  resume(): void {
    if (!this.accepting || this.disposed) return;
    this.maintenancePaused = false;
  }

  dispose(): void {
    this.stopAccepting();
    this.disposed = true;
    this.readiness.dispose();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.readyHeap.remove(() => true);
    this.readySet.clear();
    this.readyContext.clear();
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.readyHeap.size() > 0 || this.worker) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  pendingCount(priority?: number): number {
    if (priority === undefined) {
      return this.pending.size + this.readyHeap.size();
    }
    let pendingMatches = 0;
    for (const entry of this.pending.values()) {
      if (entry.priority === priority) pendingMatches++;
    }
    return pendingMatches + this.readyHeap.countByPriority(priority);
  }

  private kickWorker(): void {
    if (this.worker || this.disposed) return;
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      if (this.readyHeap.size() > 0 && !this.disposed) this.kickWorker();
    });
  }

  private async runWorker(): Promise<void> {
    while (!this.disposed && this.readyHeap.size() > 0) {
      const path = this.readyHeap.dequeue();
      if (!path) break;
      this.readySet.delete(path);
      const context = this.readyContext.get(path) ?? {};
      this.readyContext.delete(path);
      try {
        await this.indexNote(path, context);
      } catch (error) {
        this.bus.emit({
          type: "indexer:error",
          path,
          message: (error as Error).message ?? String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
