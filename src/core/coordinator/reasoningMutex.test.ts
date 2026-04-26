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

  test("chat preempts a streaming co-author and both events surface", async () => {
    // Last-priority-wins invariant: a chat slot taken while co-author is
    // streaming aborts the co-author slot's signal. Both events surface to
    // any subscriber draining the same array.
    const m = new ReasoningMutex();
    const events: string[] = [];
    const coAuthor = m.runPriority("co-author", async (signal) => {
      events.push("co-author-start");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("co-author-aborted");
          reject(new DOMException("aborted", "AbortError"));
        });
        // Long enough that chat's runPriority will arrive first.
        setTimeout(() => {
          events.push("co-author-finished");
          resolve();
        }, 200);
      });
    });
    // Yield once so co-author actually starts before chat takes priority.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await m.runPriority("chat", async () => {
      events.push("chat-start");
      events.push("chat-end");
    });
    await coAuthor.catch(() => {
      // expected: co-author rejects on abort
    });
    expect(events).toEqual(["co-author-start", "co-author-aborted", "chat-start", "chat-end"]);
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
