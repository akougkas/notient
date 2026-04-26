import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
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

  test("skips notes below minWords", async () => {
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
    bus.on("coAuthor:done", () => fired.push("done"));
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
    expect(fired).toEqual([]);
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
