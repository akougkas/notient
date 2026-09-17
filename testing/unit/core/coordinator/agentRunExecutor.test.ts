import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  AgentRunExecutor,
  AgentRunIntegrityError,
} from "../../../../src/core/coordinator/agentRunExecutor";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import type { Agent } from "../../../../src/core/coordinator/types";
import { EventBus } from "../../../../src/core/events/eventBus";
import { Extractor } from "../../../../src/core/indexer/extractor";
import type { LLMProvider } from "../../../../src/core/llm/provider";

interface Finalization {
  runId: string;
  ok: boolean;
  proposals: number;
  error?: string;
}

class RunDb {
  readonly finalizations: Finalization[] = [];
  readonly createAttempts: string[] = [];
  readonly createdRunIds: string[] = [];
  creates = 0;
  createEnvelope: (created: StoredRun) => unknown = (created) => [
    undefined,
    createdRun(created),
    undefined,
    [{ ...created }],
  ];
  finalizeEnvelope: (finalized: StoredRun) => unknown = (finalized) => [[createdRun(finalized)]];
  allFinalizeIdsNative = true;
  private readonly rows = new Map<string, StoredRun>();

  constructor(private readonly beforeCreate?: (notePath: string) => Promise<void>) {}

  asSurreal(): Surreal {
    return {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => this.collect(sql, bindings ?? {}),
      }),
    } as unknown as Surreal;
  }

  private async collect(sql: string, bindings: Record<string, unknown>): Promise<unknown[]> {
    if (sql.includes("CREATE ONLY $rowId")) {
      const notePath = typeof bindings.notePath === "string" ? bindings.notePath : "";
      this.createAttempts.push(notePath);
      const runId = String(bindings.rowId);
      this.createdRunIds.push(runId);
      await this.beforeCreate?.(notePath);
      this.creates += 1;
      const created: StoredRun = {
        id: bindings.rowId as RecordId<"agent_run">,
        agent: bindings.agent,
        trigger: bindings.trigger,
        note_path: bindings.notePath,
        started_at: bindings.startedAt,
        finished_at: undefined,
        ok: undefined,
        error: undefined,
        proposals_count: 0,
      };
      this.rows.set(runId, created);
      return this.createEnvelope(created) as unknown[];
    }
    if (sql.startsWith("UPDATE $runId")) {
      this.allFinalizeIdsNative &&= isNativeAgentRunId(bindings.runId);
      const runId = String(bindings.runId);
      const pending = this.rows.get(runId);
      if (pending === undefined) throw new Error(`unknown run: ${runId}`);
      this.finalizations.push({
        runId,
        ok: bindings.ok as boolean,
        proposals: bindings.proposals as number,
        ...(typeof bindings.error === "string" ? { error: bindings.error } : {}),
      });
      const finalized: StoredRun = {
        ...pending,
        finished_at: bindings.finishedAt,
        ok: bindings.ok,
        error: bindings.error,
        proposals_count: bindings.proposals,
      };
      this.rows.set(runId, finalized);
      return this.finalizeEnvelope(finalized) as unknown[];
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

interface StoredRun {
  id: RecordId<"agent_run">;
  agent: unknown;
  trigger: unknown;
  note_path: unknown;
  started_at: unknown;
  finished_at: unknown;
  ok: unknown;
  error: unknown;
  proposals_count: unknown;
}

function createdRun(row: StoredRun): Record<string, unknown> {
  const { note_path: notePath, finished_at: finishedAt, ok, error, ...required } = row;
  return {
    ...required,
    ...(notePath === undefined ? {} : { note_path: notePath }),
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
    ...(ok === undefined ? {} : { ok }),
    ...(error === undefined ? {} : { error }),
  };
}

function isNativeAgentRunId(raw: unknown): raw is RecordId<"agent_run"> {
  return raw instanceof RecordId && raw.toString().startsWith('agent_run:u"');
}

function makeAgent(
  run: Agent["run"],
  usesReasoningModel = true,
): Agent & { readonly name: "linker" } {
  return { name: "linker", usesReasoningModel, run };
}

describe("AgentRunExecutor", () => {
  test("requires concrete runtime services and a clock", () => {
    const db = new RunDb();
    const bus = new EventBus();
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    expect(
      () =>
        new AgentRunExecutor({
          db: db.asSurreal(),
          bus,
          scheduler,
          now: undefined,
        } as never),
    ).toThrow(/clock/);
    expect(
      () =>
        new AgentRunExecutor({
          db: {} as Surreal,
          bus,
          scheduler,
          now: Date.now,
        }),
    ).toThrow(/SurrealDB/);
  });

  test("rejects non-canonical agents and requests before creating a row", async () => {
    const db = new RunDb();
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: Date.now,
    });
    expect(() =>
      executor.bind({ ...makeAgent(async () => ({ proposals: 0 })), name: "Linker" } as never),
    ).toThrow(/agent name/);
    const capability = executor.bind(makeAgent(async () => ({ proposals: 0 })));
    for (const request of [
      { trigger: "manual", notePath: "alpha.md" },
      { trigger: "vault-save", notePath: "/alpha.md" },
      { trigger: "vault-save", notePath: "../alpha.md" },
      { trigger: "vault-save", notePath: "alpha\\note.md" },
      { trigger: "vault-save", notePath: "alpha.md", signal: {} },
    ]) {
      await expect(capability.execute(request as never)).rejects.toBeInstanceOf(Error);
    }
    expect(db.creates).toBe(0);
  });

  test.each([
    ["missing statement", (row: StoredRun) => [undefined, row, undefined]],
    ["non-native BEGIN", (row: StoredRun) => [[], row, undefined, [row]]],
    ["array create guard", (row: StoredRun) => [undefined, [row], undefined, [row]]],
    ["empty SELECT", (row: StoredRun) => [undefined, row, undefined, []]],
    ["multi-row SELECT", (row: StoredRun) => [undefined, row, undefined, [row, row]]],
    ["projected NONE in create row", (row: StoredRun) => [undefined, row, undefined, [row]]],
  ])("fails closed for a malformed create envelope: %s", async (_label, envelope) => {
    const db = new RunDb();
    db.createEnvelope = envelope;
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: Date.now,
    });
    await expect(
      executor.bind(makeAgent(async () => ({ proposals: 0 }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toBeInstanceOf(AgentRunIntegrityError);
    expect(db.finalizations).toHaveLength(0);
  });

  test.each([
    ["string id", (row: StoredRun) => ({ ...row, id: row.id.toString() })],
    ["null NONE", (row: StoredRun) => ({ ...row, error: null })],
    ["wrong agent", (row: StoredRun) => ({ ...row, agent: "synthesizer" })],
    ["unsafe start", (row: StoredRun) => ({ ...row, started_at: Number.MAX_SAFE_INTEGER + 1 })],
    ["extra field", (row: StoredRun) => ({ ...row, legacy_run_id: row.id })],
  ])("fails closed for a malformed selected create row: %s", async (_label, mutate) => {
    const db = new RunDb();
    db.createEnvelope = (row) => [undefined, createdRun(row), undefined, [mutate(row)]];
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: Date.now,
    });
    await expect(
      executor.bind(makeAgent(async () => ({ proposals: 0 }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toBeInstanceOf(AgentRunIntegrityError);
  });

  test.each([
    ["missing statement", () => []],
    ["empty row slice", () => [[]]],
    ["multiple rows", (row: StoredRun) => [[row, row]]],
    ["null NONE", (row: StoredRun) => [[{ ...row, error: null }]]],
  ])("fails closed for a malformed finalize result: %s", async (_label, envelope) => {
    const db = new RunDb();
    db.finalizeEnvelope = envelope;
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
    await expect(
      executor.bind(makeAgent(async () => ({ proposals: 0 }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toBeInstanceOf(AgentRunIntegrityError);
    expect(db.allFinalizeIdsNative).toBe(true);
  });

  test.each([
    ["negative", { proposals: -1 }],
    ["fractional", { proposals: 1.5 }],
    ["unsafe", { proposals: Number.MAX_SAFE_INTEGER + 1 }],
    ["extra field", { proposals: 1, legacyCount: 1 }],
    ["missing", {}],
  ])("malformed agent result is finalized as a failed run: %s", async (_label, result) => {
    const db = new RunDb();
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
    await expect(
      executor.bind(makeAgent(async () => result as never)).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toThrow(/agent result/);
    expect(db.finalizations).toHaveLength(1);
    expect(db.finalizations[0]).toMatchObject({ ok: false, proposals: 0 });
  });

  test("rejects an invalid start but finalizes across backwards wall-clock adjustment", async () => {
    const badStartDb = new RunDb();
    const badStart = new AgentRunExecutor({
      db: badStartDb.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: () => Number.NaN,
    });
    await expect(
      badStart.bind(makeAgent(async () => ({ proposals: 0 }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toThrow(/start clock/);
    expect(badStartDb.creates).toBe(0);

    const backwardsDb = new RunDb();
    const readings = [100, 99];
    const elapsed = [10, 35];
    const backwardsBus = new EventBus();
    const durations: number[] = [];
    backwardsBus.on("agent:run-finished", (event) => durations.push(event.durationMs));
    const backwards = new AgentRunExecutor({
      db: backwardsDb.asSurreal(),
      bus: backwardsBus,
      monotonicNow: () => elapsed.shift() as number,
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: () => readings.shift() as number,
    });
    await expect(
      backwards.bind(makeAgent(async () => ({ proposals: 0 }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).resolves.toEqual({ proposals: 0 });
    expect(backwardsDb.finalizations).toHaveLength(1);
    expect(durations).toEqual([25]);
  });

  test("turns a non-Error rejection into one explicit failure without coercing it", async () => {
    const db = new RunDb();
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
    await expect(
      executor.bind(makeAgent(async () => Promise.reject({ legacy: "failure" }))).execute({
        trigger: "vault-save",
        notePath: "alpha.md",
      }),
    ).rejects.toThrow(/non-Error value/);
    expect(db.finalizations[0]?.error).toContain("non-Error value");
  });

  test("finalizes a failed run once, emits one lifecycle pair, and rethrows", async () => {
    const db = new RunDb();
    const bus = new EventBus();
    const lifecycle: Array<{ type: string; runId: string; ok?: boolean }> = [];
    bus.on("agent:run-started", (event) => lifecycle.push(event));
    bus.on("agent:run-finished", (event) => lifecycle.push(event));
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus,
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
    const runLinker = executor.bind(
      makeAgent(async () => {
        throw new Error("provider unavailable");
      }),
    );

    await expect(
      runLinker.execute({ trigger: "vault-save", notePath: "alpha.md" }),
    ).rejects.toThrow("provider unavailable");

    expect(db.creates).toBe(1);
    const [runId] = db.createdRunIds;
    expect(runId).toMatch(/^agent_run:u"[0-9a-f-]{36}"$/);
    expect(db.finalizations).toEqual([
      { runId, ok: false, proposals: 0, error: "provider unavailable" },
    ]);
    expect(lifecycle).toEqual([
      expect.objectContaining({ type: "agent:run-started", runId }),
      expect.objectContaining({ type: "agent:run-finished", runId, ok: false }),
    ]);
  });

  test("a caller abort while queued finalizes exactly once as an abort", async () => {
    const db = new RunDb();
    const bus = new EventBus();
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    let releaseBlocker = (): void => undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = scheduler.run("blocker", async () => blockerGate);
    const executor = new AgentRunExecutor({ db: db.asSurreal(), bus, scheduler, now: Date.now });
    let agentCalls = 0;
    const runLinker = executor.bind(
      makeAgent(async () => {
        agentCalls += 1;
        return { proposals: 0 };
      }),
    );
    const controller = new AbortController();
    const execution = runLinker.execute({
      trigger: "embedding-repair",
      notePath: "alpha.md",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    releaseBlocker();
    await blocker;

    expect(agentCalls).toBe(0);
    expect(db.creates).toBe(1);
    expect(db.finalizations).toHaveLength(1);
    expect(db.finalizations[0]).toEqual({
      runId: db.createdRunIds[0],
      ok: false,
      proposals: 0,
      error: "aborted",
    });
  });

  test("independent UUID rows are created concurrently", async () => {
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstAttempted = (): void => undefined;
    const firstAttempted = new Promise<void>((resolve) => {
      markFirstAttempted = resolve;
    });
    const db = new RunDb(async (notePath) => {
      if (notePath === "first.md") {
        markFirstAttempted();
        await firstGate;
      }
    });
    const executor = new AgentRunExecutor({
      db: db.asSurreal(),
      bus: new EventBus(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 2 }),
      now: Date.now,
    });
    const runLinker = executor.bind(makeAgent(async () => ({ proposals: 0 })));

    const first = runLinker.execute({ trigger: "vault-save", notePath: "first.md" });
    await firstAttempted;
    const second = runLinker.execute({ trigger: "vault-save", notePath: "second.md" });
    await second;
    expect(db.createAttempts).toEqual(["first.md", "second.md"]);

    releaseFirst();
    await first;

    expect(new Set(db.createdRunIds).size).toBe(2);
    expect(new Set(db.finalizations.map((row) => row.runId))).toEqual(new Set(db.createdRunIds));
  });

  test("one slot serializes chat, Extractor, and Linker provider work without deadlock", async () => {
    const db = new RunDb();
    const bus = new EventBus();
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const providerCall = async <T>(label: string, value: T): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      calls.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push(`${label}:finish`);
      active -= 1;
      return value;
    };
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>() =>
        providerCall("extractor", {
          entities: [],
          claims: [],
          questions: [],
        } as T),
      embed: async () => [],
    };
    const extractor = new Extractor(provider, { model: "extractor", scheduler, concurrency: 1 });
    const executor = new AgentRunExecutor({ db: db.asSurreal(), bus, scheduler, now: Date.now });
    const runLinker = executor.bind(
      makeAgent(async () => providerCall("linker", { proposals: 0 })),
    );

    const chat = scheduler.runPriority("chat", async () => providerCall("chat", undefined));
    const extraction = extractor.extract([
      {
        id: "chunk:1",
        ord: 0,
        text: "alpha",
        tokenEstimate: 2,
      },
    ]);
    const linking = runLinker.execute({ trigger: "vault-save", notePath: "alpha.md" });

    await Promise.all([chat, extraction, linking]);

    expect(peak).toBe(1);
    expect(calls).toEqual([
      "chat:start",
      "chat:finish",
      "extractor:start",
      "extractor:finish",
      "linker:start",
      "linker:finish",
    ]);
    expect(db.finalizations).toEqual([{ runId: db.createdRunIds[0], ok: true, proposals: 0 }]);
  });
});
