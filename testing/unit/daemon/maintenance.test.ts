import { describe, expect, test } from "bun:test";
import {
  DaemonMaintenanceController,
  MaintenanceBusyError,
  canRunMaintenanceOwnerMethod,
} from "../../../src/daemon/maintenance";

describe("DaemonMaintenanceController", () => {
  test("quiesces and resumes every daemon-owned graph producer in strict order", async () => {
    const order: string[] = [];
    const controller = new DaemonMaintenanceController({
      watcher: {
        stop: async () => {
          order.push("watcher.stop");
        },
        start: async () => {
          order.push("watcher.start");
        },
        drain: async () => {
          order.push("watcher.drain");
        },
        capturePublicSnapshot: async () => {
          order.push("watcher.snapshot");
          return new Map();
        },
        reconcileSnapshotChanges: async () => {
          order.push("watcher.reconcile");
        },
        rebuildPublicSnapshot: () => {
          order.push("watcher.rebuild");
        },
      },
      activity: {
        stop: () => order.push("activity.stop"),
        start: async () => {
          order.push("activity.start");
        },
      },
      coordinator: {
        stop: () => order.push("coordinator.stop"),
        idle: async () => {
          order.push("coordinator.idle");
        },
        start: () => order.push("coordinator.start"),
      },
      indexer: {
        pause: () => order.push("indexer.pause"),
        drain: async () => {
          order.push("indexer.drain");
        },
        resume: () => order.push("indexer.resume"),
      },
      chatService: {
        drain: async () => {
          order.push("chat.drain");
        },
      },
      agentEventStore: {
        drain: async () => {
          order.push("events.drain");
        },
      },
      awakenWorkers: { size: () => 0 },
      nonBlockingApprovals: {
        pauseAndDrain: async () => {
          order.push("approvals.pauseAndDrain");
          return 0;
        },
        resume: () => order.push("approvals.resume"),
      },
      settleBootstrapWork: async () => {
        order.push("bootstrap.settle");
      },
    });

    await controller.begin("backup");
    expect(controller.operation).toBe("backup");
    expect(controller.ready).toBe(true);
    await controller.end();
    expect(controller.operation).toBeNull();
    expect(controller.ready).toBe(false);
    expect(order).toEqual([
      "approvals.pauseAndDrain",
      "activity.stop",
      "coordinator.stop",
      "bootstrap.settle",
      "chat.drain",
      "coordinator.idle",
      "indexer.drain",
      "events.drain",
      "watcher.snapshot",
      "watcher.stop",
      "watcher.snapshot",
      "indexer.pause",
      "indexer.drain",
      "events.drain",
      "chat.drain",
      "coordinator.idle",
      "indexer.drain",
      "events.drain",
      "watcher.snapshot",
      "indexer.resume",
      "watcher.start",
      "watcher.snapshot",
      "watcher.drain",
      "indexer.drain",
      "events.drain",
      "activity.start",
      "coordinator.start",
      "approvals.resume",
    ]);
  });

  test("refuses maintenance while a detached awaken worker owns graph writes", async () => {
    const controller = new DaemonMaintenanceController({
      watcher: {
        stop: async () => {},
        start: async () => {},
        drain: async () => {},
        capturePublicSnapshot: async () => new Map(),
        reconcileSnapshotChanges: async () => {},
        rebuildPublicSnapshot: () => {},
      },
      activity: { stop: () => {}, start: async () => {} },
      coordinator: { stop: () => {}, start: () => {}, idle: async () => {} },
      indexer: { pause: () => {}, resume: () => {}, drain: async () => {} },
      chatService: { drain: async () => {} },
      agentEventStore: { drain: async () => {} },
      awakenWorkers: { size: () => 1 },
      nonBlockingApprovals: { pauseAndDrain: async () => 0, resume: () => {} },
      settleBootstrapWork: async () => {},
    });

    await expect(controller.begin("restore")).rejects.toBeInstanceOf(MaintenanceBusyError);
    expect(controller.operation).toBeNull();
  });

  test("detects and reconciles added, edited, and deleted Markdown before release", async () => {
    const baseline = new Map([
      ["same.md", "same"],
      ["edited.md", "old"],
      ["deleted.md", "gone"],
    ]);
    const changed = new Map([
      ["same.md", "same"],
      ["edited.md", "new"],
      ["added.md", "added"],
    ]);
    const snapshots = [baseline, baseline, changed, changed];
    const reconciliations: Array<{
      before: ReadonlyMap<string, string>;
      after: ReadonlyMap<string, string>;
    }> = [];
    const controller = new DaemonMaintenanceController({
      watcher: {
        stop: async () => {},
        start: async () => {},
        drain: async () => {},
        capturePublicSnapshot: async () => snapshots.shift() ?? changed,
        reconcileSnapshotChanges: async (before, after) => {
          reconciliations.push({ before, after });
        },
        rebuildPublicSnapshot: () => {},
      },
      activity: { stop: () => {}, start: async () => {} },
      coordinator: { stop: () => {}, start: () => {}, idle: async () => {} },
      indexer: { pause: () => {}, resume: () => {}, drain: async () => {} },
      chatService: { drain: async () => {} },
      agentEventStore: { drain: async () => {} },
      awakenWorkers: { size: () => 0 },
      nonBlockingApprovals: { pauseAndDrain: async () => 0, resume: () => {} },
      settleBootstrapWork: async () => {},
    });

    await controller.begin("backup");
    const result = await controller.end();

    expect(result).toEqual({ vaultChanged: true });
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]?.before).toBe(baseline);
    expect(reconciliations[0]?.after).toBe(changed);
  });

  test("serializes owner disconnect cleanup behind an in-flight begin", async () => {
    let releaseBootstrap = (): void => {};
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const order: string[] = [];
    const controller = new DaemonMaintenanceController({
      watcher: {
        stop: async () => {
          order.push("watcher.stop");
        },
        start: async () => {
          order.push("watcher.start");
        },
        drain: async () => {},
        capturePublicSnapshot: async () => new Map(),
        reconcileSnapshotChanges: async () => {},
        rebuildPublicSnapshot: () => {},
      },
      activity: { stop: () => {}, start: async () => {} },
      coordinator: { stop: () => {}, start: () => {}, idle: async () => {} },
      indexer: { pause: () => {}, resume: () => {}, drain: async () => {} },
      chatService: { drain: async () => {} },
      agentEventStore: { drain: async () => {} },
      awakenWorkers: { size: () => 0 },
      nonBlockingApprovals: { pauseAndDrain: async () => 0, resume: () => {} },
      settleBootstrapWork: async () => {
        order.push("bootstrap.wait");
        await bootstrapGate;
        order.push("bootstrap.done");
      },
    });

    const beginning = controller.begin("restore");
    while (!order.includes("bootstrap.wait")) await Promise.resolve();
    expect(controller.ready).toBe(false);
    expect(canRunMaintenanceOwnerMethod("links.sync", controller)).toBe(false);
    expect(canRunMaintenanceOwnerMethod("maintenance.end", controller)).toBe(true);
    const disconnectCleanup = controller.end();
    await Promise.resolve();
    expect(order).toEqual(["bootstrap.wait"]);

    releaseBootstrap();
    await Promise.all([beginning, disconnectCleanup]);
    expect(order).toContain("bootstrap.done");
    expect(order.at(-1)).toBe("watcher.start");
    expect(controller.operation).toBeNull();
    expect(controller.ready).toBe(false);
  });

  test("allows reconciliation only for a fully quiesced restore owner", async () => {
    expect(
      canRunMaintenanceOwnerMethod("links.sync", {
        operation: "restore",
        poisoned: false,
        ready: false,
      }),
    ).toBe(false);
    expect(
      canRunMaintenanceOwnerMethod("links.sync", {
        operation: "restore",
        poisoned: false,
        ready: true,
      }),
    ).toBe(true);
    expect(
      canRunMaintenanceOwnerMethod("links.sync", {
        operation: "backup",
        poisoned: false,
        ready: true,
      }),
    ).toBe(false);
    expect(
      canRunMaintenanceOwnerMethod("links.sync", {
        operation: null,
        poisoned: false,
        ready: false,
      }),
    ).toBe(false);

    let rebuilds = 0;
    const controller = new DaemonMaintenanceController({
      watcher: {
        stop: async () => {},
        start: async () => {},
        drain: async () => {},
        capturePublicSnapshot: async () => new Map(),
        reconcileSnapshotChanges: async () => {},
        rebuildPublicSnapshot: () => {
          rebuilds += 1;
        },
      },
      activity: { stop: () => {}, start: async () => {} },
      coordinator: { stop: () => {}, start: () => {}, idle: async () => {} },
      indexer: { pause: () => {}, resume: () => {}, drain: async () => {} },
      chatService: { drain: async () => {} },
      agentEventStore: { drain: async () => {} },
      awakenWorkers: { size: () => 0 },
      nonBlockingApprovals: { pauseAndDrain: async () => 0, resume: () => {} },
      settleBootstrapWork: async () => {},
    });

    await controller.begin("backup");
    expect(controller.ready).toBe(true);
    expect(canRunMaintenanceOwnerMethod("links.sync", controller)).toBe(false);
    await controller.end();
    expect(canRunMaintenanceOwnerMethod("links.sync", controller)).toBe(false);

    await controller.begin("restore");
    await controller.poison();
    expect(controller.poisoned).toBe(true);
    expect(controller.ready).toBe(false);
    expect(canRunMaintenanceOwnerMethod("links.sync", controller)).toBe(false);
    expect(canRunMaintenanceOwnerMethod("maintenance.end", controller)).toBe(false);
    expect(canRunMaintenanceOwnerMethod("daemon.shutdown", controller)).toBe(true);
    await expect(controller.end({ rebuildAllMarkdown: true })).rejects.toThrow(
      "can only be recovered by daemon shutdown",
    );
    expect(rebuilds).toBe(0);
    expect(controller.operation).toBe("restore");
    expect(controller.poisoned).toBe(true);
  });
});
