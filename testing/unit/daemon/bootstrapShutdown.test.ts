import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { unwrapNativeValue } from "../../../src/core/db/nativeValue";
import { EventBus } from "../../../src/core/events/eventBus";
import { IndexerQueue } from "../../../src/core/indexer/indexerQueue";
import { AgentEventStore } from "../../../src/core/services/agentEventStore";
import { shutdownBootstrap } from "../../../src/daemon/bootstrap";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

describe("shutdownBootstrap", () => {
  test("drains held index and ledger work before closing Surreal in exact order", async () => {
    const order: string[] = [];
    const indexedPaths: string[] = [];
    const persistedPayloads: unknown[] = [];
    const repairGate = deferred();
    const reconciliationGate = deferred();
    const indexGate = deferred();
    const indexStarted = deferred();
    const ledgerGate = deferred();

    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          if (sql.startsWith("SELECT id FROM agent_event ORDER BY id DESC")) return [[]];
          order.push("ledger.write.start");
          await ledgerGate.promise;
          order.push("ledger.write.commit");
          persistedPayloads.push(unwrapNativeValue(bindings?.payload, "test event payload"));
          return [[], [{ id: bindings?.rowId, ts_ms: bindings?.tsMs }]];
        },
      }),
    } as unknown as Surreal;
    const bus = new EventBus();
    const ledger = new AgentEventStore({ db, bus, maxRows: 50_000 });
    const indexer = new IndexerQueue({
      bus,
      debounceMs: 0,
      indexNote: async (path) => {
        indexStarted.resolve();
        await indexGate.promise;
        indexedPaths.push(path);
        order.push("index.work.finish");
        bus.emit({
          type: "indexer:note-indexed",
          path,
          result: {
            chunkCount: 1,
            embedCount: 1,
            durationMs: 1,
            llmCalls: 0,
            extractionWindows: 0,
          },
        });
      },

      isExcluded: () => false,
    });
    indexer.enqueue("held.md");
    await indexStarted.promise;

    const closing = shutdownBootstrap({
      agentEventStore: {
        dispose: () => {
          order.push("ledger.dispose");
          ledger.dispose();
        },
        drain: async () => {
          order.push("ledger.drain");
          await ledger.drain();
          order.push("ledger.drained");
        },
      },
      approvalReconciliation: reconciliationGate.promise.then(() => {
        order.push("reconcile.complete");
      }),
      chatService: {
        drain: async () => {
          order.push("chat.drained");
        },
      },
      coordinator: {
        stop: () => order.push("coordinator.stop"),
        idle: async () => {
          order.push("coordinator.idle");
        },
      },
      embeddingRepair: {
        abort: () => order.push("repair.abort"),
        completion: repairGate.promise.then(() => {
          order.push("repair.complete");
        }),
      },
      health: { stop: () => order.push("health.stop") },
      sentienceActivity: { stop: () => order.push("sentience.stop") },
      indexer: {
        stopAccepting: () => {
          order.push("indexer.stopAccepting");
          indexer.stopAccepting();
        },
        drain: async () => {
          order.push("indexer.drain");
          await indexer.drain();
          order.push("indexer.drained");
        },
        dispose: () => {
          order.push("indexer.dispose");
          indexer.dispose();
        },
      },
      lockHandle: {
        release: async () => {
          order.push("lock.release");
        },
      },
      surrealConnection: {
        close: async () => {
          order.push("sdk.close");
        },
      },
      surrealHandle: {
        stop: async () => {
          order.push("child.stop");
        },
      },
    });

    // Producer admission closes synchronously, then shutdown blocks on the
    // embedding-repair fence. A late enqueue must not enter the queue.
    indexer.enqueue("late.md");
    expect(order).toEqual([
      "health.stop",
      "sentience.stop",
      "coordinator.stop",
      "indexer.stopAccepting",
      "repair.abort",
    ]);
    expect(order).not.toContain("sdk.close");

    repairGate.resolve();
    await waitUntil(() => order.includes("repair.complete"));
    expect(order).not.toContain("coordinator.idle");
    expect(order).not.toContain("sdk.close");

    reconciliationGate.resolve();
    await waitUntil(() => order.includes("indexer.drain"));
    expect(order).not.toContain("indexer.dispose");
    expect(order).not.toContain("sdk.close");

    indexGate.resolve();
    await waitUntil(() => order.includes("ledger.drain"));
    expect(order).not.toContain("ledger.drained");
    expect(order).not.toContain("sdk.close");
    // The ledger is unsubscribed while its first write is held. A later bus
    // event therefore cannot start a second database operation.
    bus.emit({ type: "indexer:tombstoned", path: "late.md" });

    ledgerGate.resolve();
    await closing;

    expect(indexedPaths).toEqual(["held.md"]);
    expect(persistedPayloads).toEqual([
      {
        path: "held.md",
        result: {
          chunkCount: 1,
          embedCount: 1,
          durationMs: 1,
          llmCalls: 0,
          extractionWindows: 0,
        },
      },
    ]);
    expect(order).toEqual([
      "health.stop",
      "sentience.stop",
      "coordinator.stop",
      "indexer.stopAccepting",
      "repair.abort",
      "repair.complete",
      "reconcile.complete",
      "chat.drained",
      "coordinator.idle",
      "indexer.drain",
      "index.work.finish",
      "ledger.write.start",
      "indexer.drained",
      "indexer.dispose",
      "ledger.dispose",
      "ledger.drain",
      "ledger.write.commit",
      "ledger.drained",
      "sdk.close",
      "child.stop",
      "lock.release",
    ]);
  });
});
