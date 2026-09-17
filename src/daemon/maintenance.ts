import type { BackgroundRegistry } from "../core/awaken/backgroundRegistry";
import type { Coordinator } from "../core/coordinator/coordinator";
import type { IndexerQueue } from "../core/indexer/indexerQueue";
import type { AgentEventStore } from "../core/services/agentEventStore";
import type { SentienceActivity } from "../core/services/sentienceActivity";
import type { NonBlockingApprovalTracker } from "./handlers/nonBlockingApproval";
import type { VaultMarkdownSnapshot, VaultWatcher } from "./watcher";

export type MaintenanceOperation = "backup" | "restore";

export interface DaemonMaintenanceDependencies {
  watcher: Pick<
    VaultWatcher,
    | "start"
    | "stop"
    | "drain"
    | "capturePublicSnapshot"
    | "reconcileSnapshotChanges"
    | "rebuildPublicSnapshot"
  >;
  activity: Pick<SentienceActivity, "start" | "stop">;
  coordinator: Pick<Coordinator, "start" | "stop" | "idle">;
  indexer: Pick<IndexerQueue, "pause" | "resume" | "drain">;
  chatService: { drain(): Promise<void> };
  agentEventStore: Pick<AgentEventStore, "drain">;
  awakenWorkers: Pick<BackgroundRegistry, "size">;
  nonBlockingApprovals: Pick<NonBlockingApprovalTracker, "pauseAndDrain" | "resume">;
  settleBootstrapWork(): Promise<void>;
}

export interface MaintenanceEndOptions {
  rebuildAllMarkdown?: boolean;
}

export class MaintenanceBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceBusyError";
  }
}

/**
 * The maintenance connection is not a general-purpose privileged channel.
 * Its only data operation is restore reconciliation, and that operation must
 * remain fenced until every daemon-owned writer has actually quiesced.
 */
export function canRunMaintenanceOwnerMethod(
  method: string,
  maintenance: Pick<DaemonMaintenanceController, "operation" | "poisoned" | "ready">,
): boolean {
  if (maintenance.poisoned) return method === "daemon.shutdown";
  if (method === "maintenance.end") return true;
  if (method === "daemon.shutdown") return true;
  if (method === "maintenance.poison") {
    return maintenance.operation === "restore" && maintenance.ready;
  }
  return method === "links.sync" && maintenance.operation === "restore" && maintenance.ready;
}

/**
 * Quiesce every daemon-owned producer while a privileged graph backup or
 * restore operates through SurrealDB's separate HTTP/CLI connection.
 */
export class DaemonMaintenanceController {
  private activeOperation: MaintenanceOperation | null = null;
  private readyForOwnerWork = false;
  private poisonedRestore = false;
  private initialVaultSnapshot: VaultMarkdownSnapshot | null = null;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: DaemonMaintenanceDependencies) {}

  get operation(): MaintenanceOperation | null {
    return this.activeOperation;
  }

  get ready(): boolean {
    return this.readyForOwnerWork;
  }

  get poisoned(): boolean {
    return this.poisonedRestore;
  }

  begin(operation: MaintenanceOperation): Promise<void> {
    return this.enqueueTransition(() => this.beginNow(operation));
  }

  end(options: MaintenanceEndOptions = {}): Promise<{ vaultChanged: boolean }> {
    return this.enqueueTransition(() => this.endNow(options));
  }

  poison(): Promise<void> {
    return this.enqueueTransition(async () => {
      if (this.activeOperation !== "restore" || !this.readyForOwnerWork) {
        throw new Error("only a ready restore lease can poison maintenance");
      }
      this.readyForOwnerWork = false;
      this.poisonedRestore = true;
    });
  }

  private async beginNow(operation: MaintenanceOperation): Promise<void> {
    if (this.activeOperation !== null) {
      throw new MaintenanceBusyError(
        `daemon maintenance is already running: ${this.activeOperation}`,
      );
    }
    if (this.dependencies.awakenWorkers.size() > 0) {
      throw new MaintenanceBusyError(
        "daemon maintenance requires all background awaken workers to finish or be cancelled",
      );
    }

    this.activeOperation = operation;
    this.readyForOwnerWork = false;
    this.poisonedRestore = false;
    try {
      const parkedApprovals = await this.dependencies.nonBlockingApprovals.pauseAndDrain();
      if (parkedApprovals > 0) {
        throw new MaintenanceBusyError(
          `daemon maintenance requires ${parkedApprovals} pending write approval(s) to be resolved`,
        );
      }
      this.dependencies.activity.stop();
      this.dependencies.coordinator.stop();

      // Startup reconciliation and embedding repair are process-owned writers
      // that may outlive bootstrap. Let them settle before closing indexer
      // admission, then drain every producer admitted before the RPC fence.
      await this.dependencies.settleBootstrapWork();
      await this.dependencies.chatService.drain();
      await this.dependencies.coordinator.idle();
      await this.dependencies.indexer.drain();
      await this.dependencies.agentEventStore.drain();

      // Chokidar remains active while admitted internal writers settle. Close
      // it only across two equal exact snapshots; otherwise replay the gap,
      // drain indexing, and try again. The snapshot returned here is the
      // actual maintenance generation.
      this.initialVaultSnapshot = await this.stopWatcherAtStableSnapshot();
      this.dependencies.indexer.pause();
      await this.dependencies.indexer.drain();
      await this.dependencies.agentEventStore.drain();

      if (this.dependencies.awakenWorkers.size() > 0) {
        throw new MaintenanceBusyError("a background awaken worker appeared during maintenance");
      }
      this.readyForOwnerWork = true;
    } catch (error) {
      await this.endNow().catch(() => {});
      throw error;
    }
  }

  private async endNow(options: MaintenanceEndOptions = {}): Promise<{ vaultChanged: boolean }> {
    if (this.activeOperation === null) return { vaultChanged: false };
    if (this.poisonedRestore) {
      throw new Error("poisoned restore maintenance can only be recovered by daemon shutdown");
    }
    if (options.rebuildAllMarkdown === true && this.activeOperation !== "restore") {
      throw new Error("full Markdown rebuild is valid only after a rolled-back restore");
    }
    this.readyForOwnerWork = false;

    // The restore owner may have replayed approval intents through links.sync
    // while the lease was held. Fence those final writes before producers are
    // reopened to ordinary RPC and watcher activity.
    await this.dependencies.chatService.drain();
    await this.dependencies.coordinator.idle();
    await this.dependencies.indexer.drain();
    await this.dependencies.agentEventStore.drain();

    const beforeWatch = await this.dependencies.watcher.capturePublicSnapshot();

    this.dependencies.indexer.resume();
    try {
      await this.dependencies.watcher.start();
      const afterWatch = await this.dependencies.watcher.capturePublicSnapshot();
      const baseline = this.initialVaultSnapshot ?? beforeWatch;
      const vaultChanged =
        snapshotsDiffer(baseline, beforeWatch) || snapshotsDiffer(beforeWatch, afterWatch);
      if (options.rebuildAllMarkdown === true) {
        this.dependencies.watcher.rebuildPublicSnapshot(afterWatch);
      } else if (snapshotsDiffer(baseline, afterWatch)) {
        await this.dependencies.watcher.reconcileSnapshotChanges(baseline, afterWatch);
      }
      await this.dependencies.watcher.drain();
      await this.dependencies.indexer.drain();
      await this.dependencies.agentEventStore.drain();
      await this.dependencies.activity.start();
      this.dependencies.coordinator.start();
      this.dependencies.nonBlockingApprovals.resume();
      this.activeOperation = null;
      this.initialVaultSnapshot = null;
      this.poisonedRestore = false;
      return { vaultChanged };
    } catch (error) {
      this.dependencies.indexer.pause();
      throw error;
    }
  }

  private enqueueTransition<T>(action: () => Promise<T>): Promise<T> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => {});
    return next;
  }

  private async stopWatcherAtStableSnapshot(): Promise<VaultMarkdownSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.dependencies.watcher.capturePublicSnapshot();
      await this.dependencies.watcher.stop();
      const after = await this.dependencies.watcher.capturePublicSnapshot();
      if (!snapshotsDiffer(before, after)) return after;

      await this.dependencies.watcher.start();
      await this.dependencies.watcher.reconcileSnapshotChanges(before, after);
      await this.dependencies.watcher.drain();
      await this.dependencies.indexer.drain();
      await this.dependencies.agentEventStore.drain();
    }
    throw new MaintenanceBusyError(
      "Markdown kept changing while daemon maintenance tried to establish its snapshot",
    );
  }
}

function snapshotsDiffer(left: VaultMarkdownSnapshot, right: VaultMarkdownSnapshot): boolean {
  if (left.size !== right.size) return true;
  for (const [path, sha] of left) {
    if (right.get(path) !== sha) return true;
  }
  return false;
}
