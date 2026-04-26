import type { EventBus } from "../events/eventBus";

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

export class IndexerQueue {
  private readonly indexNote: IndexNoteFn;
  private readonly debounceMs: number;
  private readonly bus: EventBus;
  private readonly isExcluded: (path: string) => boolean;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private worker: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: IndexerQueueOptions) {
    this.indexNote = opts.indexNote;
    this.debounceMs = opts.debounceMs ?? 500;
    this.bus = opts.bus;
    this.isExcluded = opts.isExcluded ?? (() => false);
  }

  enqueue(path: string): void {
    if (this.disposed) return;
    if (this.isExcluded(path)) return;
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(path);
      if (!this.readySet.has(path)) {
        this.ready.push(path);
        this.readySet.add(path);
      }
      this.kickWorker();
    }, this.debounceMs);
    this.pending.set(path, timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.ready.length = 0;
    this.readySet.clear();
  }

  pendingCount(): number {
    return this.pending.size + this.ready.length;
  }

  private kickWorker(): void {
    if (this.worker || this.disposed) return;
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      if (this.ready.length > 0 && !this.disposed) this.kickWorker();
    });
  }

  private async runWorker(): Promise<void> {
    while (!this.disposed && this.ready.length > 0) {
      const path = this.ready.shift();
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
