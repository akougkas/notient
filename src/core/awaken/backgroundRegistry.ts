/**
 * Process-wide registry for in-flight `awaken --background` workers.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.5 (operational tables) and the Phase D follow-up that lifts the
 * tracking Set out of `daemon/handlers/awaken.ts`. The handler used to
 * own a module-level `Set<Promise<unknown>>` whose only consumer was the
 * `.finally` cleanup that detached entries; the daemon's shutdown path
 * had no way to await pending workers because the Set lived inside a
 * closure.
 *
 * Lifting it onto the kernel gives the shutdown path a single hook it
 * can poll. `track(promise)` is the only mutation the handler performs;
 * `pendingPromises()` and `size()` are read-only views the shutdown step
 * uses to race the workers against a bounded grace window. The registry
 * intentionally does not expose any cancellation primitive: the worker
 * loop already shuts down cleanly when its SurrealDB live-query channel
 * closes (the daemon closes the SDK connection later in the same shutdown
 * sequence), so callers only need a fence, not a kill switch.
 *
 * Invariants:
 *   - Entries delete themselves automatically when the tracked promise
 *     settles. Callers receive their own promise back unchanged so any
 *     `.catch` chain composed by the caller still observes the original
 *     value or rejection.
 *   - The internal Set is never exposed; callers cannot mutate it
 *     directly. `pendingPromises()` returns a defensive snapshot so a
 *     caller iterating the result while a worker settles will not
 *     observe a mutation.
 */

export interface BackgroundRegistry {
  /**
   * Register `promise` as in-flight. The registry attaches a `.finally`
   * handler that removes the entry once the promise settles; that handler
   * is invoked on a separate wrapper promise so the caller's own `.catch`
   * / `.then` chains continue to observe the original resolution path.
   */
  track(promise: Promise<unknown>): void;
  /**
   * Snapshot of the currently tracked promises. Used by the daemon
   * shutdown path to race against a single shared timeout.
   */
  pendingPromises(): Promise<unknown>[];
  /** Current count of in-flight entries. */
  size(): number;
}

export class AwakenBackgroundRegistry implements BackgroundRegistry {
  private readonly set = new Set<Promise<unknown>>();

  track(promise: Promise<unknown>): void {
    this.set.add(promise);
    // The cleanup runs on a wrapper promise so a caller-side `.catch`
    // chain still observes the original rejection. The wrapper itself
    // attaches a no-op `.catch` so the rejection does not propagate
    // back as an "unhandled rejection" through the chain we created
    // here; the caller's own handler (or absence of one) governs the
    // original promise's rejection visibility.
    promise
      .finally(() => {
        this.set.delete(promise);
      })
      .catch(() => {
        // The original rejection is the caller's responsibility; we
        // only need the cleanup to run.
      });
  }

  pendingPromises(): Promise<unknown>[] {
    return [...this.set];
  }

  size(): number {
    return this.set.size;
  }
}
