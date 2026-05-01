/**
 * Phase 4 Task 4 bootstrap-wiring smoke harness for HistoryService.
 *
 * The substrate test proves the closure contract Task 9 introduced: the
 * `recordHistory` closure that bootstrap installs into the chat tool
 * registry must call HistoryService.record so that
 * `historyService.getRecent(1)` returns the row a chat write produced.
 * The full bootstrap path requires LM Studio plus the live FsVault, so
 * these tests reproduce just the closure shape against a real SurrealDB
 * fixture (Task 4 migrated HistoryService off the in-memory SQLite
 * mirror to SurrealDB).
 *
 * Skipped by default; run with `bun run test:smoke` (sets
 * NOTIENT_SMOKE=1) or `NOTIENT_SMOKE=1 bun test src/daemon/`.
 *
 * The third describe block (`buildHistoryInverters`) does not touch
 * SurrealDB and runs unconditionally.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { ApprovalService } from "../../../src/core/approvals/approvalService";
import type { NotesHistoryRecord } from "../../../src/core/chat/tools/notes";
import type { ToolCall } from "../../../src/core/chat/types";
import { Coordinator } from "../../../src/core/coordinator/coordinator";
import { ReasoningMutex } from "../../../src/core/coordinator/reasoningMutex";
import type { Agent, AgentRunResult } from "../../../src/core/coordinator/types";
import { applySchema } from "../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { HistoryService } from "../../../src/core/history/historyService";
import type { HistoryKind } from "../../../src/core/history/types";
import { Kernel } from "../../../src/core/kernel";
import {
  buildHistoryInverters,
  buildRecordHistoryAutoApprove,
  readEnvSource,
} from "../../../src/daemon/bootstrap";
import { type SurrealServerHandle, startSurreal } from "../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] bootstrap recordHistory wiring", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-bootstrap-history-smoke";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-bootstrap-history-smoke-"));
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
    await connection.db.query("DELETE history;").collect();
  });

  test("[smoke] chat-driven notes.create write lands in history.getRecent", async () => {
    const historyService = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 200, maxPerTarget: 20 },
    });

    // Mirror the closure bootstrap installs at `recordHistory`.
    const recordHistory = async (record: NotesHistoryRecord): Promise<string> =>
      historyService.record(record);

    const id = await recordHistory({
      kind: "notes.create",
      target: "scratch.md",
      before: null,
      after: "hello world",
    });

    expect(id.startsWith("history:")).toBe(true);
    const recent = await historyService.getRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe("notes.create");
    expect(recent[0].target).toBe("scratch.md");
    expect(recent[0].after).toBe("hello world");
    expect(recent[0].before).toBeNull();
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] bootstrap buildRecordHistoryAutoApprove", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-bootstrap-autoapprove-smoke";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-bootstrap-autoapprove-smoke-"));
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
    await connection.db.query("DELETE history;").collect();
  });

  test("[smoke] yolo-mode auto-approval records a chat.auto_approve audit row", async () => {
    let counter = 0;
    const historyService = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 200, maxPerTarget: 20 },
      now: () => 1700000000000 + counter++,
    });
    const recordHistoryAutoApprove = buildRecordHistoryAutoApprove(historyService);
    const call: ToolCall = {
      id: "call-1",
      name: "notes.create",
      args: { path: "/scratch.md", content: "hi" },
    };
    await recordHistoryAutoApprove(call);
    const recent = await historyService.getRecent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe("chat.auto_approve");
    expect(recent[0].target).toBe("/scratch.md");
    const after = recent[0].after as { tool: string; args: Record<string, unknown> };
    expect(after.tool).toBe("notes.create");
    expect(after.args.path).toBe("/scratch.md");
  });

  test("[smoke] auto-approval rows precede the tool's own write row in history order", async () => {
    let counter = 0;
    const historyService = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 200, maxPerTarget: 20 },
      now: () => 1700000000000 + counter++,
    });
    const recordHistoryAutoApprove = buildRecordHistoryAutoApprove(historyService);
    await recordHistoryAutoApprove({
      id: "call-1",
      name: "notes.create",
      args: { path: "/x.md" },
    });
    await historyService.record({
      kind: "notes.create",
      target: "/x.md",
      before: null,
      after: "body",
    });
    const recent = await historyService.getRecent(5);
    expect(recent.map((row) => row.kind)).toEqual(["notes.create", "chat.auto_approve"]);
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] bootstrap ApprovalService wiring", () => {
  let tempDir: string;
  let vaultRoot: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-bootstrap-approvals-smoke";

  const bootstrapFs = {
    writeBinary: async (filePath: string, data: ArrayBuffer): Promise<void> => {
      await writeFile(filePath, new Uint8Array(data));
    },
    rename: async (from: string, to: string): Promise<void> => {
      await rename(from, to);
    },
    remove: async (filePath: string): Promise<void> => {
      await unlink(filePath).catch(() => {
        // missing-file is not an error for cleanup
      });
    },
  };

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-bootstrap-approvals-smoke-"));
    vaultRoot = path.join(tempDir, "vault");
    await import("node:fs/promises").then((module) => module.mkdir(vaultRoot, { recursive: true }));
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

  test('[smoke] kernel.get("approvalService") returns an ApprovalService instance', () => {
    const kernel = new Kernel();
    const approvalService = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vaultRoot,
      fs: bootstrapFs,
      readFile: (filePath) => readFile(filePath, "utf8"),
    });
    kernel.register("approvalService", approvalService);
    expect(kernel.has("approvalService")).toBe(true);
    expect(kernel.get("approvalService")).toBeInstanceOf(ApprovalService);
  });

  test("[smoke] reconcilePendingApplications is invoked once on boot and emits a structured stderr summary", async () => {
    // Mirror the bootstrap closure: fire-and-forget reconciliation that
    // writes a structured stderr line. The closure itself is the unit
    // under test; we capture process.stderr.write and assert one summary
    // line lands. The empty SurrealDB has no half-applied rows so the
    // result is {replayed: 0, failed: 0}; Task 12's smoke covers the
    // half-applied seed path.
    const approvalService = new ApprovalService({
      db: connection.db,
      bus: new EventBus(),
      vaultRoot,
      fs: bootstrapFs,
      readFile: (filePath) => readFile(filePath, "utf8"),
    });

    let invocations = 0;
    const original = approvalService.reconcilePendingApplications.bind(approvalService);
    approvalService.reconcilePendingApplications = async () => {
      invocations += 1;
      return original();
    };

    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // The bootstrap writes a JSON line via process.stderr.write; redirect
    // it to a capture array for the duration of the closure.
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write has overloads we do not need to model
    (process.stderr as any).write = (chunk: unknown): boolean => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    };

    try {
      await approvalService
        .reconcilePendingApplications()
        .then((result) => {
          process.stderr.write(
            `${JSON.stringify({
              type: "daemon:reconcile_summary",
              replayed: result.replayed,
              failed: result.failed,
            })}\n`,
          );
        })
        .catch((error) => {
          process.stderr.write(
            `${JSON.stringify({ type: "daemon:reconcile_failed", error: String(error) })}\n`,
          );
        });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(invocations).toBe(1);
    const summaryLine = captured.find((line) => line.includes("daemon:reconcile_summary"));
    expect(summaryLine).toBeDefined();
    if (summaryLine === undefined) return;
    const parsed = JSON.parse(summaryLine.trim()) as {
      type: string;
      replayed: number;
      failed: number;
    };
    expect(parsed.type).toBe("daemon:reconcile_summary");
    expect(parsed.replayed).toBe(0);
    expect(parsed.failed).toBe(0);
  });
});

describe.skipIf(!SMOKE_ENABLED)("[smoke] bootstrap swarm dispatch with no-op agents", () => {
  /**
   * Phase 5 Task 6 / Locked Decision 11: Synthesizer and ContradictionHunter
   * are stripped from production wiring. The bootstrap assigns the same no-op
   * Agent shape Linker uses when SurrealDB is absent. This smoke proves the
   * Coordinator dispatches with all four agent slots filled and writes four
   * agent_run rows on a single user-action deepen cycle, each with
   * proposals_count=0 and ok=true.
   */
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-bootstrap-swarm-noop-smoke";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-bootstrap-swarm-noop-smoke-"));
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
    await connection.db.query("DELETE agent_run;").collect();
  });

  test("[smoke] user-action deepen records four agent_run rows with no-op Synthesizer + ContradictionHunter", async () => {
    const bus = new EventBus();
    const noopAgent = (name: Agent["name"]): Agent => ({
      name,
      usesReasoningModel: false,
      run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
    });
    const coord = new Coordinator({
      bus,
      db: connection.db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: noopAgent("linker"),
        synthesizer: noopAgent("synthesizer"),
        contradictionHunter: noopAgent("contradictionHunter"),
        maturityAdvancer: noopAgent("maturityAdvancer"),
      },
    });
    coord.start();
    bus.emit({ type: "user:action", kind: "deepen", notePath: "/x.md" });
    await coord.idle();
    coord.stop();

    const [rows] = await connection.db
      .query<[Array<{ agent: string; ok: boolean | null; proposals_count: number; seq: number }>]>(
        "SELECT agent, ok, proposals_count, seq FROM agent_run ORDER BY seq ASC;",
      )
      .collect<
        [Array<{ agent: string; ok: boolean | null; proposals_count: number; seq: number }>]
      >();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.agent)).toEqual([
      "linker",
      "synthesizer",
      "contradictionHunter",
      "maturityAdvancer",
    ]);
    for (const row of rows) {
      expect(row.ok).toBe(true);
      expect(row.proposals_count).toBe(0);
    }
  });
});
