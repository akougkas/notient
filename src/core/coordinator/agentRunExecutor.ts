import type { RecordId, Surreal } from "surrealdb";
import { createUuidRecordId, parseStoredUuidRecordId } from "../db/recordId";
import { withSurrealRetry } from "../db/retry";
import { type EventBus, assertEventBus } from "../events/eventBus";
import { ReasoningScheduler } from "./reasoningScheduler";
import type {
  Agent,
  AgentName,
  AgentRunCapability,
  AgentRunContext,
  AgentRunRequest,
  AgentRunResult,
  AgentTrigger,
} from "./types";

export interface AgentRunExecutorOptions {
  db: Surreal;
  bus: EventBus;
  scheduler: ReasoningScheduler;
  now: () => number;
  /** Monotonic elapsed-time clock; wall time is only audit metadata. */
  monotonicNow?: () => number;
}

interface RunOutcome {
  ok: boolean;
  proposals: number;
  error?: string;
}

interface CreatedRun {
  id: string;
  recordId: RecordId<"agent_run">;
}

interface ExpectedRun {
  agent: AgentName;
  trigger: AgentTrigger;
  notePath: string | null;
  startedAt: number;
}

const AGENT_NAMES = new Set<AgentName>([
  "linker",
  "synthesizer",
  "contradictionHunter",
  "maturityAdvancer",
]);

const AGENT_TRIGGERS = new Set<AgentTrigger>([
  "vault-save",
  "embedding-repair",
  "idle-30s",
  "idle-5m",
  "idle-30m",
]);

const RUN_ROW_FIELDS = [
  "id",
  "agent",
  "trigger",
  "note_path",
  "started_at",
  "finished_at",
  "ok",
  "error",
  "proposals_count",
] as const;

const RUN_ROW_PROJECTION = RUN_ROW_FIELDS.join(", ");

export class AgentRunIntegrityError extends Error {
  constructor(message: string) {
    super(`agent run storage integrity failure: ${message}`);
    this.name = "AgentRunIntegrityError";
  }
}

/**
 * The sole execution boundary for autonomous note workers.
 *
 * A bound capability creates its `agent_run` before calling the worker,
 * executes reasoning workers through the process-wide scheduler, finalizes
 * the row exactly once on success, failure, or abort, and emits lifecycle
 * events only after the corresponding durable write succeeds.
 */
export class AgentRunExecutor {
  private readonly db: Surreal;
  private readonly bus: EventBus;
  private readonly scheduler: ReasoningScheduler;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(options: AgentRunExecutorOptions) {
    if (!isObject(options) || !isObject(options.db) || typeof options.db.query !== "function") {
      throw new Error("AgentRunExecutor requires a SurrealDB client");
    }
    assertEventBus(options.bus, "AgentRunExecutor");
    if (!(options.scheduler instanceof ReasoningScheduler)) {
      throw new Error("AgentRunExecutor requires a ReasoningScheduler");
    }
    if (typeof options.now !== "function") {
      throw new Error("AgentRunExecutor requires a clock function");
    }
    this.db = options.db;
    this.bus = options.bus;
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  bind<Name extends Agent["name"]>(
    agent: Agent & { readonly name: Name },
  ): AgentRunCapability<Name> {
    assertAgent(agent);
    return Object.freeze({
      agentName: agent.name,
      execute: (request: AgentRunRequest) => this.execute(agent, request),
    });
  }

  private async execute(agent: Agent, request: AgentRunRequest): Promise<AgentRunResult> {
    assertRunRequest(request);
    const startedAt = readClock(this.now, "start");
    const startedMonotonic = this.monotonicNow();
    const expected: ExpectedRun = {
      agent: agent.name,
      trigger: request.trigger,
      notePath: request.notePath,
      startedAt,
    };
    const run = await this.createRun(expected);
    this.bus.emit({
      type: "agent:run-started",
      agent: expected.agent,
      trigger: expected.trigger,
      notePath: expected.notePath,
      runId: run.id,
    });

    let result: AgentRunResult | undefined;
    let executionError: Error | undefined;
    try {
      result = assertAgentRunResult(await this.executeAgent(agent, request, run.id));
    } catch (error) {
      executionError = executionFailure(error, agent.name);
    }

    const durationMs = Math.max(0, Math.floor(this.monotonicNow() - startedMonotonic));
    // Keep audit timestamps ordered even when NTP moves the wall clock back.
    // Finalization must not strand an otherwise completed worker.
    const finishedAt = Math.max(startedAt, readClock(this.now, "finish"));
    const outcome: RunOutcome =
      executionError === undefined && result !== undefined
        ? { ok: true, proposals: result.proposals }
        : { ok: false, proposals: 0, error: requiredErrorMessage(executionError) };
    await this.finalizeRun(run.recordId, expected, finishedAt, outcome);
    this.bus.emit({
      type: "agent:run-finished",
      agent: expected.agent,
      ok: outcome.ok,
      proposals: outcome.proposals,
      durationMs,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      runId: run.id,
    });

    if (executionError !== undefined) throw executionError;
    if (result === undefined) {
      throw new Error("AgentRunExecutor invariant violation: successful run has no result");
    }
    return result;
  }

  private executeAgent(
    agent: Agent,
    request: AgentRunRequest,
    runId: string,
  ): Promise<AgentRunResult> {
    const base: Omit<AgentRunContext, "signal"> = {
      trigger: request.trigger,
      notePath: request.notePath,
      runId,
      bus: this.bus,
    };
    const run = (signal: AbortSignal): Promise<AgentRunResult> => agent.run({ ...base, signal });
    if (agent.usesReasoningModel) {
      return this.scheduler.run(
        `agent:${agent.name}`,
        run,
        request.signal === undefined ? {} : { signal: request.signal },
      );
    }
    const signal = request.signal ?? new AbortController().signal;
    if (signal.aborted) return Promise.reject(abortError());
    return run(signal);
  }

  private async createRun(expected: ExpectedRun): Promise<CreatedRun> {
    const setClauses: string[] = ["agent: $agent", "trigger: $trigger", "started_at: $startedAt"];
    const bindings: Record<string, unknown> = {
      agent: expected.agent,
      trigger: expected.trigger,
      startedAt: expected.startedAt,
    };
    if (expected.notePath !== null) {
      setClauses.push("note_path: $notePath");
      bindings.notePath = expected.notePath;
    }
    const sql = [
      "BEGIN;",
      "IF !record::exists($rowId) {",
      `  CREATE ONLY $rowId CONTENT { ${setClauses.join(", ")} };`,
      "};",
      "COMMIT;",
      `SELECT ${RUN_ROW_PROJECTION} FROM $rowId;`,
    ].join("\n");
    let expectedRecordId: RecordId<"agent_run"> | undefined;
    const results = await withSurrealRetry(({ idempotencyKey }) => {
      const rowId = createUuidRecordId("agent_run", idempotencyKey);
      expectedRecordId = rowId;
      return this.db.query(sql, { ...bindings, rowId }).collect<unknown[]>();
    });
    if (expectedRecordId === undefined) {
      throw new Error("AgentRunExecutor invariant violation: create did not allocate an id");
    }
    const { created, selected } = readRunCreateEnvelope(results);
    if (created !== undefined) {
      assertCreatedRunRow(created, expectedRecordId, expected);
    }
    const selectedId = assertRunRow(selected, {
      expected,
      expectedRecordId,
      finishedAt: undefined,
      outcome: undefined,
    });
    return { id: selectedId.toString(), recordId: selectedId };
  }

  private async finalizeRun(
    runId: RecordId<"agent_run">,
    expected: ExpectedRun,
    finishedAt: number,
    outcome: RunOutcome,
  ): Promise<void> {
    const errorClause = outcome.error === undefined ? "error = NONE" : "error = $error";
    const bindings: Record<string, unknown> = {
      runId,
      finishedAt,
      ok: outcome.ok,
      proposals: outcome.proposals,
    };
    if (outcome.error !== undefined) bindings.error = outcome.error;
    const results = await this.db
      .query(
        `UPDATE $runId SET finished_at = $finishedAt, ok = $ok, proposals_count = $proposals, ${errorClause} RETURN AFTER;`,
        bindings,
      )
      .collect<unknown[]>();
    const row = readOneRunRow(results, "finalize");
    assertRunRow(row, { expected, expectedRecordId: runId, finishedAt, outcome });
  }
}

function assertAgent(agent: unknown): asserts agent is Agent {
  if (!isObject(agent) || !AGENT_NAMES.has(agent.name as AgentName)) {
    throw new Error("AgentRunExecutor.bind requires a canonical agent name");
  }
  if (typeof agent.usesReasoningModel !== "boolean") {
    throw new Error("AgentRunExecutor.bind requires usesReasoningModel to be boolean");
  }
  if (typeof agent.run !== "function") {
    throw new Error("AgentRunExecutor.bind requires an agent run function");
  }
}

function assertRunRequest(request: unknown): asserts request is AgentRunRequest {
  if (!isObject(request)) {
    throw new Error("AgentRunExecutor.execute requires a request object");
  }
  if (!AGENT_TRIGGERS.has(request.trigger as AgentTrigger)) {
    throw new Error("AgentRunExecutor request trigger is invalid");
  }
  if (request.notePath !== null) {
    assertVaultRelativeNotePath(request.notePath, "AgentRunExecutor request notePath");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw new Error("AgentRunExecutor request signal must be an AbortSignal");
  }
}

function assertVaultRelativeNotePath(raw: unknown, label: string): asserts raw is string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.includes("\\")
  ) {
    throw new Error(`${label} must be a canonical vault-relative note path`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical vault-relative note path`);
  }
}

function assertAgentRunResult(raw: unknown): AgentRunResult {
  if (!isObject(raw) || !hasExactKeys(raw, ["proposals"])) {
    throw new Error("AgentRunExecutor agent result must contain only proposals");
  }
  if (
    typeof raw.proposals !== "number" ||
    !Number.isSafeInteger(raw.proposals) ||
    raw.proposals < 0
  ) {
    throw new Error("AgentRunExecutor agent result proposals must be a non-negative safe integer");
  }
  return { proposals: raw.proposals };
}

function executionFailure(error: unknown, agent: AgentName): Error {
  if (error instanceof Error) return error;
  return new Error(`AgentRunExecutor: ${agent} rejected with a non-Error value`);
}

function requiredErrorMessage(error: Error | undefined): string {
  if (error === undefined) {
    return "AgentRunExecutor: run failed without an Error";
  }
  return error.message.length > 0
    ? error.message
    : `AgentRunExecutor: ${error.name || "Error"} had an empty message`;
}

function readClock(now: () => number, phase: "start" | "finish"): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`AgentRunExecutor ${phase} clock must be a non-negative safe integer`);
  }
  return value;
}

function readRunCreateEnvelope(raw: unknown): { created: unknown; selected: unknown } {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new AgentRunIntegrityError("create must return exactly four statement results");
  }
  if (raw[0] !== undefined || raw[2] !== undefined) {
    throw new AgentRunIntegrityError("create BEGIN and COMMIT results must be undefined");
  }
  const created = raw[1];
  if (created !== undefined && !isObject(created)) {
    throw new AgentRunIntegrityError("create guard result must be a row or undefined");
  }
  const selectedRows = raw[3];
  if (!Array.isArray(selectedRows) || selectedRows.length !== 1) {
    throw new AgentRunIntegrityError("create SELECT must return exactly one row");
  }
  return { created, selected: selectedRows[0] };
}

function readOneRunRow(raw: unknown, operation: string): unknown {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new AgentRunIntegrityError(`${operation} must return one statement result`);
  }
  if (raw[0].length !== 1) {
    throw new AgentRunIntegrityError(`${operation} must return exactly one row`);
  }
  return raw[0][0];
}

function assertCreatedRunRow(
  raw: unknown,
  expectedRecordId: RecordId<"agent_run">,
  expected: ExpectedRun,
): void {
  if (!isObject(raw)) {
    throw new AgentRunIntegrityError("created value must be a row object");
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => !RUN_ROW_FIELDS.includes(key as (typeof RUN_ROW_FIELDS)[number]))) {
    throw new AgentRunIntegrityError("created row contains non-canonical fields");
  }
  for (const field of ["id", "agent", "trigger", "started_at", "proposals_count"] as const) {
    if (!Object.hasOwn(raw, field)) {
      throw new AgentRunIntegrityError(`created row is missing ${field}`);
    }
  }
  for (const field of ["note_path", "finished_at", "ok", "error"] as const) {
    const present = Object.hasOwn(raw, field);
    if ((present && raw[field] === undefined) || (!present && raw[field] !== undefined)) {
      throw new AgentRunIntegrityError(`created row must omit ${field} exactly when it is NONE`);
    }
  }
  const recordId = storedRunId(raw.id);
  if (recordId.toString() !== expectedRecordId.toString()) {
    throw new AgentRunIntegrityError("created row id does not match its requested id");
  }
  assertPendingRunValues(raw, expected);
}

function assertRunRow(
  raw: unknown,
  state: {
    expected: ExpectedRun;
    expectedRecordId: RecordId<"agent_run">;
    finishedAt: number | undefined;
    outcome: RunOutcome | undefined;
  },
): RecordId<"agent_run"> {
  if (!isObject(raw)) {
    throw new AgentRunIntegrityError("row must be an object");
  }
  const expectedFields = expectedRunRowFields(state.expected, state.outcome);
  if (!hasExactKeys(raw, expectedFields)) {
    const fields = Object.keys(raw).sort().join(",");
    throw new AgentRunIntegrityError(
      `row must contain exactly the operation's canonical agent_run fields; received ${fields}`,
    );
  }
  const recordId = storedRunId(raw.id);
  if (recordId.toString() !== state.expectedRecordId.toString()) {
    throw new AgentRunIntegrityError("row id does not match its requested id");
  }
  assertPendingRunValues(raw, state.expected);
  if (state.outcome === undefined) {
    assertNewRunLifecycle(raw);
    return recordId;
  }
  assertFinalizedRunLifecycle(raw, state.finishedAt, state.outcome);
  return recordId;
}

function expectedRunRowFields(expected: ExpectedRun, outcome: RunOutcome | undefined): string[] {
  if (outcome === undefined) return [...RUN_ROW_FIELDS];
  return [
    "id",
    "agent",
    "trigger",
    ...(expected.notePath === null ? [] : ["note_path"]),
    "started_at",
    "finished_at",
    "ok",
    ...(outcome.error === undefined ? [] : ["error"]),
    "proposals_count",
  ];
}

function assertNewRunLifecycle(raw: Record<string, unknown>): void {
  if (raw.finished_at !== undefined || raw.ok !== undefined || raw.error !== undefined) {
    throw new AgentRunIntegrityError("new row must have canonical NONE lifecycle fields");
  }
}

function assertFinalizedRunLifecycle(
  raw: Record<string, unknown>,
  finishedAt: number | undefined,
  outcome: RunOutcome,
): void {
  if (raw.finished_at !== finishedAt) {
    throw new AgentRunIntegrityError("finalized row finished_at does not match the finish clock");
  }
  if (raw.ok !== outcome.ok) {
    throw new AgentRunIntegrityError("finalized row ok does not match its outcome");
  }
  if (raw.proposals_count !== outcome.proposals) {
    throw new AgentRunIntegrityError("finalized row proposals_count does not match its outcome");
  }
  if (raw.error !== outcome.error) {
    throw new AgentRunIntegrityError("finalized row error does not match its outcome");
  }
}

function assertPendingRunValues(raw: Record<string, unknown>, expected: ExpectedRun): void {
  if (raw.agent !== expected.agent || !AGENT_NAMES.has(raw.agent as AgentName)) {
    throw new AgentRunIntegrityError("row agent is not the requested canonical agent");
  }
  if (raw.trigger !== expected.trigger || !AGENT_TRIGGERS.has(raw.trigger as AgentTrigger)) {
    throw new AgentRunIntegrityError("row trigger is not the requested canonical trigger");
  }
  if (raw.note_path !== (expected.notePath ?? undefined)) {
    throw new AgentRunIntegrityError("row note_path does not match the request");
  }
  if (raw.note_path !== undefined) {
    try {
      assertVaultRelativeNotePath(raw.note_path, "stored note_path");
    } catch {
      throw new AgentRunIntegrityError("row note_path must be a canonical vault-relative path");
    }
  }
  if (raw.started_at !== expected.startedAt) {
    throw new AgentRunIntegrityError("row started_at does not match the start clock");
  }
  if (raw.proposals_count !== 0 && raw.finished_at === undefined) {
    throw new AgentRunIntegrityError("new row proposals_count must be zero");
  }
}

function storedRunId(raw: unknown): RecordId<"agent_run"> {
  try {
    return parseStoredUuidRecordId(raw, "agent_run", "agent run storage id");
  } catch {
    throw new AgentRunIntegrityError("id must be a native agent_run UUID record id");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
