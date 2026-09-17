import { RecordId, type Surreal } from "surrealdb";
import { listNotePaths } from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import { isCanonicalPublicNotePath } from "../vault/publicPath";
import { invalidateVaultPathUniverse } from "./indexNote";
import type { IndexReadiness } from "./indexReadiness";
import { referenceTargetsSchema, resolveReferenceTarget } from "./referenceTargets";

interface ReferenceRow {
  id: RecordId<"note">;
  path: string;
  reference_targets?: string;
}

/** Reconsider authored destinations after inventory changes, and after an
 * in-flight parse that could have observed an older inventory. No inference,
 * source writes, human activity, or approval changes belong to this repair. */
export class ReferenceRepair {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private all = false;
  private readonly paths = new Set<string>();
  private stopped = true;
  private off: (() => void) | null = null;

  constructor(
    private readonly options: {
      db: Surreal;
      bus: EventBus;
      readiness?: IndexReadiness;
      enqueue: (path: string) => void;
      isExcluded: (path: string) => boolean;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.off = this.options.bus.on("indexer:tier1-done", ({ path }) => this.request(path));
  }

  request(path?: string): void {
    if (this.stopped) return;
    if (path === undefined) this.all = true;
    else if (!this.options.isExcluded(path)) this.paths.add(path);
    this.schedule(100);
  }

  private schedule(delay: number): void {
    if (this.timer || this.running || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.flush()
        .catch((error) => {
          this.all = true;
          this.options.bus.emit({
            type: "indexer:error",
            path: "<reference-repair>",
            phase: "watcher-reference-repair",
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.running = null;
          if (this.all || this.paths.size) this.schedule(5000);
        });
    }, delay);
  }

  private async flush(): Promise<void> {
    while (!this.stopped && (this.all || this.paths.size)) {
      const paths = this.all ? undefined : new Set(this.paths);
      this.all = false;
      this.paths.clear();
      await this.reconcile(paths);
    }
  }

  /** Awaited during startup, before buffered structural indexing is admitted.
   * Persisted invalidation survives shutdown between discovering and repairing. */
  async reconcile(only?: ReadonlySet<string>): Promise<void> {
    const universe = (await listNotePaths(this.options.db)).filter(
      (path) => !this.options.isExcluded(path),
    );
    let cursor: RecordId<"note"> | undefined;
    do {
      const [rows] = await this.options.db
        .query<[ReferenceRow[]]>(
          `SELECT id, path, reference_targets FROM note
           WHERE tombstoned_at = NONE AND tier1_at != NONE
             AND ($cursor = NONE OR id > $cursor)
             AND ($paths = NONE OR path IN $paths)
           ORDER BY id LIMIT 128 TIMEOUT 2s;`,
          { cursor, paths: only ? [...only] : undefined },
        )
        .collect();
      for (const row of rows) await this.reconsider(row, universe);
      if (rows.length < 128) break;
      cursor = rows.at(-1)?.id;
    } while (!this.stopped);
  }

  private async reconsider(row: ReferenceRow, universe: string[]): Promise<void> {
    if (!(row.id instanceof RecordId) || !isCanonicalPublicNotePath(row.path))
      throw new Error("reference repair found an invalid note identity");
    if (this.options.isExcluded(row.path)) return;
    let changed = true;
    try {
      const refs = referenceTargetsSchema.parse(JSON.parse(row.reference_targets ?? "null"));
      changed = refs.some(
        (ref) => resolveReferenceTarget(row.path, ref, universe) !== ref.resolved,
      );
    } catch {
      // An absent/invalid derived receipt is repaired from Markdown, never
      // interpreted as a reason to discard authored data or semantic history.
    }
    if (!changed) return;
    // A concurrent parse can replace the receipt; never clear its newer value.
    const [updated] = await this.options.db
      .query<[Array<{ id: RecordId<"note"> }>]>(
        `UPDATE $id SET tier1_at = NONE
         WHERE path = $path AND tombstoned_at = NONE
           AND reference_targets = $receipt RETURN AFTER;`,
        { id: row.id, path: row.path, receipt: row.reference_targets },
      )
      .collect();
    if (!updated.length) return;
    invalidateVaultPathUniverse();
    this.options.readiness?.invalidatePath(row.path);
    this.options.enqueue(row.path);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.off?.();
    this.off = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    this.all = false;
    this.paths.clear();
  }
}
