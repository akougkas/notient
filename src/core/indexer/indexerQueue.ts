import type { EventBus } from "../events/eventBus";
import { PriorityQueue } from "./priorityQueue";

export type IndexNoteFn = (path: string) => Promise<unknown>;

export interface IndexerQueueOptions {
  indexNote: IndexNoteFn;
  debounceMs?: number;
  bus: EventBus;
  /**
   * Predicate that returns `true` when a path must be skipped by the indexer.
   * The producer (main.ts vault.on("modify")) is the primary defence, but the
   * queue keeps a defensive copy so Notient-owned folders (Notient/conversations,
   * Notient/proposals, Notient/searches) can never be indexed even if a future
   * caller forgets to pre-filter.
   */
  isExcluded?: (path: string) => boolean;
}

const DEFAULT_PRIORITY = 2;

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  priority: number;
}

export class IndexerQueue {
  private readonly indexNote: IndexNoteFn;
  private readonly debounceMs: number;
  private readonly bus: EventBus;
  private readonly isExcluded: (path: string) => boolean;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly readyHeap = new PriorityQueue<string>();
  private readonly readySet = new Set<string>();
  private enqueueCounter = 0;
  private worker: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: IndexerQueueOptions) {
    this.indexNote = opts.indexNote;
    this.debounceMs = opts.debounceMs ?? 500;
    this.bus = opts.bus;
    this.isExcluded = opts.isExcluded ?? (() => false);
  }

  enqueue(path: string, priority: number = DEFAULT_PRIORITY): void {
    if (this.disposed) return;
    if (this.isExcluded(path)) return;
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = this.pending.get(path);
      this.pending.delete(path);
      const finalPriority = entry ? entry.priority : priority;
      if (!this.readySet.has(path)) {
        const sequence = ++this.enqueueCounter;
        this.readyHeap.enqueue(path, finalPriority, sequence);
        this.readySet.add(path);
      }
      this.kickWorker();
    }, this.debounceMs);
    this.pending.set(path, { timer, priority });
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.readyHeap.remove(() => true);
    this.readySet.clear();
  }

  async drain(): Promise<void> {
    while (!this.disposed && (this.pending.size > 0 || this.readyHeap.size() > 0 || this.worker)) {
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
      try {
        await this.indexNote(path);
      } catch (error) {
        this.bus.emit({
          type: "indexer:error",
          message: (error as Error).message ?? String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
