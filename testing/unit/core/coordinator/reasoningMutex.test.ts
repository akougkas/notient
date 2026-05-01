import { describe, expect, test } from "bun:test";
import { ReasoningMutex } from "../../../../src/core/coordinator/reasoningMutex";

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

  test("runs up to the configured slot count concurrently", async () => {
    const m = new ReasoningMutex({ maxConcurrent: 2 });
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

  test("priority acquisition uses a free slot without aborting background work", async () => {
    const m = new ReasoningMutex({ maxConcurrent: 2 });
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

  test("abort cancels the running job with the matching label", async () => {
    const m = new ReasoningMutex();
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
