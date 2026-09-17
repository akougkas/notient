/**
 * Process-wide registry for in-flight `awaken --background` workers.
 *
 * The registry owns admission, cancellation, and completion. `start` creates
 * an AbortController before invoking the worker, so no background worker can
 * begin without being cancellable and tracked. Shutdown closes admission,
 * aborts the remaining workers, and drains their exact completion Promises
 * before SurrealDB teardown begins.
 *
 * Invariants:
 *   - Entries delete themselves automatically when the worker settles.
 *     Callers receive the exact Promise stored by the registry, so their own
 *     `.catch` / `.then` chains observe the canonical completion.
 *   - The internal Map is never exposed. `pendingPromises()` returns a
 *     defensive snapshot for the bounded grace race.
 *   - `stop()` is permanent. A worker cannot start after shutdown closes
 *     admission, and `drain()` cannot complete while an admitted worker is
 *     still capable of enqueueing, emitting, or using SurrealDB.
 */

export interface BackgroundRegistry {
  /** Start one worker with registry-owned cancellation, or return null once stopped. */
  start<T>(worker: (signal: AbortSignal) => Promise<T>): Promise<T> | null;
  /** Snapshot of the currently tracked canonical completion Promises. */
  pendingPromises(): Promise<unknown>[];
  /** Current count of in-flight workers. */
  size(): number;
  /** Close admission and signal cancellation to every remaining worker. */
  stop(): void;
  /** Wait until every admitted worker has settled. */
  drain(): Promise<void>;
}

export class AwakenBackgroundRegistry implements BackgroundRegistry {
  private readonly workers = new Map<Promise<unknown>, AbortController>();
  private accepting = true;

  start<T>(worker: (signal: AbortSignal) => Promise<T>): Promise<T> | null {
    if (!this.accepting) return null;
    const controller = new AbortController();
    // Defer factory invocation into the Promise we track. This captures a
    // synchronous factory throw as a rejection and lets `stop()` abort a
    // worker whose admission landed just before its factory microtask.
    const completion = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return worker(controller.signal);
    });
    this.workers.set(completion, controller);
    void completion.then(
      () => this.workers.delete(completion),
      () => this.workers.delete(completion),
    );
    return completion;
  }

  pendingPromises(): Promise<unknown>[] {
    return [...this.workers.keys()];
  }

  size(): number {
    return this.workers.size;
  }

  stop(): void {
    this.accepting = false;
    for (const controller of this.workers.values()) controller.abort();
  }

  async drain(): Promise<void> {
    while (this.workers.size > 0) {
      await Promise.allSettled([...this.workers.keys()]);
    }
  }
}
