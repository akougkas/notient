import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";

describe("ReasoningScheduler", () => {
  test("rejects invalid slot capacities instead of repairing them", () => {
    for (const maxConcurrent of [0, 1.5, 129, Number.NaN]) {
      expect(() => new ReasoningScheduler({ maxConcurrent })).toThrow(
        "maxConcurrent must be an integer between 1 and 128",
      );
    }
  });

  test("serializes normal acquisitions when configured with one slot", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const order: string[] = [];
    await Promise.all([
      m.run("a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      m.run("b", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("runs nested normal and priority work inline under one owned slot", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    const result = await scheduler.run("outer", async (outerSignal) => {
      events.push("outer-start");
      const nested = await scheduler.run("inner", async (innerSignal) => {
        expect(innerSignal).toBe(outerSignal);
        events.push("inner");
        return 20;
      });
      const priority = await scheduler.runPriority("inner-priority", async (innerSignal) => {
        expect(innerSignal).toBe(outerSignal);
        events.push("inner-priority");
        return 22;
      });
      events.push("outer-end");
      return nested + priority;
    });

    expect(result).toBe(42);
    expect(events).toEqual(["outer-start", "inner", "inner-priority", "outer-end"]);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("serializes parallel first-level children within one owner slot", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    let active = 0;
    let peak = 0;

    await scheduler.run("outer", async () => {
      await Promise.all(
        [1, 2, 3].map((index) =>
          scheduler.run(`child-${index}`, async () => {
            active += 1;
            peak = Math.max(peak, active);
            events.push(`${index}-start`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            events.push(`${index}-end`);
            active -= 1;
          }),
        ),
      );
    });

    expect(peak).toBe(1);
    expect(events).toEqual(["1-start", "1-end", "2-start", "2-end", "3-start", "3-end"]);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("never exceeds the global cap across owners with parallel child batches", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 2 });
    const activeByOwner = new Map<string, number>();
    const peakByOwner = new Map<string, number>();
    let globalActive = 0;
    let globalPeak = 0;

    await Promise.all(
      ["owner-a", "owner-b"].map((ownerLabel) =>
        scheduler.run(ownerLabel, async () => {
          await Promise.all(
            [1, 2, 3].map((index) =>
              scheduler.run(`${ownerLabel}:child-${index}`, async () => {
                const ownerActive = (activeByOwner.get(ownerLabel) ?? 0) + 1;
                activeByOwner.set(ownerLabel, ownerActive);
                peakByOwner.set(
                  ownerLabel,
                  Math.max(peakByOwner.get(ownerLabel) ?? 0, ownerActive),
                );
                globalActive += 1;
                globalPeak = Math.max(globalPeak, globalActive);
                await new Promise((resolve) => setTimeout(resolve, 5));
                globalActive -= 1;
                activeByOwner.set(ownerLabel, ownerActive - 1);
              }),
            ),
          );
        }),
      ),
    );

    expect(globalPeak).toBe(2);
    expect(peakByOwner).toEqual(
      new Map([
        ["owner-a", 1],
        ["owner-b", 1],
      ]),
    );
    expect(scheduler.isBusy()).toBe(false);
  });

  test("rejects recursive normal and priority acquisitions from an owned child", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const grandchildRan: string[] = [];

    await scheduler.run("outer", async () => {
      for (const priority of [false, true]) {
        const child = scheduler.run(`child-${String(priority)}`, async () => {
          const acquire = priority
            ? scheduler.runPriority.bind(scheduler)
            : scheduler.run.bind(scheduler);
          await acquire("grandchild", async () => {
            grandchildRan.push("unexpected");
          });
        });
        await expect(child).rejects.toMatchObject({
          name: "ReasoningSchedulerReentrancyError",
          message:
            "ReasoningScheduler cannot acquire 'grandchild' recursively from an owned child task",
        });
      }
    });

    expect(grandchildRan).toEqual([]);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("keeps the owner slot until detached nested work settles", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    let markChildStarted: (() => void) | undefined;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const outer = scheduler.run("outer", async () => {
      events.push("outer-start");
      void scheduler.run("detached", async () => {
        events.push("child-start");
        markChildStarted?.();
        await childGate;
        events.push("child-end");
      });
      events.push("outer-return");
    });
    await childStarted;
    const queued = scheduler.run("queued", async () => {
      events.push("queued");
    });
    await Promise.resolve();
    expect(events).toEqual(["outer-start", "outer-return", "child-start"]);

    releaseChild?.();
    await Promise.all([outer, queued]);
    expect(events).toEqual(["outer-start", "outer-return", "child-start", "child-end", "queued"]);
  });

  test("a nested caller signal aborts only its owned child work", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const caller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const result = scheduler.run("outer", async (outerSignal) => {
      try {
        await scheduler.run(
          "inner",
          async (innerSignal) => {
            expect(innerSignal).not.toBe(outerSignal);
            markStarted?.();
            await rejectOnAbort(innerSignal);
          },
          { signal: caller.signal },
        );
        return "unexpected";
      } catch (error) {
        expect((error as Error).name).toBe("AbortError");
        expect(outerSignal.aborted).toBe(false);
        return "outer-survived";
      }
    });

    await started;
    caller.abort();
    await expect(result).resolves.toBe("outer-survived");
  });

  test("a queued child aborts promptly without cancelling the active child", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const caller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let queuedRan = false;

    await scheduler.run("outer", async () => {
      let activeSignal: AbortSignal | undefined;
      const active = scheduler.run("active", async (signal) => {
        activeSignal = signal;
        markStarted?.();
        await activeGate;
      });
      await started;
      const queued = scheduler.run(
        "queued-child",
        async () => {
          queuedRan = true;
        },
        { signal: caller.signal },
      );

      caller.abort();
      await expect(queued).rejects.toMatchObject({ name: "AbortError" });
      expect(activeSignal?.aborted).toBe(false);
      releaseActive?.();
      await active;
    });

    expect(queuedRan).toBe(false);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("aborting an owner propagates into its nested reasoning call", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let nestedAborted = false;
    const result = scheduler.run("outer", async () =>
      scheduler.run("inner", async (signal) => {
        markStarted?.();
        try {
          await rejectOnAbort(signal);
        } catch (error) {
          nestedAborted = signal.aborted;
          throw error;
        }
      }),
    );

    await started;
    scheduler.abort("outer");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(nestedAborted).toBe(true);
  });

  test("runs up to the configured slot count concurrently", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 2 });
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all([
      m.run("a", async () => {
        active++;
        peak = Math.max(peak, active);
        events.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        events.push("a-end");
        active--;
      }),
      m.run("b", async () => {
        active++;
        peak = Math.max(peak, active);
        events.push("b-start");
        await new Promise((r) => setTimeout(r, 30));
        events.push("b-end");
        active--;
      }),
      m.run("c", async () => {
        active++;
        peak = Math.max(peak, active);
        events.push("c-start");
        events.push("c-end");
        active--;
      }),
    ]);
    expect(peak).toBe(2);
    expect(events.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
    expect(events).toContain("c-start");
  });

  test("priority acquisition aborts the in-flight low-priority job", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    const slow = m.run("agent", async (signal) => {
      events.push("agent-start");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("agent-aborted");
          reject(new DOMException("aborted", "AbortError"));
        });
        setTimeout(() => {
          events.push("agent-finished");
          resolve();
        }, 200);
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    await m.runPriority("foreground", async () => {
      events.push("foreground-ran");
    });
    await slow.catch(() => {
      // expected to throw on abort
    });
    expect(events).toEqual(["agent-start", "agent-aborted", "foreground-ran"]);
  });

  test("priority acquisition uses a free slot without aborting background work", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 2 });
    const events: string[] = [];
    const agent = m.run("agent", async (signal) => {
      events.push("agent-start");
      signal.addEventListener("abort", () => {
        events.push("agent-aborted");
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push("agent-finished");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await m.runPriority("chat", async () => {
      events.push("chat-ran");
    });
    await agent;
    expect(events).toEqual(["agent-start", "chat-ran", "agent-finished"]);
  });

  test("priority acquisition with no in-flight job runs immediately", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const flag = { hit: false };
    await m.runPriority("foreground", async () => {
      flag.hit = true;
    });
    expect(flag.hit).toBe(true);
  });

  test("chat preempts other priority work and both outcomes surface", async () => {
    // Last-priority-wins invariant: a chat slot taken while another priority
    // job is running aborts that job's signal. Both outcomes surface to
    // any subscriber draining the same array.
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    const foreground = m.runPriority("foreground", async (signal) => {
      events.push("foreground-start");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("foreground-aborted");
          reject(new DOMException("aborted", "AbortError"));
        });
        // Long enough that chat's runPriority will arrive first.
        setTimeout(() => {
          events.push("foreground-finished");
          resolve();
        }, 200);
      });
    });
    // Yield once so foreground work actually starts before chat takes priority.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await m.runPriority("chat", async () => {
      events.push("chat-start");
      events.push("chat-end");
    });
    await foreground.catch(() => {
      // expected: the preempted job rejects on abort
    });
    expect(events).toEqual(["foreground-start", "foreground-aborted", "chat-start", "chat-end"]);
  });

  test("caller signal aborts a queued task", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const blocker = m.run("a", async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(m.run("b", async () => {}, { signal: ctrl.signal })).rejects.toThrow();
    await blocker;
  });

  test("abort cancels the running job with the matching label", async () => {
    const m = new ReasoningScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    const chat = m.run("chat", async (signal) => {
      events.push("chat-start");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("chat-aborted");
          reject(new DOMException("aborted", "AbortError"));
        });
        setTimeout(resolve, 200);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.abort("chat");
    await chat.catch(() => {
      // expected to throw on abort
    });
    expect(events).toEqual(["chat-start", "chat-aborted"]);
  });
});

async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

test("queued owners and serialized children preserve their caller's asynchronous context", async () => {
  const context = new AsyncLocalStorage<string>();
  const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
  const values: string[] = [];
  await Promise.all(
    ["first", "second"].map((label) =>
      context.run(label, () =>
        scheduler.run(label, async () => {
          expect(context.getStore()).toBe(label);
          await Promise.all(
            ["a", "b"].map((child) =>
              context.run(`${label}-${child}`, () =>
                scheduler.run(child, async () => {
                  await Bun.sleep(5);
                  values.push(context.getStore() ?? "missing");
                }),
              ),
            ),
          );
          expect(context.getStore()).toBe(label);
        }),
      ),
    ),
  );
  expect(values).toEqual(["first-a", "first-b", "second-a", "second-b"]);
});
