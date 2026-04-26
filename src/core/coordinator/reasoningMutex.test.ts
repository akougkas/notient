import { describe, expect, test } from "bun:test";
import { ReasoningMutex } from "./reasoningMutex";

describe("ReasoningMutex", () => {
  test("serializes two normal acquisitions", async () => {
    const m = new ReasoningMutex();
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

  test("priority acquisition aborts the in-flight low-priority job", async () => {
    const m = new ReasoningMutex();
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
    await m.runPriority("co-author", async () => {
      events.push("co-author-ran");
    });
    await slow.catch(() => {
      // expected to throw on abort
    });
    expect(events).toEqual(["agent-start", "agent-aborted", "co-author-ran"]);
  });

  test("priority acquisition with no in-flight job runs immediately", async () => {
    const m = new ReasoningMutex();
    const flag = { hit: false };
    await m.runPriority("co-author", async () => {
      flag.hit = true;
    });
    expect(flag.hit).toBe(true);
  });

  test("caller signal aborts a queued task", async () => {
    const m = new ReasoningMutex();
    const blocker = m.run("a", async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(m.run("b", async () => {}, { signal: ctrl.signal })).rejects.toThrow();
    await blocker;
  });
});
