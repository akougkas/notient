import { describe, expect, test } from "bun:test";
import { AwakenBackgroundRegistry } from "../../../../src/core/awaken/backgroundRegistry";

describe("AwakenBackgroundRegistry", () => {
  test("size starts at zero", () => {
    const registry = new AwakenBackgroundRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.pendingPromises()).toHaveLength(0);
  });

  test("start tracks the canonical completion until it resolves", async () => {
    const registry = new AwakenBackgroundRegistry();
    let resolveWorker: (value: number) => void = () => {
      throw new Error("resolveWorker not assigned");
    };
    const completion = registry.start(
      () =>
        new Promise<number>((resolve) => {
          resolveWorker = resolve;
        }),
    );
    if (completion === null) throw new Error("worker was unexpectedly refused");

    expect(registry.size()).toBe(1);
    expect(registry.pendingPromises()).toEqual([completion]);

    await Promise.resolve();
    resolveWorker(42);
    await completion;
    await Promise.resolve();
    expect(registry.size()).toBe(0);
    expect(registry.pendingPromises()).toHaveLength(0);
  });

  test("a rejected completion is removed without changing its rejection", async () => {
    const registry = new AwakenBackgroundRegistry();
    const failure = new Error("boom");
    let rejectWorker: (error: unknown) => void = () => {
      throw new Error("rejectWorker not assigned");
    };
    const completion = registry.start(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectWorker = reject;
        }),
    );
    if (completion === null) throw new Error("worker was unexpectedly refused");
    const observed = completion.catch((error) => error);

    await Promise.resolve();
    rejectWorker(failure);
    expect(await observed).toBe(failure);
    await Promise.resolve();
    expect(registry.size()).toBe(0);
  });

  test("a synchronous worker factory throw becomes the tracked rejection", async () => {
    const registry = new AwakenBackgroundRegistry();
    const failure = new Error("factory boom");
    const completion = registry.start(() => {
      throw failure;
    });
    if (completion === null) throw new Error("worker was unexpectedly refused");

    expect(registry.pendingPromises()).toEqual([completion]);
    await expect(completion).rejects.toBe(failure);
    await registry.drain();
    expect(registry.size()).toBe(0);
  });

  test("pendingPromises returns a defensive snapshot", async () => {
    const registry = new AwakenBackgroundRegistry();
    const resolvers: Array<() => void> = [];
    const first = registry.start(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const second = registry.start(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    if (first === null || second === null) throw new Error("worker was unexpectedly refused");

    const snapshot = registry.pendingPromises();
    expect(snapshot).toHaveLength(2);
    await Promise.resolve();
    for (const resolve of resolvers) resolve();
    await Promise.all([first, second]);
    await Promise.resolve();

    expect(snapshot).toHaveLength(2);
    expect(registry.size()).toBe(0);
  });

  test("stop aborts and drain awaits every worker before refusing new admission", async () => {
    const registry = new AwakenBackgroundRegistry();
    const order: string[] = [];
    const completion = registry.start(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              order.push("worker.abort");
              queueMicrotask(() => {
                order.push("worker.settle");
                resolve();
              });
            },
            { once: true },
          );
        }),
    );
    if (completion === null) throw new Error("worker was unexpectedly refused");

    await Promise.resolve();
    registry.stop();
    const draining = registry.drain().then(() => {
      order.push("registry.drained");
    });
    expect(registry.start(async () => {})).toBeNull();
    expect(order).toEqual(["worker.abort"]);

    await Promise.all([completion, draining]);
    expect(order).toEqual(["worker.abort", "worker.settle", "registry.drained"]);
    expect(registry.size()).toBe(0);
  });

  test("stop before the factory microtask prevents the worker from starting", async () => {
    const registry = new AwakenBackgroundRegistry();
    let invoked = false;
    const completion = registry.start(async () => {
      invoked = true;
    });
    if (completion === null) throw new Error("worker was unexpectedly refused");

    registry.stop();
    await Promise.allSettled([completion]);
    await registry.drain();

    expect(invoked).toBe(false);
    expect(registry.size()).toBe(0);
  });
});
