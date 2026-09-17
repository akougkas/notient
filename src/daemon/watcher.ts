import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { DateTime, RecordId } from "surrealdb";
import { FsVault } from "../adapters/fsVault";
import type { ApprovalService } from "../core/approvals/approvalService";
import { type SurrealConnection, createNote, lookupNoteByPath } from "../core/db/surreal";
import type { EventBus } from "../core/events/eventBus";
import { invalidateVaultPathUniverse } from "../core/indexer/indexNote";
import type { IndexReadiness } from "../core/indexer/indexReadiness";
import { purgeNoteGraph, tombstoneNoteByPath } from "../core/indexer/purgeNote";
import { ReferenceRepair } from "../core/indexer/referenceRepair";
import { STRUCTURAL_INDEX_VERSION } from "../core/markdown/types";
import type { SentienceActivity } from "../core/services/sentienceActivity";
import type { DaemonMutationJournal } from "../core/vault/daemonMutationJournal";
import { isCanonicalPublicNotePath } from "../core/vault/publicPath";

export interface VaultWatcherOptions {
  readiness?: IndexReadiness;
  root: string;
  enqueue: (vaultRelativePath: string) => void;
  /** Override polling decision (true = always poll, false = always inotify). */
  forcePolling?: boolean;
  pollingInterval?: number;
  /** Canonical substrate for edit stamps, tombstones, renames, and cascades. */
  surrealDb: SurrealConnection;
  /** Emits lifecycle changes and reports watcher-side substrate failures. */
  bus: EventBus;
  /** Sole authority for human focus and idle-cognition epochs. */
  activity: Pick<SentienceActivity, "recordHumanActivity" | "recordDeletion">;
  /** Distinguishes daemon-authored file mutations from human edits. */
  mutationJournal: Pick<DaemonMutationJournal, "matchesWrite" | "matchesRemoval">;
  /** Owns durable supersession of approvals touching a deleted note. */
  approvalIntents: Pick<ApprovalService, "cancelForNoteDeletion">;
  /** Override tombstone window for tests (default 60_000 ms). */
  tombstoneWindowMs?: number;
  /** Delay before retrying a failed graph cascade (default 5 seconds). */
  cascadeRetryMs?: number;
  /**
   * Vault-relative paths for which the watcher does nothing at all.
   * Built from `settings.indexer.excludePaths` / `excludeGlobs` in
   * bootstrap. Without it the watcher re-indexed Notient's own
   * conversation transcripts the moment the chat service wrote them.
   */
  isExcluded: (vaultPath: string) => boolean;
}

export type VaultMarkdownSnapshot = ReadonlyMap<string, string>;

const DEFAULT_TOMBSTONE_WINDOW_MS = 60_000;
const DEFAULT_CASCADE_RETRY_MS = 5_000;

function remainingTombstoneWindow(windowMs: number, tombstonedAt: DateTime): number {
  const age = Date.now() - tombstonedAt.toDate().getTime();
  return Math.min(windowMs, Math.max(0, windowMs - age));
}

interface CascadeTombstone {
  noteId: RecordId<"note">;
  path: string;
  tombstonedAt: DateTime;
}

interface ScheduledCascade extends CascadeTombstone {
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Mirrors the initial scan in `src/adapters/fsVault.ts`, which skips every
 * dot-prefixed directory. Without this the watcher would index notes that
 * Obsidian moves into `.trash/`, and nothing would ever remove them because
 * the scan never sees those paths again.
 */
export function isIgnoredVaultSegment(vaultRelativePath: string): boolean {
  const segments = vaultRelativePath.split(/[\\/]/);
  return segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

async function sha256Body(absolutePath: string): Promise<string> {
  const buffer = await readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export class VaultWatcher {
  private admissionBuffer: Set<string> | null = null;
  private enqueue(path: string): void {
    if (this.admissionBuffer) this.admissionBuffer.add(path);
    else this.options.enqueue(path);
  }
  private watcher: FSWatcher | null = null;
  private readonly cascadeTimers = new Map<string, ScheduledCascade>();
  private readonly eventTurns = new Map<string, Promise<void>>();
  private readonly backgroundWork = new Set<Promise<void>>();
  private tombstoneRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingHumanStamps = new Set<string>();
  private acceptingCascades = false;
  private offNoteSaved: (() => void) | null = null;
  private readonly options: VaultWatcherOptions;
  private readonly liveVault: Pick<FsVault, "exists" | "listMarkdown" | "read">;
  private readonly referenceRepair: ReferenceRepair;

  constructor(options: VaultWatcherOptions) {
    if (options.surrealDb === undefined || options.surrealDb === null) {
      throw new Error("VaultWatcher requires the SurrealDB substrate");
    }
    if (options.bus === undefined || options.bus === null) {
      throw new Error("VaultWatcher requires the canonical event bus");
    }
    if (options.activity === undefined || options.activity === null) {
      throw new Error("VaultWatcher requires sentience activity");
    }
    if (options.mutationJournal === undefined || options.mutationJournal === null) {
      throw new Error("VaultWatcher requires the daemon mutation journal");
    }
    if (options.approvalIntents === undefined || options.approvalIntents === null) {
      throw new Error("VaultWatcher requires the approval-intent cancellation authority");
    }
    if (typeof options.isExcluded !== "function") {
      throw new Error("VaultWatcher requires the canonical exclusion predicate");
    }
    this.options = options;
    this.liveVault = new FsVault(options.root);
    this.referenceRepair = new ReferenceRepair({
      db: options.surrealDb.db,
      bus: options.bus,
      readiness: options.readiness,
      enqueue: (path) => this.enqueue(path),
      isExcluded: options.isExcluded,
    });
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    this.options.readiness?.beginScan();
    this.admissionBuffer = new Set();
    this.offNoteSaved = this.options.bus.on("vault:note-saved", (event) => {
      if (!this.pendingHumanStamps.delete(event.path)) return;
      this.trackBackground(this.markUserEdit(event.path));
    });
    const usePolling = this.options.forcePolling ?? isWslPath(this.options.root);
    this.watcher = chokidar.watch(this.options.root, {
      ignoreInitial: true,
      usePolling,
      interval: this.options.pollingInterval ?? 1000,
      ignored: (path) => isIgnoredVaultSegment(relative(this.options.root, path)),
    });
    this.acceptingCascades = true;
    const onChange = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = this.toVaultPath(absolutePath);
      if (this.isExcluded(vaultPath)) return;
      this.options.readiness?.observe(vaultPath, null);
      void this.withEventTurn(vaultPath, () => this.handleChange(vaultPath, absolutePath));
    };
    const onAdd = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = this.toVaultPath(absolutePath);
      if (this.isExcluded(vaultPath)) return;
      this.options.readiness?.observe(vaultPath, null);
      void this.withEventTurn(vaultPath, () => this.handleAdd(vaultPath, absolutePath));
    };
    const onUnlink = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = this.toVaultPath(absolutePath);
      if (this.isExcluded(vaultPath)) return;
      if (!this.options.mutationJournal.matchesRemoval(vaultPath)) {
        this.options.activity.recordDeletion(vaultPath);
      }
      this.options.readiness?.observe(vaultPath, null);
      void this.withEventTurn(vaultPath, () => this.handleUnlink(vaultPath));
    };
    this.watcher.on("add", onAdd);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", onUnlink);
    await new Promise<void>((resolve, reject) => {
      const watcher = this.watcher;
      if (!watcher) {
        resolve();
        return;
      }
      watcher.once("ready", () => resolve());
      watcher.once("error", reject);
    });
    try {
      await this.reconcileStoredNotes();
      this.referenceRepair.start();
      await this.referenceRepair.reconcile();
      const admitted = this.admissionBuffer;
      this.admissionBuffer = null;
      for (const path of admitted ?? []) this.enqueue(path);
    } catch (error) {
      await this.stop();
      throw error;
    }
    await this.recoverTombstoneCascades().catch((error) => {
      this.reportFailure("<tombstone-recovery>", "watcher-cascade-recovery", error);
      this.scheduleTombstoneRecovery();
    });
  }

  /** Watch callbacks are installed before the ready barrier and remain active
   * throughout the scan. Replays read current bytes and serialize per path;
   * an unlink rechecks live existence before leaving a tombstone behind. */
  private async reconcileStoredNotes(): Promise<void> {
    const [rows] = await this.options.surrealDb.db
      .query<
        [Array<{ path: string; sha: string; tier1_at?: unknown; structural_version?: number }>]
      >("SELECT path, sha, tier1_at, structural_version FROM note WHERE tombstoned_at = NONE;")
      .collect<
        [Array<{ path: string; sha: string; tier1_at?: unknown; structural_version?: number }>]
      >();
    const stored = new Map<string, string>();
    const incomplete = new Set<string>();
    for (const row of rows) {
      if (!isCanonicalPublicNotePath(row.path) || typeof row.sha !== "string") {
        throw new Error("startup reconciliation found an invalid indexed note identity");
      }
      stored.set(row.path, row.sha);
      if (row.tier1_at == null || row.structural_version !== STRUCTURAL_INDEX_VERSION)
        incomplete.add(row.path);
    }
    const current = await this.capturePublicSnapshot();
    await this.reconcileSnapshotChanges(stored, current);
    // Parser upgrades and interrupted indexing are repairs of derived state.
    // They must not fabricate human edit times or authorize AI change triggers.
    for (const path of incomplete) {
      const revision = current.get(path);
      if (revision !== undefined && stored.get(path) === revision) {
        this.options.readiness?.observe(path, revision);
        this.enqueue(path);
      }
      stored.delete(path);
    }
    this.options.readiness?.finishScan(current, stored);
  }

  private toVaultPath(absolutePath: string): string {
    return relative(this.options.root, absolutePath).split(sep).join(posix.sep);
  }

  private isExcluded(vaultPath: string): boolean {
    return this.options.isExcluded(vaultPath);
  }

  async stop(): Promise<void> {
    this.options.readiness?.pause();
    this.admissionBuffer = null;
    this.acceptingCascades = false;
    if (this.tombstoneRecoveryTimer !== null) {
      clearTimeout(this.tombstoneRecoveryTimer);
      this.tombstoneRecoveryTimer = null;
    }
    for (const cascade of this.cascadeTimers.values()) {
      clearTimeout(cascade.timer);
    }
    this.cascadeTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.drain();
    await this.referenceRepair.stop();
    // An add callback already admitted by chokidar can append a pending human
    // stamp while close/drain is in progress. Clear only after those callbacks
    // have settled so a later watcher generation cannot consume stale state.
    this.pendingHumanStamps.clear();
    this.offNoteSaved?.();
    this.offNoteSaved = null;
  }

  /** Wait for every watcher-owned database mutation that has already begun. */
  async drain(): Promise<void> {
    while (this.eventTurns.size > 0 || this.backgroundWork.size > 0) {
      await Promise.allSettled([...this.eventTurns.values(), ...this.backgroundWork]);
    }
  }

  /** Exact public Markdown identity used to close maintenance watcher gaps. */
  async capturePublicSnapshot(): Promise<VaultMarkdownSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snapshot = new Map<string, string>();
        const files = (await this.liveVault.listMarkdown())
          .map((entry) => entry.path)
          .filter((path) => !this.isExcluded(path))
          .sort((left, right) => left.localeCompare(right));
        for (const path of files) {
          const body = await this.liveVault.read(path);
          snapshot.set(path, createHash("sha256").update(body).digest("hex"));
        }
        return snapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 2) throw error;
      }
    }
    throw new Error("watcher snapshot failed after bounded retries");
  }

  /**
   * Replay filesystem changes that occurred while chokidar was stopped. The
   * normal per-path handlers preserve rename windows, human-edit stamps,
   * approval cancellation, tombstones, and canonical indexer admission.
   */
  async reconcileSnapshotChanges(
    before: VaultMarkdownSnapshot,
    after: VaultMarkdownSnapshot,
  ): Promise<void> {
    const removed = [...before.keys()]
      .filter((path) => !after.has(path))
      .sort((left, right) => left.localeCompare(right));
    const added = [...after.keys()]
      .filter((path) => !before.has(path))
      .sort((left, right) => left.localeCompare(right));
    const changed = [...after.keys()]
      .filter((path) => before.has(path) && before.get(path) !== after.get(path))
      .sort((left, right) => left.localeCompare(right));

    for (const path of removed) {
      this.options.activity.recordDeletion(path);
      await this.withEventTurn(path, () => this.handleUnlink(path));
    }
    for (const path of added) {
      const absolutePath = join(this.options.root, ...path.split("/"));
      await this.withEventTurn(path, () => this.handleAdd(path, absolutePath));
    }
    for (const path of changed) {
      const absolutePath = join(this.options.root, ...path.split("/"));
      await this.withEventTurn(path, () => this.handleChange(path, absolutePath));
    }
  }

  /**
   * Rebuild a deliberately emptied graph from canonical Markdown without
   * attributing every existing note as a new human edit.
   */
  rebuildPublicSnapshot(snapshot: VaultMarkdownSnapshot): void {
    this.options.readiness?.invalidate();
    for (const path of [...snapshot.keys()].sort((left, right) => left.localeCompare(right))) {
      this.options.readiness?.observe(path, snapshot.get(path) ?? null);
      this.enqueue(path);
    }
  }

  private async handleChange(vaultPath: string, absolutePath: string): Promise<void> {
    try {
      const sha = await sha256Body(absolutePath);
      this.options.readiness?.observe(vaultPath, sha);
      if (!this.options.mutationJournal.matchesWrite(vaultPath, sha)) {
        this.options.activity.recordHumanActivity({ source: "vault:change", notePath: vaultPath });
        await this.markUserEdit(vaultPath);
      }
      this.enqueue(vaultPath);
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-change-read", error);
    }
  }

  private async handleAdd(vaultPath: string, absolutePath: string): Promise<void> {
    let sha: string;
    try {
      sha = await sha256Body(absolutePath);
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-add-read", error);
      return;
    }
    this.options.readiness?.observe(vaultPath, sha);
    const daemonAuthored = this.options.mutationJournal.matchesWrite(vaultPath, sha);
    const renamedFrom = await this.tryDetectRename(vaultPath, sha);
    if (!daemonAuthored) {
      if (renamedFrom === null) {
        this.options.activity.recordHumanActivity({ source: "vault:add", notePath: vaultPath });
      } else {
        this.options.activity.recordHumanActivity({ source: "vault:rename", notePath: vaultPath });
      }
      this.pendingHumanStamps.add(vaultPath);
    }
    // Discover identity before admitting Tier 1. Initial scan admissions are
    // buffered until every target exists, so links do not depend on queue order.
    try {
      if ((await lookupNoteByPath(this.options.surrealDb.db, vaultPath)) === null) {
        await createNote(this.options.surrealDb.db, { path: vaultPath, sha, wordCount: 0 });
      }
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-add-read", error);
      return;
    }
    invalidateVaultPathUniverse();
    this.referenceRepair.request();
    this.enqueue(vaultPath);
  }

  /**
   * Stamps `note.last_user_edit_at` when the operator saves a file.
   *
   * The column is read by the maturity advancer, the vitals service, the
   * search date filters and the sentient drawer,
   * but nothing wrote it, so every one of those consumers was reading a
   * permanently empty field. Existing notes are stamped before reindexing.
   * New human-authored notes and human renames are stamped after Tier 1 emits
   * `vault:note-saved`, because no `note` row exists when chokidar first sees
   * the file. Daemon-authored mutations still reindex, but never claim human
   * attention.
   */
  private async markUserEdit(vaultPath: string): Promise<void> {
    try {
      await this.options.surrealDb.db
        .query("UPDATE note SET last_user_edit_at = time::now() WHERE path = $path;", {
          path: vaultPath,
        })
        .collect();
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-edit-stamp", error);
    }
  }

  private async handleUnlink(vaultPath: string): Promise<void> {
    let tombstonePersisted = false;
    let cascadeDelay: number | undefined;
    let cascade: CascadeTombstone | null = null;
    try {
      const tombstone = await tombstoneNoteByPath(this.options.surrealDb, vaultPath);
      if (tombstone === null) {
        this.options.readiness?.removed(vaultPath);
        return;
      }
      cascade = { ...tombstone, path: vaultPath };
      tombstonePersisted = true;
      this.options.bus.emit({ type: "indexer:tombstoned", path: vaultPath });
      this.referenceRepair.request();
      if (!this.isExcluded(vaultPath) && (await this.livePublicNoteExists(vaultPath))) {
        await this.clearSamePathTombstone(vaultPath, tombstone.tombstonedAt);
        tombstonePersisted = false;
        this.options.readiness?.observe(
          vaultPath,
          await sha256Body(join(this.options.root, vaultPath)),
        );
        this.enqueue(vaultPath);
        return;
      }
      this.options.readiness?.removed(vaultPath);
      const window = this.options.tombstoneWindowMs ?? DEFAULT_TOMBSTONE_WINDOW_MS;
      cascadeDelay = remainingTombstoneWindow(window, tombstone.tombstonedAt);
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-tombstone", error);
    } finally {
      if (tombstonePersisted && cascade !== null) this.scheduleCascade(cascade, cascadeDelay);
    }
  }

  /** Chokidar callbacks for one path must commit in the order emitted. */
  private async withEventTurn(vaultPath: string, action: () => Promise<void>): Promise<void> {
    const previous = this.eventTurns.get(vaultPath);
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.eventTurns.set(vaultPath, current);
    if (previous !== undefined) await previous;
    try {
      await action();
    } finally {
      release();
      if (this.eventTurns.get(vaultPath) === current) this.eventTurns.delete(vaultPath);
    }
  }

  /**
   * Timers are process-local; tombstones are not. Rebuild every outstanding
   * cascade from the original database timestamp on start so a restart cannot
   * strand deleted graph state or extend the rename window.
   */
  private async recoverTombstoneCascades(): Promise<void> {
    const [rows] = await this.options.surrealDb.db
      .query<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>(
        "SELECT id, path, tombstoned_at FROM note WHERE tombstoned_at != NONE;",
      )
      .collect<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>();
    const window = this.options.tombstoneWindowMs ?? DEFAULT_TOMBSTONE_WINDOW_MS;
    for (const row of rows) {
      if (typeof row.path !== "string" || row.path.length === 0) {
        this.reportFailure(
          "<tombstone-recovery>",
          "watcher-cascade-recovery",
          new Error("stored tombstone has an invalid path"),
        );
        continue;
      }
      if (!(row.id instanceof RecordId) || row.id.table.name !== "note") {
        this.reportFailure(
          row.path,
          "watcher-cascade-recovery",
          new Error("stored tombstone has an invalid note id"),
        );
        continue;
      }
      if (!(row.tombstoned_at instanceof DateTime)) {
        this.reportFailure(
          row.path,
          "watcher-cascade-recovery",
          new Error("stored tombstone has an invalid timestamp"),
        );
        this.scheduleTombstoneRecovery();
        continue;
      }
      if (!this.isExcluded(row.path) && (await this.livePublicNoteExists(row.path))) {
        await this.clearSamePathTombstone(row.path, row.tombstoned_at);
        this.options.activity.recordHumanActivity({
          source: "vault:add",
          notePath: row.path,
        });
        await this.markUserEdit(row.path);
        this.enqueue(row.path);
        continue;
      }
      this.scheduleCascade(
        { noteId: row.id, path: row.path, tombstonedAt: row.tombstoned_at },
        remainingTombstoneWindow(window, row.tombstoned_at),
      );
    }
  }

  private scheduleTombstoneRecovery(): void {
    if (!this.acceptingCascades || this.tombstoneRecoveryTimer !== null) return;
    const timer = setTimeout(() => {
      this.tombstoneRecoveryTimer = null;
      this.trackBackground(
        this.recoverTombstoneCascades().catch((error) => {
          this.reportFailure("<tombstone-recovery>", "watcher-cascade-recovery", error);
          this.scheduleTombstoneRecovery();
        }),
      );
    }, this.options.cascadeRetryMs ?? DEFAULT_CASCADE_RETRY_MS);
    timer.unref?.();
    this.tombstoneRecoveryTimer = timer;
  }

  private scheduleCascade(cascade: CascadeTombstone, delay?: number): void {
    if (!this.acceptingCascades) return;
    const window = delay ?? this.options.tombstoneWindowMs ?? DEFAULT_TOMBSTONE_WINDOW_MS;
    const previous = this.cascadeTimers.get(cascade.path);
    if (previous !== undefined) {
      if (previous.tombstonedAt.toString() > cascade.tombstonedAt.toString()) return;
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
      if (this.cascadeTimers.get(cascade.path)?.timer !== timer) return;
      this.cascadeTimers.delete(cascade.path);
      this.trackBackground(this.runCascade(cascade));
    }, window);
    timer.unref?.();
    this.cascadeTimers.set(cascade.path, { ...cascade, timer });
  }

  private async runCascade(cascade: CascadeTombstone): Promise<void> {
    try {
      if (!this.isExcluded(cascade.path) && (await this.livePublicNoteExists(cascade.path))) {
        const revived = await this.clearSamePathTombstone(cascade.path, cascade.tombstonedAt);
        if (revived) this.enqueue(cascade.path);
        return;
      }
      await purgeNoteGraph(
        this.options.surrealDb,
        cascade.noteId,
        cascade.tombstonedAt,
        this.options.approvalIntents,
      );
    } catch (error) {
      this.reportFailure(cascade.path, "watcher-cascade", error);
      this.scheduleCascade(cascade, this.options.cascadeRetryMs ?? DEFAULT_CASCADE_RETRY_MS);
    }
  }

  private trackBackground(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => this.backgroundWork.delete(work));
  }

  private async tryDetectRename(vaultPath: string, bodySha: string): Promise<string | null> {
    try {
      if (await this.clearSamePathTombstone(vaultPath)) return null;
      // Tombstone window is enforced server-side by comparing
      // tombstoned_at against a JS-computed threshold (now - windowMs).
      // The cascade timer is still the cleanup mechanism but is no longer
      // the sole window enforcer; a stale tombstone the cascade missed
      // (daemon restart, overloaded event loop) cannot resurrect a fresh
      // file with a matching SHA.
      const window = this.options.tombstoneWindowMs ?? DEFAULT_TOMBSTONE_WINDOW_MS;
      const threshold = new Date(Date.now() - window);
      const [rows] = await this.options.surrealDb.db
        .query<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>(
          "SELECT id, path, tombstoned_at FROM note WHERE sha = $sha AND tombstoned_at != NONE AND tombstoned_at > $threshold ORDER BY tombstoned_at DESC, path ASC LIMIT 1;",
          { sha: bodySha, threshold },
        )
        .collect<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>();
      const match = rows[0];
      if (match === undefined || match.path === vaultPath) {
        return null;
      }
      if (
        !(match.id instanceof RecordId) ||
        match.id.table.name !== "note" ||
        !(match.tombstoned_at instanceof DateTime)
      ) {
        throw new Error("watcher storage integrity: rename candidate is malformed");
      }
      const [claimed] = await this.options.surrealDb.db
        .query<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>(
          "UPDATE $id SET path = $path, tombstoned_at = NONE WHERE path = $fromPath AND sha = $sha AND tombstoned_at = $tombstonedAt RETURN BEFORE;",
          {
            id: match.id,
            path: vaultPath,
            fromPath: match.path,
            sha: bodySha,
            tombstonedAt: match.tombstoned_at,
          },
        )
        .collect<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>();
      if (claimed.length > 1) {
        throw new Error("watcher storage integrity: rename claimed multiple notes");
      }
      const claim = claimed[0];
      if (claim === undefined) return null;
      if (
        !(claim.id instanceof RecordId) ||
        claim.id.toString() !== match.id.toString() ||
        claim.path !== match.path ||
        !(claim.tombstoned_at instanceof DateTime) ||
        claim.tombstoned_at.toString() !== match.tombstoned_at.toString()
      ) {
        throw new Error("watcher storage integrity: rename claim returned a different generation");
      }
      const fromPath = claim.path;
      this.options.bus.emit({ type: "indexer:renamed", fromPath, toPath: vaultPath });
      const cascade = this.cascadeTimers.get(fromPath);
      if (
        cascade !== undefined &&
        cascade.tombstonedAt.toString() === claim.tombstoned_at.toString()
      ) {
        clearTimeout(cascade.timer);
        this.cascadeTimers.delete(fromPath);
      }
      return fromPath;
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-rename", error);
      return null;
    }
  }

  /** A present same-path file wins over a persisted deletion tombstone. */
  private async clearSamePathTombstone(
    vaultPath: string,
    expectedTombstonedAt?: DateTime,
  ): Promise<boolean> {
    const predicate =
      expectedTombstonedAt === undefined
        ? "tombstoned_at != NONE"
        : "tombstoned_at = $expectedTombstonedAt";
    const [rows] = await this.options.surrealDb.db
      .query<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>(
        `UPDATE note SET tombstoned_at = NONE WHERE path = $path AND ${predicate} RETURN BEFORE;`,
        { path: vaultPath, expectedTombstonedAt },
      )
      .collect<[Array<{ id: RecordId<"note">; path: string; tombstoned_at: DateTime }>]>();
    if (rows.length > 1) {
      throw new Error("watcher storage integrity: same-path revival updated multiple notes");
    }
    const revived = rows[0];
    if (revived === undefined) return false;
    if (!(revived.id instanceof RecordId) || revived.id.table.name !== "note") {
      throw new Error("watcher storage integrity: same-path revival returned an invalid note id");
    }
    if (revived.path !== vaultPath) {
      throw new Error("watcher storage integrity: same-path revival returned a different path");
    }
    if (!(revived.tombstoned_at instanceof DateTime)) {
      throw new Error("watcher storage integrity: same-path revival returned an invalid token");
    }
    const cascade = this.cascadeTimers.get(vaultPath);
    if (
      cascade !== undefined &&
      cascade.tombstonedAt.toString() === revived.tombstoned_at.toString()
    ) {
      clearTimeout(cascade.timer);
      this.cascadeTimers.delete(vaultPath);
    }
    return true;
  }

  private async livePublicNoteExists(vaultPath: string): Promise<boolean> {
    if (!isCanonicalPublicNotePath(vaultPath)) {
      this.reportFailure(
        vaultPath,
        "watcher-live-path",
        new Error("stored tombstone path is not a canonical public Markdown note"),
      );
      return false;
    }
    try {
      return await this.liveVault.exists(vaultPath);
    } catch (error) {
      this.reportFailure(vaultPath, "watcher-live-path", error);
      return false;
    }
  }

  private reportFailure(vaultPath: string, phase: string, error: unknown): void {
    this.options.bus.emit({
      type: "indexer:error",
      path: vaultPath,
      phase,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function isWslPath(path: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path);
}
