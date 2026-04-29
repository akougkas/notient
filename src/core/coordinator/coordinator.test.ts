/**
 * Phase 5 Task 3 Coordinator smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/coordinator/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which includes the
 * `agent_run` table added in Phase 4 Task 12), and exercises the
 * Coordinator dispatch loop end-to-end against the live database. Each
 * test truncates `agent_run` in `afterEach` so seq counters and ordering
 * assertions stay independent.
 *
 * Migrated from the SQLite-backed in-memory fixture: the wire-shape
 * `runId` returned to agents is now the `seq` integer assigned at row
 * CREATE time. Tests assert on `agent_run` rather than the retired
 * `agent_runs` table.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../db/schemaApplier";
import { type SurrealConnection, connect } from "../db/surreal";
import { EventBus } from "../events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { Coordinator } from "./coordinator";
import { ReasoningMutex } from "./reasoningMutex";
import type { Agent, AgentRunContext } from "./types";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface AgentRunRow {
  agent: string;
  ok: boolean | null;
  error: string | null;
  proposals_count: number;
}

async function clearAgentRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_run;").collect();
}

async function selectAgentRuns(connection: SurrealConnection): Promise<AgentRunRow[]> {
  // SurrealDB 3.0.5 requires every ORDER BY field to appear in the
  // projection; `seq` is selected and discarded by the caller.
  const [rows] = await connection.db
    .query<[Array<AgentRunRow & { seq: number }>]>(
      "SELECT agent, ok, error, proposals_count, seq FROM agent_run ORDER BY seq ASC;",
    )
    .collect<[Array<AgentRunRow & { seq: number }>]>();
  return rows.map((row) => ({
    agent: row.agent,
    ok: row.ok,
    error: row.error,
    proposals_count: row.proposals_count,
  }));
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

describe.skipIf(!SMOKE_ENABLED)("[smoke] Coordinator", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-coordinator-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-coordinator-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await clearAgentRuns(connection);
  });

  test("[smoke] vault-save triggers Linker on the saved note", async () => {
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
      db: connection.db,
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
    const rows = await selectAgentRuns(connection);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].ok).toBe(true);
    expect(rows[0].proposals_count).toBe(1);
  });

  test("[smoke] idle-30s also runs Linker on the active note", async () => {
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
      db: connection.db,
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

  test("[smoke] idle-5m fans out to Synthesizer + ContradictionHunter", async () => {
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
      db: connection.db,
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

  test("[smoke] idle-30m runs Maturity Advancer (no mutex slot needed)", async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const advancer: Agent = {
      name: "maturityAdvancer",
      usesReasoningModel: false,
      async run(context) {
        calls.push(`ma:${context.trigger}`);
        return { proposals: 2 };
      },
    };
    const coord = new Coordinator({
      bus,
      db: connection.db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0),
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: advancer,
      },
    });
    coord.start();
    bus.emit({ type: "user:idle", level: "30m" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["ma:idle-30m"]);
  });

  test("[smoke] user-action 'deepen' fires all four sequentially on a single note", async () => {
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
      db: connection.db,
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

  test("[smoke] agent failure is recorded and does not crash the coordinator", async () => {
    const bus = new EventBus();
    const coord = new Coordinator({
      bus,
      db: connection.db,
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
    const rows = await selectAgentRuns(connection);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error ?? "").toContain("boom");
  });

  test("[smoke] active typing suppresses idle dispatch", async () => {
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
      db: connection.db,
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

  test("[smoke] runId is the seq integer, allocated monotonically per run", async () => {
    const bus = new EventBus();
    const observed: number[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run(context) {
        observed.push(context.runId);
        return { proposals: 0 };
      },
    };
    const coord = new Coordinator({
      bus,
      db: connection.db,
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
    bus.emit({ type: "vault:note-saved", path: "/b.md", sha: "y" });
    await coord.idle();
    coord.stop();
    expect(observed).toHaveLength(2);
    expect(Number.isInteger(observed[0])).toBe(true);
    expect(observed[1]).toBe(observed[0] + 1);
  });
});
