import { describe, expect, test } from "bun:test";
import type { RecordId, Surreal } from "surrealdb";
import { Synthesizer } from "../../../../src/core/agents/synthesizer";
import type { EventBus } from "../../../../src/core/events/eventBus";
import type { LLMProvider } from "../../../../src/core/llm/provider";

const NOTE_ID = { toString: () => "note:active" } as unknown as RecordId<"note">;
const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000001"';

function makeDb(respond: (sql: string) => unknown[]): { db: Surreal; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    query: (sql: string) => {
      sqls.push(sql);
      return { collect: async () => [respond(sql)] };
    },
  } as unknown as Surreal;
  return { db, sqls };
}

function makeContext(notePath: string | null) {
  return {
    trigger: "vault-save" as const,
    notePath,
    signal: new AbortController().signal,
    runId: AGENT_RUN_ID,
    bus: { emit: () => {} } as unknown as EventBus,
  };
}

describe("Synthesizer subagent", () => {
  test("identifies as the synthesizer and uses the reasoning model", () => {
    const { db } = makeDb(() => []);
    const synth = new Synthesizer({ db, provider: {} as LLMProvider, reasoningModel: "m" });
    expect(synth.name).toBe("synthesizer");
    expect(synth.usesReasoningModel).toBe(true);
  });

  test("returns 0 proposals when there is no active note", async () => {
    const { db, sqls } = makeDb(() => []);
    const synth = new Synthesizer({ db, provider: {} as LLMProvider, reasoningModel: "m" });
    expect(await synth.run(makeContext(null))).toEqual({ proposals: 0 });
    expect(sqls).toHaveLength(0);
  });

  test("returns 0 proposals when the active note is not indexed", async () => {
    const { db } = makeDb(() => []);
    const synth = new Synthesizer({ db, provider: {} as LLMProvider, reasoningModel: "m" });
    expect(await synth.run(makeContext("a.md"))).toEqual({ proposals: 0 });
  });

  test("clears its stale pending proposals before proposing again", async () => {
    // Chunks come back empty, so the run stops after the sweep. That is
    // exactly the case that used to leave last cycle's duplicates behind.
    const { db, sqls } = makeDb((sql) => (sql.includes("FROM note") ? [{ id: NOTE_ID }] : []));
    const synth = new Synthesizer({ db, provider: {} as LLMProvider, reasoningModel: "m" });
    await synth.run(makeContext("a.md"));
    const sweep = sqls.find((sql) => sql.startsWith("DELETE synthesizes"));
    expect(sweep).toBeDefined();
    expect(sweep).toContain("approved = false");
    expect(sweep).toContain("source = $agent AND agent = $agent");
    expect(sweep).not.toContain("agent = $agent OR source = $agent");
  });

  test("never calls the model when the note has no embedded chunks", async () => {
    let called = false;
    const provider = {
      chatJson: async () => {
        called = true;
        return { syntheses: [] };
      },
    } as unknown as LLMProvider;
    const { db } = makeDb((sql) => (sql.includes("FROM note") ? [{ id: NOTE_ID }] : []));
    const synth = new Synthesizer({ db, provider, reasoningModel: "m" });
    expect(await synth.run(makeContext("a.md"))).toEqual({ proposals: 0 });
    expect(called).toBe(false);
  });

  test("rejects a malformed stored chunk instead of reporting a successful empty run", async () => {
    const { db } = makeDb((sql) => {
      if (sql.includes("FROM note")) return [{ id: NOTE_ID }];
      if (sql.includes("FROM chunk")) return [{ vector: null }];
      return [];
    });
    const synth = new Synthesizer({ db, provider: {} as LLMProvider, reasoningModel: "m" });
    await expect(synth.run(makeContext("a.md"))).rejects.toThrow("chunk vector is invalid");
  });
});
