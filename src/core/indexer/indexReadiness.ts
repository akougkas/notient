import type { IndexingReadiness } from "../../api/indexing";
import type { EventBus } from "../events/eventBus";

interface NoteState {
  observed: string | null;
  committed: string | null;
  failure: string | null;
}

/** One observed inventory, seeded from durable Tier 1 receipts at each watcher scan. */
export class IndexReadiness {
  private readonly notes = new Map<string, NoteState>();
  private readonly touched = new Set<string>();
  private readonly committedDuringScan = new Set<string>();
  private scanning = true;
  private paused = false;
  private generation = 0;
  private readonly disposeListeners: Array<() => void>;

  constructor(
    bus: EventBus,
    private readonly isExcluded: (path: string) => boolean,
  ) {
    this.disposeListeners = [
      bus.on("indexer:tier1-done", ({ path, bodySha }) => this.committed(path, bodySha)),
      bus.on("indexer:tier1-reused", ({ path, bodySha }) => this.committed(path, bodySha)),
      bus.on("indexer:error", ({ path, message, phase, sourceRevision }) => {
        if (
          phase === undefined ||
          phase === "tier1" ||
          phase === "watcher-add-read" ||
          phase === "watcher-change-read" ||
          phase === "watcher-tombstone"
        )
          this.failed(path, message, sourceRevision);
      }),
    ];
  }

  beginScan(): void {
    this.scanning = true;
    this.paused = false;
    this.touched.clear();
    this.committedDuringScan.clear();
    this.generation++;
  }

  finishScan(observed: ReadonlyMap<string, string>, committed: ReadonlyMap<string, string>): void {
    for (const path of this.notes.keys()) {
      if (!observed.has(path) && !this.touched.has(path)) this.notes.delete(path);
    }
    for (const [path, revision] of observed) {
      if (this.isExcluded(path)) continue;
      const prior = this.notes.get(path);
      if (this.touched.has(path)) continue;
      this.notes.set(path, {
        observed: revision,
        committed: this.committedDuringScan.has(path)
          ? (prior?.committed ?? null)
          : committed.get(path) || null,
        failure: prior?.observed === revision ? prior.failure : null,
      });
    }
    this.scanning = false;
    this.touched.clear();
    this.committedDuringScan.clear();
    this.generation++;
  }

  observe(path: string, revision: string | null): void {
    if (this.isExcluded(path)) return;
    if (this.scanning) this.touched.add(path);
    const prior = this.notes.get(path);
    if (prior?.observed === revision) return;
    this.notes.set(path, {
      observed: revision,
      committed: prior?.committed ?? null,
      failure: prior?.failure ?? null,
    });
    this.generation++;
  }

  committed(path: string, revision: string): void {
    if (this.isExcluded(path)) return;
    if (!this.scanning && !this.notes.has(path)) return;
    if (this.scanning) this.committedDuringScan.add(path);
    const prior = this.notes.get(path);
    // A commit is not an observation of the current file. A newer edit may exist.
    this.notes.set(path, {
      observed: prior?.observed ?? null,
      committed: revision,
      failure: prior?.observed === revision ? null : (prior?.failure ?? null),
    });
    this.generation++;
  }

  failed(path: string, message: string, revision?: string): void {
    if (this.isExcluded(path)) return;
    if (!this.scanning && !this.notes.has(path)) return;
    const prior = this.notes.get(path);
    if (revision !== undefined && prior?.observed !== revision) return;
    if (this.scanning) this.touched.add(path);
    this.notes.set(path, {
      observed: prior?.observed ?? null,
      committed: prior?.committed ?? null,
      failure: message.slice(0, 1000),
    });
    this.generation++;
  }

  removed(path: string): void {
    if (this.scanning) this.touched.add(path);
    this.notes.delete(path);
    this.generation++;
  }

  pause(): void {
    this.paused = true;
    this.generation++;
  }
  /** The source bytes are unchanged, but a destination changed its identity. */
  invalidatePath(path: string): void {
    const note = this.notes.get(path);
    if (!note) return;
    note.committed = null;
    note.failure = null;
    if (this.scanning) this.touched.add(path);
    this.committedDuringScan.delete(path);
    this.generation++;
  }
  /** An explicit graph rebuild removes all durable indexing receipts. */
  invalidate(): void {
    for (const note of this.notes.values()) note.committed = null;
    this.committedDuringScan.clear();
    this.generation++;
  }
  dispose(): void {
    for (const off of this.disposeListeners) off();
  }

  private state(pending: number, failed: number): IndexingReadiness["state"] {
    if (this.paused) return "paused";
    if (this.scanning) return "scanning";
    if (pending > 0) return "indexing";
    if (failed > 0) return "failed";
    return "current";
  }

  snapshot(): IndexingReadiness {
    let current = 0;
    let pending = 0;
    let failed = 0;
    const failures: IndexingReadiness["failures"] = [];
    for (const [path, note] of this.notes) {
      if (note.failure !== null) {
        failed++;
        if (failures.length < 5) failures.push({ path, message: note.failure });
      } else if (note.observed !== null && note.observed === note.committed) current++;
      else pending++;
    }
    return {
      kind: "structural",
      state: this.state(pending, failed),
      generation: this.generation,
      total: this.scanning ? null : this.notes.size,
      current,
      pending,
      failed,
      failures,
    };
  }
}
