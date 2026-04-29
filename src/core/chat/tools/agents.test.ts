import { describe, expect, test } from "bun:test";
import type { ContradictionHunter } from "../../agents/contradictionHunter";
import type { Synthesizer } from "../../agents/synthesizer";
import type { AgentRunContext, AgentRunResult } from "../../coordinator/types";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { EventBus } from "../../events/eventBus";
import { makeContradictionCheckTool, makeSynthesizeTool } from "./agents";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

interface CapturedRun {
  context: AgentRunContext;
}

function fakeHunter(stub: {
  db: Database;
  capture: CapturedRun[];
  inserts?: { id: string; sourceId: string; targetId: string }[];
}): ContradictionHunter {
  return {
    name: "contradictionHunter",
    usesReasoningModel: true,
    async run(context: AgentRunContext): Promise<AgentRunResult> {
      stub.capture.push({ context });
      const inserts = stub.inserts ?? [];
      for (const entry of inserts) {
        stub.db.run(
          `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
           VALUES (?,?,?,?,?,?,?,?,?);`,
          [
            entry.id,
            "contradicts",
            entry.sourceId,
            entry.targetId,
            0.8,
            "contradictionHunter",
            JSON.stringify(["c1", "c2"]),
            "rationale",
            Date.now(),
          ],
        );
      }
      return { proposals: inserts.length };
    },
  } as unknown as ContradictionHunter;
}

function fakeSynthesizer(stub: {
  db: Database;
  capture: CapturedRun[];
  inserts?: {
    id: string;
    label: string;
    body: string;
    memberPaths: string[];
    targetPath: string;
  }[];
}): Synthesizer {
  return {
    name: "synthesizer",
    usesReasoningModel: true,
    async run(context: AgentRunContext): Promise<AgentRunResult> {
      stub.capture.push({ context });
      const inserts = stub.inserts ?? [];
      for (const entry of inserts) {
        stub.db.run(
          `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at)
           VALUES (?,?,?,?,?,?,?,?);`,
          [
            entry.id,
            "synthesis",
            entry.label,
            null,
            JSON.stringify({
              body: entry.body,
              memberPaths: entry.memberPaths,
              targetPath: entry.targetPath,
            }),
            "synthesizer",
            0.75,
            Date.now(),
          ],
        );
      }
      return { proposals: inserts.length };
    },
  } as unknown as Synthesizer;
}

describe("agents.contradiction_check", () => {
  test("invokes the hunter scoped to the requested note and returns newly staged proposals", async () => {
    const db = await newDb();
    const capture: CapturedRun[] = [];
    const hunter = fakeHunter({
      db,
      capture,
      inserts: [
        { id: "staging:contradictionHunter:abc", sourceId: "claim:a", targetId: "claim:b" },
      ],
    });
    const tool = makeContradictionCheckTool({ db, hunter, bus: new EventBus() });
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result.proposalsCount).toBe(1);
    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0]).toMatchObject({
      id: "staging:contradictionHunter:abc",
      sourceId: "claim:a",
      targetId: "claim:b",
      evidence: ["c1", "c2"],
    });
    expect(capture[0].context.notePath).toBe("/a.md");
    expect(capture[0].context.trigger).toBe("user-action");
  });

  test("excludes proposals that were already in staging before the run", async () => {
    const db = await newDb();
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      [
        "staging:contradictionHunter:old",
        "contradicts",
        "claim:x",
        "claim:y",
        0.8,
        "contradictionHunter",
        JSON.stringify([]),
        null,
        1,
      ],
    );
    const capture: CapturedRun[] = [];
    const hunter = fakeHunter({
      db,
      capture,
      inserts: [
        { id: "staging:contradictionHunter:new", sourceId: "claim:p", targetId: "claim:q" },
      ],
    });
    const tool = makeContradictionCheckTool({ db, hunter, bus: new EventBus() });
    const result = await tool.invoke({ notePath: "/a.md" }, new AbortController().signal);
    expect(result.newProposals.map((p) => p.id)).toEqual(["staging:contradictionHunter:new"]);
  });

  test("forwards the abort signal", async () => {
    const db = await newDb();
    const capture: CapturedRun[] = [];
    const hunter = fakeHunter({ db, capture });
    const controller = new AbortController();
    const tool = makeContradictionCheckTool({ db, hunter, bus: new EventBus() });
    await tool.invoke({ notePath: "/a.md" }, controller.signal);
    expect(capture[0].context.signal).toBe(controller.signal);
  });

  test("rejects an empty notePath", async () => {
    const db = await newDb();
    const tool = makeContradictionCheckTool({
      db,
      hunter: fakeHunter({ db, capture: [] }),
      bus: new EventBus(),
    });
    expect(() => tool.validate({ notePath: "" })).toThrow();
  });
});

describe("agents.synthesize", () => {
  test("runs the synthesizer and returns newly staged synthesis nodes", async () => {
    const db = await newDb();
    const capture: CapturedRun[] = [];
    const synthesizer = fakeSynthesizer({
      db,
      capture,
      inserts: [
        {
          id: "staging:synthesis:posix",
          label: "POSIX limits",
          body: "## Themes\n- POSIX leaks.",
          memberPaths: ["/a.md", "/b.md"],
          targetPath: "0-inbox/notient-synthesis/posix-limits.md",
        },
      ],
    });
    const tool = makeSynthesizeTool({ db, synthesizer, bus: new EventBus() });
    const result = await tool.invoke(
      { notePaths: ["/a.md", "/b.md"] },
      new AbortController().signal,
    );
    expect(result.proposalsCount).toBe(1);
    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0]).toMatchObject({
      id: "staging:synthesis:posix",
      label: "POSIX limits",
      memberPaths: ["/a.md", "/b.md"],
      targetPath: "0-inbox/notient-synthesis/posix-limits.md",
    });
    expect(capture[0].context.trigger).toBe("user-action");
  });

  test("accepts an empty argument payload", async () => {
    const db = await newDb();
    const capture: CapturedRun[] = [];
    const synthesizer = fakeSynthesizer({ db, capture });
    const tool = makeSynthesizeTool({ db, synthesizer, bus: new EventBus() });
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.proposalsCount).toBe(0);
    expect(result.newProposals).toEqual([]);
  });

  test("rejects malformed notePaths", async () => {
    const db = await newDb();
    const tool = makeSynthesizeTool({
      db,
      synthesizer: fakeSynthesizer({ db, capture: [] }),
      bus: new EventBus(),
    });
    expect(() => tool.validate({ notePaths: [1, 2] })).toThrow();
  });

  test("tolerates malformed payload JSON when reading newly staged rows", async () => {
    const db = await newDb();
    const capture: CapturedRun[] = [];
    const synthesizer: Synthesizer = {
      name: "synthesizer",
      usesReasoningModel: true,
      async run(context: AgentRunContext): Promise<AgentRunResult> {
        capture.push({ context });
        db.run(
          `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at)
           VALUES (?,?,?,?,?,?,?,?);`,
          [
            "staging:synthesis:bad",
            "synthesis",
            "Broken draft",
            null,
            "{not valid json",
            "synthesizer",
            0.7,
            Date.now(),
          ],
        );
        return { proposals: 1 };
      },
    } as unknown as Synthesizer;
    const tool = makeSynthesizeTool({ db, synthesizer, bus: new EventBus() });
    const result = await tool.invoke({}, new AbortController().signal);
    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0]).toMatchObject({
      id: "staging:synthesis:bad",
      label: "Broken draft",
      memberPaths: [],
      body: "",
      targetPath: null,
    });
  });
});
