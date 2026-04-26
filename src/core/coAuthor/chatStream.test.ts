import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { LMStudioProvider } from "../llm/lmStudioProvider";
import type { LLMProvider } from "../llm/provider";
import { CoAuthorService } from "./chatStream";

function streamProvider(parts: string[]): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      for (const p of parts) yield p;
    },
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
  };
}

describe("CoAuthorService", () => {
  test("emits section deltas as the model streams", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    const events: Array<{ section: string; delta: string }> = [];
    bus.on("coAuthor:section", (e) => events.push({ section: e.section, delta: e.delta }));
    let done = false;
    bus.on("coAuthor:done", () => {
      done = true;
    });
    const provider = streamProvider([
      "## SUMMARY\n",
      "A short take.\n",
      "## IMPLIES\n",
      "- one\n",
      "## CONNECTS\n",
      "- [[X]]: reason\n",
    ]);
    const service = new CoAuthorService({
      db,
      bus,
      provider,
      reasoningModel: "nemotron",
      readNote: async () => "# Active\nbody",
      neighbors: () => [{ path: "/n.md", title: "N", summary: "..." }],
      minWords: 50,
    });
    await service.runFor("/active.md", new AbortController().signal);
    expect(events.find((e) => e.section === "summary")?.delta).toContain("A short take");
    expect(events.find((e) => e.section === "implies")?.delta).toContain("one");
    expect(events.find((e) => e.section === "connects")?.delta).toContain("[[X]]");
    expect(done).toBe(true);
  });

  test("streams long notes even when the note has not been indexed yet", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const bus = new EventBus();
    const events: Array<{ section: string; delta: string }> = [];
    bus.on("coAuthor:section", (e) => events.push({ section: e.section, delta: e.delta }));
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["## SUMMARY\nThis unindexed note streams.\n"]),
      reasoningModel: "gemma",
      readNote: async () => `# Active\n${"word ".repeat(180)}`,
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/unindexed.md", new AbortController().signal);
    expect(events).toContainEqual({
      section: "summary",
      delta: "This unindexed note streams.\n",
    });
  });

  test("short notes emit an explicit done error instead of leaving the panel streaming", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const bus = new EventBus();
    const doneEvents: Array<{ ok: boolean; error?: string }> = [];
    bus.on("coAuthor:done", (event) => {
      doneEvents.push({ ok: event.ok, error: event.error });
    });
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["## SUMMARY\nshould not stream"]),
      reasoningModel: "gemma",
      readNote: async () => "# Short\nnot enough",
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/short.md", new AbortController().signal);
    expect(doneEvents[0]?.ok).toBe(false);
    expect(doneEvents[0]?.error).toContain("below Co-author minimum");
  });

  test("recognizes markdown section headers with different heading depth and casing", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    const events: Array<{ section: string; delta: string }> = [];
    bus.on("coAuthor:section", (e) => events.push({ section: e.section, delta: e.delta }));
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["### Summary\nFirst token.\n### Implies\n- next\n"]),
      reasoningModel: "gemma",
      readNote: async () => `# Active\n${"word ".repeat(180)}`,
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/active.md", new AbortController().signal);
    expect(events).toContainEqual({ section: "summary", delta: "First token.\n" });
    expect(events).toContainEqual({ section: "implies", delta: "- next\n" });
  });

  test("does not stream section deltas for notes below minWords", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/short.md", "s", 10, "raw", 1, 1],
    );
    const bus = new EventBus();
    const fired: string[] = [];
    bus.on("coAuthor:section", () => fired.push("section"));
    bus.on("coAuthor:done", (event) => fired.push(event.ok ? "done" : "error"));
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["nothing"]),
      reasoningModel: "nemotron",
      readNote: async () => "# Short",
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/short.md", new AbortController().signal);
    expect(fired).toEqual(["error"]);
  });

  test("emits coAuthor:done with ok:false when readNote throws so the panel exits the skeleton", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    const doneEvents: Array<{ ok: boolean; error?: string }> = [];
    bus.on("coAuthor:done", (event) => {
      doneEvents.push({ ok: event.ok, error: event.error });
    });
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["nope"]),
      reasoningModel: "gemma",
      readNote: async () => {
        throw new Error("file vanished mid-open");
      },
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/active.md", new AbortController().signal);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.ok).toBe(false);
    expect(doneEvents[0]?.error).toContain("file vanished mid-open");
  });

  test("emits coAuthor:done with ok:false when neighbors lookup throws (e.g., schema drift)", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    const doneEvents: Array<{ ok: boolean; error?: string }> = [];
    bus.on("coAuthor:done", (event) => {
      doneEvents.push({ ok: event.ok, error: event.error });
    });
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["nope"]),
      reasoningModel: "gemma",
      readNote: async () => `# Active\n${"word ".repeat(180)}`,
      neighbors: () => {
        throw new Error("no such column: approved");
      },
      minWords: 100,
    });
    await service.runFor("/active.md", new AbortController().signal);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.ok).toBe(false);
    expect(doneEvents[0]?.error).toContain("no such column: approved");
  });

  test("cancel propagates from CoAuthorService through LMStudioProvider to the SSE reader", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );

    const encoder = new TextEncoder();
    let cancelCalled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "## SUMMARY\n" } }] })}\n`,
            ),
          );
        }
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(stream, { status: 200 })) as unknown as typeof fetch;
    try {
      const bus = new EventBus();
      let cancelledNotePath: string | null = null;
      bus.on("coAuthor:cancelled", (event) => {
        cancelledNotePath = event.notePath;
      });
      const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
      const service = new CoAuthorService({
        db,
        bus,
        provider,
        reasoningModel: "gemma",
        readNote: async () => `# Active\n${"word ".repeat(180)}`,
        neighbors: () => [],
        minWords: 100,
      });
      const ctrl = new AbortController();
      const run = service.runFor("/active.md", ctrl.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      ctrl.abort();
      await run;
      expect(cancelCalled).toBe(true);
      expect(cancelledNotePath).toBe("/active.md");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("aborting cancels the stream and emits cancelled", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    let cancelled = false;
    bus.on("coAuthor:cancelled", () => {
      cancelled = true;
    });
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* (_messages, options) {
        for (let i = 0; i < 100; i++) {
          if (options.signal?.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield `chunk ${i}`;
        }
      },
      chatJson: async <T>() => ({}) as T,
      embed: async () => [],
    };
    const service = new CoAuthorService({
      db,
      bus,
      provider,
      reasoningModel: "nemotron",
      readNote: async () => `# Active\n${"x ".repeat(300)}`,
      neighbors: () => [],
      minWords: 50,
    });
    const ctrl = new AbortController();
    const run = service.runFor("/active.md", ctrl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await run;
    expect(cancelled).toBe(true);
  });
});
