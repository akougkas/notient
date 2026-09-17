import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { ContradictionHunter } from "../../../../src/core/agents/contradictionHunter";
import type { EventBus } from "../../../../src/core/events/eventBus";
import type { LLMProvider } from "../../../../src/core/llm/provider";

const CLAIMS = [
  { note_path: "a.md", claim_text: "coffee helps focus" },
  { note_path: "b.md", claim_text: "coffee harms focus" },
];
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

function makeContext() {
  return {
    trigger: "idle-5m" as const,
    notePath: null,
    signal: new AbortController().signal,
    runId: AGENT_RUN_ID,
    bus: { emit: () => {} } as unknown as EventBus,
  };
}

describe("ContradictionHunter subagent", () => {
  test("identifies as the contradiction hunter and uses the reasoning model", () => {
    const { db } = makeDb(() => []);
    const hunter = new ContradictionHunter({
      db,
      provider: {} as LLMProvider,
      reasoningModel: "m",
    });
    expect(hunter.name).toBe("contradictionHunter");
    expect(hunter.usesReasoningModel).toBe(true);
  });

  test("returns 0 proposals when the vault holds no claims", async () => {
    const { db } = makeDb(() => []);
    const hunter = new ContradictionHunter({
      db,
      provider: {} as LLMProvider,
      reasoningModel: "m",
    });
    expect(await hunter.run(makeContext())).toEqual({ proposals: 0 });
  });

  test("needs at least two claims before it calls the model", async () => {
    let called = false;
    const provider = {
      chatJson: async () => {
        called = true;
        return { contradictions: [] };
      },
    } as unknown as LLMProvider;
    const { db } = makeDb((sql) => (sql.includes("FROM asserts") ? [CLAIMS[0]] : []));
    const hunter = new ContradictionHunter({ db, provider, reasoningModel: "m" });
    expect(await hunter.run(makeContext())).toEqual({ proposals: 0 });
    expect(called).toBe(false);
  });

  test("sweeps its stale pending proposals vault-wide before proposing again", async () => {
    const provider = {
      chatJson: async () => ({ contradictions: [] }),
    } as unknown as LLMProvider;
    const { db, sqls } = makeDb((sql) => (sql.includes("FROM asserts") ? CLAIMS : []));
    const hunter = new ContradictionHunter({ db, provider, reasoningModel: "m" });
    await hunter.run(makeContext());
    const sweep = sqls.find((sql) => sql.startsWith("DELETE contradicts"));
    expect(sweep).toBeDefined();
    expect(sweep).toContain("approved = false");
    // This agent scans every claim rather than one note, so the sweep is not
    // scoped to a note either.
    expect(sweep).not.toContain("in = $note");
  });

  test("returns 0 proposals when the model finds no contradictions", async () => {
    const provider = {
      chatJson: async () => ({ contradictions: [] }),
    } as unknown as LLMProvider;
    const { db } = makeDb((sql) => (sql.includes("FROM asserts") ? CLAIMS : []));
    const hunter = new ContradictionHunter({ db, provider, reasoningModel: "m" });
    expect(await hunter.run(makeContext())).toEqual({ proposals: 0 });
  });

  test("propagates model failure so the run ledger records an error", async () => {
    const provider = {
      chatJson: async () => {
        throw new Error("reasoning endpoint unavailable");
      },
    } as unknown as LLMProvider;
    const { db } = makeDb((sql) => (sql.includes("FROM asserts") ? CLAIMS : []));
    const hunter = new ContradictionHunter({ db, provider, reasoningModel: "m" });
    await expect(hunter.run(makeContext())).rejects.toThrow("reasoning endpoint unavailable");
  });

  test("skips a self-contradiction the model hallucinates", async () => {
    const provider = {
      chatJson: async () => ({
        contradictions: [{ sourceNotePath: "a.md", targetNotePath: "a.md", evidence: "x" }],
      }),
    } as unknown as LLMProvider;
    const { db, sqls } = makeDb((sql) => (sql.includes("FROM asserts") ? CLAIMS : []));
    const hunter = new ContradictionHunter({ db, provider, reasoningModel: "m" });
    expect(await hunter.run(makeContext())).toEqual({ proposals: 0 });
    expect(sqls.some((sql) => sql.startsWith("RELATE"))).toBe(false);
  });
});
