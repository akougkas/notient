import { describe, expect, test } from "bun:test";
import { AwakenBackgroundRegistry } from "./backgroundRegistry";

describe("AwakenBackgroundRegistry", () => {
  test("size starts at zero", () => {
    const registry = new AwakenBackgroundRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.pendingPromises()).toHaveLength(0);
  });

  test("track adds the promise to the snapshot until it resolves", async () => {
    const registry = new AwakenBackgroundRegistry();
    let resolveFn: (value: number) => void = () => {
      throw new Error("resolveFn not assigned");
    };
    const promise = new Promise<number>((resolve) => {
      resolveFn = resolve;
    });
    registry.track(promise);
    expect(registry.size()).toBe(1);
    expect(registry.pendingPromises()).toHaveLength(1);

    resolveFn(42);
    await promise;
    // The `.finally` cleanup runs on a microtask boundary; flush it.
    await Promise.resolve();
    expect(registry.size()).toBe(0);
    expect(registry.pendingPromises()).toHaveLength(0);
  });

  test("track removes the entry when the tracked promise rejects", async () => {
    const registry = new AwakenBackgroundRegistry();
    const failure = new Error("boom");
    let rejectFn: (error: unknown) => void = () => {
      throw new Error("rejectFn not assigned");
    };
    const promise = new Promise<never>((_resolve, reject) => {
      rejectFn = reject;
    });
    // Attach the caller-side catch BEFORE `track` so the registry's
    // own `.finally` does not look like the only handler. Bun's
    // unhandled-rejection guard checks at the next microtask; we
    // must have a handler chain before then.
    const observed: unknown[] = [];
    promise.catch((error) => {
      observed.push(error);
    });
    registry.track(promise);
    rejectFn(failure);
    // Allow the rejection to propagate through the registry's cleanup
    // and the caller's catch.
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.size()).toBe(0);
    expect(observed).toEqual([failure]);
  });

  test("pendingPromises returns a defensive snapshot", async () => {
    const registry = new AwakenBackgroundRegistry();
    let resolveA: () => void = () => {
      throw new Error("resolveA not assigned");
    };
    let resolveB: () => void = () => {
      throw new Error("resolveB not assigned");
    };
    const promiseA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const promiseB = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    registry.track(promiseA);
    registry.track(promiseB);

    const snapshot = registry.pendingPromises();
    expect(snapshot).toHaveLength(2);

    resolveA();
    resolveB();
    await Promise.all(snapshot);
    await Promise.resolve();
    // The earlier snapshot is still length 2 even though the registry
    // emptied; mutating the registry must not retroactively shrink it.
    expect(snapshot).toHaveLength(2);
    expect(registry.size()).toBe(0);
  });

  test("multiple tracks of distinct promises accumulate and settle independently", async () => {
    const registry = new AwakenBackgroundRegistry();
    const resolvers: Array<() => void> = [];
    const promises: Promise<void>[] = [];
    for (let index = 0; index < 3; index += 1) {
      const promise = new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      promises.push(promise);
      registry.track(promise);
    }
    expect(registry.size()).toBe(3);

    resolvers[0]?.();
    await promises[0];
    await Promise.resolve();
    expect(registry.size()).toBe(2);

    resolvers[1]?.();
    resolvers[2]?.();
    await Promise.all([promises[1], promises[2]]);
    await Promise.resolve();
    expect(registry.size()).toBe(0);
  });
});
