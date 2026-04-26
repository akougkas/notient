import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { Coordinator } from "./coordinator";
import { ReasoningMutex } from "./reasoningMutex";
import type { Agent, AgentRunContext } from "./types";

function makeDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  return { adapter, config: { dbPath: "/db", wasmPath: "/wasm" } };
}

function fakeAgent(name: Agent["name"], proposals = 1, fail = false): Agent {
  return {
    name,
    usesReasoningModel: name !== "maturityAdvancer",
    async run(_context: AgentRunContext) {
      if (fail) throw new Error("boom");
      return { proposals };
    },
  };
}

describe("Coordinator", () => {
  test("vault-save triggers Linker on the saved note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run(context) {
        calls.push(`linker:${context.trigger}:${context.notePath ?? ""}`);
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "vault:note-saved", path: "/a.md", sha: "x" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["linker:vault-save:/a.md"]);
    const rows = db.query<{ agent: string; ok: number; proposals_count: number }>(
      "SELECT agent, ok, proposals_count FROM agent_runs;",
    );
    expect(rows).toEqual([{ agent: "linker", ok: 1, proposals_count: 1 }]);
  });

  test("idle-30s also runs Linker on the active note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run(context) {
        calls.push(`linker:${context.trigger}:${context.notePath ?? ""}`);
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.setActiveNote("/a.md");
    coord.start();
    bus.emit({ type: "user:idle", level: "30s" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["linker:idle-30s:/a.md"]);
  });

  test("idle-5m fans out to Synthesizer + ContradictionHunter", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const make = (name: Agent["name"]): Agent => ({
      name,
      usesReasoningModel: true,
      async run(context) {
        calls.push(`${name}:${context.trigger}`);
        return { proposals: 1 };
      },
    });
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0),
        synthesizer: make("synthesizer"),
        contradictionHunter: make("contradictionHunter"),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "user:idle", level: "5m" });
    await coord.idle();
    coord.stop();
    expect(calls.sort()).toEqual(["contradictionHunter:idle-5m", "synthesizer:idle-5m"]);
  });

  test("idle-30m runs Maturity Advancer (no mutex slot needed)", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const ma: Agent = {
      name: "maturityAdvancer",
      usesReasoningModel: false,
      async run(context) {
        calls.push(`ma:${context.trigger}`);
        return { proposals: 2 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0),
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: ma,
      },
    });
    coord.start();
    bus.emit({ type: "user:idle", level: "30m" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["ma:idle-30m"]);
  });

  test("user-action 'deepen' fires all four sequentially on a single note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const make = (name: Agent["name"], usesReasoning: boolean): Agent => ({
      name,
      usesReasoningModel: usesReasoning,
      async run(context) {
        calls.push(`${name}:${context.notePath}`);
        return { proposals: 1 };
      },
    });
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: make("linker", true),
        synthesizer: make("synthesizer", true),
        contradictionHunter: make("contradictionHunter", true),
        maturityAdvancer: make("maturityAdvancer", false),
      },
    });
    coord.start();
    bus.emit({ type: "user:action", kind: "deepen", notePath: "/x.md" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual([
      "linker:/x.md",
      "synthesizer:/x.md",
      "contradictionHunter:/x.md",
      "maturityAdvancer:/x.md",
    ]);
  });

  test("agent failure is recorded and does not crash the coordinator", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0, true),
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "vault:note-saved", path: "/a.md", sha: "x" });
    await coord.idle();
    coord.stop();
    const rows = db.query<{ agent: string; ok: number; error: string | null }>(
      "SELECT agent, ok, error FROM agent_runs;",
    );
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toContain("boom");
  });

  test("active typing suppresses idle dispatch", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run() {
        calls.push("linker");
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.setActiveNote("/a.md");
    coord.start();
    bus.emit({ type: "user:active" });
    bus.emit({ type: "user:idle", level: "30s" });
    bus.emit({ type: "user:active" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual([]);
  });
});
