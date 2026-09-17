import { describe, expect, test } from "bun:test";
import type { RecordId, Surreal } from "surrealdb";
import { AgentRunExecutor } from "../../../../src/core/coordinator/agentRunExecutor";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import type { Agent, AgentName } from "../../../../src/core/coordinator/types";
import { EventBus } from "../../../../src/core/events/eventBus";
import { HistoryService } from "../../../../src/core/history/historyService";
import { AgentEventStore } from "../../../../src/core/services/agentEventStore";
import { SessionGrants } from "../../../../src/core/services/sessionGrants";

type Bindings = Record<string, unknown>;
type RowFactory = (bindings: Bindings, seq: number) => unknown;

/**
 * A deterministic Surreal stand-in for the one ambiguous transport outcome
 * retries must survive: the first query commits its row, then loses the
 * response. The second query sees the same record id and returns that row.
 */
class CommitThenLoseResponseDb {
  readonly attemptedIds: string[] = [];
  readonly keyedSql: string[] = [];
  readonly rows = new Map<string, unknown>();
  createCount = 0;
  maxSeqReadCount = 0;
  nextSeq = 0;
  private loseNextResponse = true;

  constructor(
    private readonly rowFactory: RowFactory,
    private readonly allocatesSequence: boolean,
  ) {}

  asSurreal(): Surreal {
    return {
      query: (sql: string, bindings?: Bindings) => ({
        collect: async () => this.collect(sql, bindings ?? {}),
      }),
    } as unknown as Surreal;
  }

  private async collect(sql: string, bindings: Bindings): Promise<unknown[]> {
    const rowId = bindings.rowId as RecordId<string> | undefined;
    if (rowId === undefined) {
      return this.collectWithoutRowId(bindings);
    }

    const id = rowId.toString();
    this.attemptedIds.push(id);
    this.keyedSql.push(sql);

    let row = this.rows.get(id);
    if (row === undefined) {
      if (this.allocatesSequence) {
        this.maxSeqReadCount += 1;
        this.nextSeq += 1;
      }
      row = this.rowFactory(bindings, this.nextSeq);
      this.rows.set(id, row);
      this.createCount += 1;
    }

    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("The call was terminated because the connection was closed");
    }

    // A replay skips the guarded CREATE while the final SELECT returns the
    // row whose first response was lost. These are the exact SDK 3.0.5 slots.
    return [undefined, undefined, undefined, [row]];
  }

  private collectWithoutRowId(bindings: Bindings): unknown[] {
    const runId = bindings.runId as RecordId<"agent_run"> | undefined;
    if (runId === undefined) {
      // Event-ledger retention queries return one statement slice.
      return [[]];
    }
    const id = runId.toString();
    const pending = this.rows.get(id) as Record<string, unknown> | undefined;
    if (pending === undefined) return [[]];
    const { note_path: notePath, error: _pendingError, ...required } = pending;
    const finalized = {
      ...required,
      ...(notePath === undefined ? {} : { note_path: notePath }),
      finished_at: bindings.finishedAt,
      ok: bindings.ok,
      proposals_count: bindings.proposals,
      ...(bindings.error === undefined ? {} : { error: bindings.error }),
    };
    this.rows.set(id, finalized);
    return [[finalized]];
  }
}

function expectSingleCommittedOperation(
  fake: CommitThenLoseResponseDb,
  options: { allocatesSequence: boolean },
): void {
  expect(fake.attemptedIds).toHaveLength(2);
  expect(new Set(fake.attemptedIds).size).toBe(1);
  expect(fake.rows.size).toBe(1);
  expect(fake.createCount).toBe(1);
  expect(fake.maxSeqReadCount).toBe(options.allocatesSequence ? 1 : 0);
  expect(fake.nextSeq).toBe(options.allocatesSequence ? 1 : 0);

  for (const sql of fake.keyedSql) {
    const guard = sql.indexOf("record::exists($rowId)");
    const create = sql.indexOf("CREATE ONLY $rowId");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(guard);
    if (options.allocatesSequence) {
      expect(sql.indexOf("SELECT VALUE seq")).toBeGreaterThan(guard);
    }
  }
}

describe("idempotent Surreal retry writers", () => {
  test("agent_event replay returns the landed UUIDv7-addressed row", async () => {
    const fake = new CommitThenLoseResponseDb(
      (bindings) => ({
        id: bindings.rowId,
        kind: bindings.kind,
        payload: bindings.payload,
        ts_ms: bindings.tsMs,
      }),
      false,
    );
    const store = new AgentEventStore({
      db: fake.asSurreal(),
      bus: new EventBus(),
      maxRows: 50_000,
    });

    const recorded = await store.record("swarm:link_proposed", { edgeId: "edge:1" });

    expect(recorded.id).toStartWith("agent_event:");
    expectSingleCommittedOperation(fake, { allocatesSequence: false });
    store.dispose();
  });

  test("agent_session replay returns the landed native record", async () => {
    const fake = new CommitThenLoseResponseDb(
      (bindings) => ({
        id: bindings.rowId,
        allowed_folders: bindings.allowedFolders,
        allowed_tools: bindings.allowedTools,
        client: bindings.client,
        expires_at: bindings.expiresAt,
        granted_at: bindings.grantedAt,
        max_writes: bindings.maxWrites,
        revoked_at: undefined,
        used_writes: 0,
      }),
      false,
    );
    const grants = new SessionGrants({ db: fake.asSurreal(), now: () => 1_700_000_000_000 });

    const grant = await grants.grant({
      allowedFolders: ["Inbox/"],
      allowedTools: ["notes.create"],
      client: "claude-code",
      maxWrites: 3,
      ttlMinutes: 30,
    });

    expect(grant.id).toStartWith("agent_session:");
    expect(grant.allowedFolders).toEqual(["Inbox/"]);
    expectSingleCommittedOperation(fake, { allocatesSequence: false });
  });

  test("history replay returns the landed row instead of appending another entry", async () => {
    const fake = new CommitThenLoseResponseDb((bindings) => ({ id: bindings.rowId }), false);
    const history = new HistoryService({
      db: fake.asSurreal(),
      inverters: {},
      now: () => 1_700_000_000_000,
      retention: { max: 100, maxPerTarget: 20 },
    });

    const id = await history.record({
      after: "body",
      before: null,
      kind: "notes.create",
      target: "Inbox/retry.md",
    });

    expect(id.startsWith("history:")).toBe(true);
    expectSingleCommittedOperation(fake, { allocatesSequence: false });
  });

  test("agent_run replay returns the landed UUID-addressed run", async () => {
    const fake = new CommitThenLoseResponseDb(
      (bindings) => ({
        id: bindings.rowId,
        agent: bindings.agent,
        trigger: bindings.trigger,
        note_path: bindings.notePath,
        started_at: bindings.startedAt,
        finished_at: undefined,
        ok: undefined,
        error: undefined,
        proposals_count: 0,
      }),
      false,
    );
    const bus = new EventBus();
    const executor = new AgentRunExecutor({
      bus,
      db: fake.asSurreal(),
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      now: (() => {
        let value = 1_700_000_000_000;
        return () => value++;
      })(),
    });
    await executor.bind(fakeAgent("maturityAdvancer")).execute({
      trigger: "idle-30m",
      notePath: null,
    });

    expectSingleCommittedOperation(fake, { allocatesSequence: false });
    expect(fake.attemptedIds[0]).toMatch(/^agent_run:u"[0-9a-f-]{36}"$/);
    expect(fake.keyedSql.every((sql) => !/\bseq\b/.test(sql))).toBe(true);
  });
});

function fakeAgent<Name extends AgentName>(name: Name): Agent & { readonly name: Name } {
  return {
    name,
    usesReasoningModel: false,
    async run() {
      return { proposals: 0 };
    },
  };
}
