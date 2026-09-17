import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, type RpcResponseFrame, connectClient } from "../client";
import type { Emitter } from "../output";

export type DistillFormat = "auto" | "markdown" | "jsonl" | "json";

export interface DistillCommandOptions {
  vaultPath: string;
  transcriptPath: string;
  format: DistillFormat;
  dryRun: boolean;
  emitter: Emitter;
  clientIdentity?: string;
  /**
   * Test seam. Defaults to writing to process.stdout/stderr with a trailing
   * newline. The runtime never threads this from the dispatcher; only tests
   * override it to capture output without spawning real sockets.
   */
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

export async function runDistillCommand(options: DistillCommandOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? defaultStdoutWriter;
  const writeStderr = options.writeStderr ?? defaultStderrWriter;
  const params = buildRequestParams(options);

  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  let terminal: DistillTerminal | null;
  try {
    terminal = await readDistillTerminal(client, params);
  } catch (error) {
    await client.close();
    throw error;
  }
  try {
    await client.close();
  } catch {
    emitDistillError("INTERNAL", "agent.distill connection close failed", {}, options, writeStderr);
    return 1;
  }
  if (terminal === null) {
    emitDistillError(
      "INTERNAL",
      "agent.distill returned no terminal frame",
      {},
      options,
      writeStderr,
    );
    return 1;
  }
  if (terminal.kind === "error") {
    emitDistillError(terminal.code, terminal.message, terminal.detail, options, writeStderr);
    return 1;
  }
  writeStdout(JSON.stringify(terminal.result, null, 2));
  return 0;
}

function defaultStdoutWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderrWriter(line: string): void {
  process.stderr.write(`${line}\n`);
}

function buildRequestParams(options: DistillCommandOptions): Record<string, unknown> {
  if (options.transcriptPath.trim().length === 0) {
    throw new Error("INVALID_PARAMS: distill requires --from <path>");
  }
  const params: Record<string, unknown> = { transcriptPath: options.transcriptPath };
  if (options.format !== "auto") params.format = options.format;
  if (options.dryRun) params.dryRun = true;
  return params;
}

type DistillTerminal =
  | { kind: "result"; result: DistillResult }
  | { kind: "error"; code: RpcErrorCode; message: string; detail: Record<string, unknown> };

interface DistillCandidate {
  kind: CandidateKind;
  text: string;
  sourceMessageIds: string[];
}

type CandidateKind = "claim" | "decision" | "question" | "note";

interface DistillWrite {
  path: string;
  sha: string;
  historyId: string;
}

interface DistillResult {
  dryRun: boolean;
  applied: boolean;
  pending: boolean;
  denied: boolean;
  candidates: DistillCandidate[];
  proposalPaths: string[];
  proposalsCreated: number;
  writes: DistillWrite[];
  byKind: Partial<Record<CandidateKind, number>>;
  durationMs: number;
  callId?: string;
  reason?: string;
  preview?: string;
}

type RpcErrorCode =
  | "DAEMON_SHUTTING_DOWN"
  | "FORBIDDEN"
  | "HISTORY_CONFLICT"
  | "HISTORY_EMPTY"
  | "HISTORY_INVALID_PAYLOAD"
  | "HISTORY_NOT_FOUND"
  | "HISTORY_NOT_REVERSIBLE"
  | "INTERNAL"
  | "INVALID_LLM_OUTPUT"
  | "INVALID_PARAMS"
  | "METHOD_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "UNAUTHENTICATED"
  | "VISION_UNAVAILABLE";

const RPC_ERROR_CODES: ReadonlySet<string> = new Set<RpcErrorCode>([
  "DAEMON_SHUTTING_DOWN",
  "FORBIDDEN",
  "HISTORY_CONFLICT",
  "HISTORY_EMPTY",
  "HISTORY_INVALID_PAYLOAD",
  "HISTORY_NOT_FOUND",
  "HISTORY_NOT_REVERSIBLE",
  "INTERNAL",
  "INVALID_LLM_OUTPUT",
  "INVALID_PARAMS",
  "METHOD_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "UNAUTHENTICATED",
  "VISION_UNAVAILABLE",
]);

const CANDIDATE_KINDS = ["claim", "decision", "question", "note"] as const;
const BASE_RESULT_KEYS = [
  "id",
  "type",
  "ok",
  "dryRun",
  "applied",
  "pending",
  "denied",
  "candidates",
  "proposalPaths",
  "proposalsCreated",
  "writes",
  "byKind",
  "durationMs",
] as const;

async function readDistillTerminal(
  client: ClientHandle,
  params: Record<string, unknown>,
): Promise<DistillTerminal | null> {
  let acknowledgementId: string | undefined;
  let terminal: DistillTerminal | null = null;
  for await (const frame of client.call("agent.distill", params)) {
    if (frame.type === "ack") {
      acknowledgementId = acceptDistillAcknowledgement(frame, acknowledgementId);
      continue;
    }
    terminal = acceptDistillTerminal(frame, acknowledgementId, terminal);
  }
  if (acknowledgementId === undefined) throw distillWireError("missing acknowledgement");
  return terminal;
}

function acceptDistillAcknowledgement(
  frame: RpcResponseFrame,
  acknowledgementId: string | undefined,
): string {
  if (acknowledgementId !== undefined) throw distillWireError("duplicate acknowledgement");
  if (
    !hasExactKeys(frame, ["id", "type", "method"]) ||
    frame.type !== "ack" ||
    frame.method !== "agent.distill" ||
    !isCanonicalRequestId(frame.id)
  ) {
    throw distillWireError("malformed acknowledgement");
  }
  return frame.id;
}

function acceptDistillTerminal(
  frame: RpcResponseFrame,
  acknowledgementId: string | undefined,
  terminal: DistillTerminal | null,
): DistillTerminal {
  if (acknowledgementId === undefined) {
    throw distillWireError("terminal response arrived before acknowledgement");
  }
  if (frame.id !== acknowledgementId) {
    throw distillWireError("terminal request id does not match ACK");
  }
  if (terminal !== null) throw distillWireError("duplicate terminal response");
  if (frame.type === "result") return { kind: "result", result: decodeDistillResult(frame) };
  if (frame.type === "error") return decodeDistillError(frame);
  throw distillWireError("agent.distill emitted an unexpected event frame");
}

function decodeDistillError(frame: RpcResponseFrame): DistillTerminal {
  if (
    !hasExactKeys(frame, ["id", "type", "code", "message", "detail"]) ||
    frame.type !== "error" ||
    typeof frame.code !== "string" ||
    !RPC_ERROR_CODES.has(frame.code) ||
    !isCanonicalNonblank(frame.message) ||
    !isRecord(frame.detail)
  ) {
    throw distillWireError("malformed error terminal");
  }
  return {
    kind: "error",
    code: frame.code as RpcErrorCode,
    message: frame.message,
    detail: frame.detail,
  };
}

function decodeDistillResult(frame: Record<string, unknown>): DistillResult {
  const variantKeys = resultVariantKeys(frame);
  if (
    !hasExactKeys(frame, [...BASE_RESULT_KEYS, ...variantKeys]) ||
    frame.type !== "result" ||
    frame.ok !== true ||
    !isCanonicalRequestId(frame.id)
  ) {
    throw malformedDistillResult("terminal fields are not canonical");
  }
  assertDistillFlags(frame);
  if (!Array.isArray(frame.candidates)) throw malformedDistillResult("candidates must be an array");
  if (!Array.isArray(frame.proposalPaths)) {
    throw malformedDistillResult("proposalPaths must be an array");
  }
  if (!Array.isArray(frame.writes)) throw malformedDistillResult("writes must be an array");
  if (!isNonNegativeSafeInteger(frame.proposalsCreated)) {
    throw malformedDistillResult("proposalsCreated must be a non-negative safe integer");
  }
  if (!isNonNegativeSafeInteger(frame.durationMs)) {
    throw malformedDistillResult("durationMs must be a non-negative safe integer");
  }

  const candidates = frame.candidates.map(decodeCandidate);
  const proposalPaths = decodeProposalPaths(frame.proposalPaths);
  const writes = frame.writes.map(decodeWrite);
  const byKind = decodeByKind(frame.byKind, candidates);
  assertDistillResultRelationships(frame, candidates, proposalPaths, writes);
  return buildDistillResult(frame, candidates, proposalPaths, writes, byKind);
}

function resultVariantKeys(frame: Record<string, unknown>): string[] {
  if (frame.pending === true) return ["callId", "preview"];
  if (frame.denied === true) return ["reason"];
  return [];
}

function assertDistillFlags(frame: Record<string, unknown>): void {
  for (const key of ["dryRun", "applied", "pending", "denied"] as const) {
    if (typeof frame[key] !== "boolean") throw malformedDistillResult(`${key} must be boolean`);
  }
  const activeStates = Number(frame.applied) + Number(frame.pending) + Number(frame.denied);
  if (frame.dryRun === true) {
    if (activeStates !== 0) throw malformedDistillResult("dry runs cannot be applied or parked");
    return;
  }
  if (activeStates !== 1) {
    throw malformedDistillResult("live results require exactly one terminal outcome");
  }
  if (frame.pending === true) {
    if (!isCanonicalNonblank(frame.callId) || !isCanonicalNonblank(frame.preview)) {
      throw malformedDistillResult("pending results require canonical callId and preview");
    }
  }
  if (frame.denied === true && !isCanonicalNonblank(frame.reason)) {
    throw malformedDistillResult("denied results require a canonical reason");
  }
}

function decodeCandidate(raw: unknown, index: number): DistillCandidate {
  if (!isRecord(raw) || !hasExactKeys(raw, ["kind", "text", "sourceMessageIds"])) {
    throw malformedDistillResult(`candidates[${index}] fields are not canonical`);
  }
  if (typeof raw.kind !== "string" || !CANDIDATE_KINDS.includes(raw.kind as CandidateKind)) {
    throw malformedDistillResult(`candidates[${index}].kind is invalid`);
  }
  if (!isCanonicalNonblank(raw.text)) {
    throw malformedDistillResult(`candidates[${index}].text must be canonical and nonblank`);
  }
  const sourceMessageIds = decodeCanonicalStringArray(
    raw.sourceMessageIds,
    `candidates[${index}].sourceMessageIds`,
  );
  return { kind: raw.kind as CandidateKind, text: raw.text, sourceMessageIds };
}

function decodeProposalPaths(raw: unknown[]): string[] {
  const paths = raw.map((value, index) => {
    if (typeof value !== "string" || !isCanonicalProposalPath(value)) {
      throw malformedDistillResult(`proposalPaths[${index}] is not canonical`);
    }
    return value;
  });
  assertUnique(paths, "proposalPaths");
  return paths;
}

function decodeWrite(raw: unknown, index: number): DistillWrite {
  if (!isRecord(raw) || !hasExactKeys(raw, ["path", "sha", "historyId"])) {
    throw malformedDistillResult(`writes[${index}] fields are not canonical`);
  }
  if (typeof raw.path !== "string" || !isCanonicalProposalPath(raw.path)) {
    throw malformedDistillResult(`writes[${index}].path is not canonical`);
  }
  if (typeof raw.sha !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha)) {
    throw malformedDistillResult(`writes[${index}].sha is not a lowercase SHA-256 digest`);
  }
  if (typeof raw.historyId !== "string" || !isCanonicalHistoryId(raw.historyId)) {
    throw malformedDistillResult(`writes[${index}].historyId is not canonical`);
  }
  return { path: raw.path, sha: raw.sha, historyId: raw.historyId };
}

function decodeByKind(
  raw: unknown,
  candidates: DistillCandidate[],
): Partial<Record<CandidateKind, number>> {
  if (!isRecord(raw)) throw malformedDistillResult("byKind must be an object");
  const expected = new Map<CandidateKind, number>();
  for (const candidate of candidates) {
    expected.set(candidate.kind, (expected.get(candidate.kind) ?? 0) + 1);
  }
  if (!hasExactKeys(raw, [...expected.keys()])) {
    throw malformedDistillResult("byKind keys do not match candidate kinds");
  }
  for (const [kind, count] of expected) {
    if (raw[kind] !== count) throw malformedDistillResult(`byKind.${kind} is inconsistent`);
  }
  return Object.fromEntries(expected);
}

function assertDistillResultRelationships(
  frame: Record<string, unknown>,
  candidates: DistillCandidate[],
  proposalPaths: string[],
  writes: DistillWrite[],
): void {
  if (proposalPaths.length !== candidates.length) {
    throw malformedDistillResult("proposalPaths count must match candidates");
  }
  assertUnique(
    writes.map((write) => write.path),
    "write paths",
  );
  if (writes.some((write) => !proposalPaths.includes(write.path))) {
    throw malformedDistillResult("every write path must name a proposal path");
  }
  const proposalsCreated = frame.proposalsCreated as number;
  if (proposalsCreated !== writes.length) {
    throw malformedDistillResult("proposalsCreated must match writes");
  }
  if (frame.applied === true && proposalsCreated !== candidates.length) {
    throw malformedDistillResult("an applied batch must create every candidate");
  }
  if (frame.applied !== true && writes.length !== 0) {
    throw malformedDistillResult("an unapplied batch cannot contain write receipts");
  }
}

function buildDistillResult(
  frame: Record<string, unknown>,
  candidates: DistillCandidate[],
  proposalPaths: string[],
  writes: DistillWrite[],
  byKind: Partial<Record<CandidateKind, number>>,
): DistillResult {
  const result: DistillResult = {
    dryRun: frame.dryRun as boolean,
    applied: frame.applied as boolean,
    pending: frame.pending as boolean,
    denied: frame.denied as boolean,
    candidates,
    proposalPaths,
    proposalsCreated: frame.proposalsCreated as number,
    writes,
    byKind,
    durationMs: frame.durationMs as number,
  };
  if (frame.pending === true) {
    result.callId = frame.callId as string;
    result.preview = frame.preview as string;
  }
  if (frame.denied === true) result.reason = frame.reason as string;
  return result;
}

function decodeCanonicalStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || !raw.every(isCanonicalNonblank)) {
    throw malformedDistillResult(`${label} must be an array of canonical strings`);
  }
  assertUnique(raw, label);
  return [...raw];
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw malformedDistillResult(`${label} must not contain duplicates`);
  }
}

function isCanonicalProposalPath(value: string): boolean {
  return (
    value.startsWith("Notient/proposals/distilled-") &&
    value.endsWith(".md") &&
    !value.includes("\\") &&
    !value.includes("//") &&
    value.trim() === value &&
    !value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)
  );
}

function isCanonicalHistoryId(value: string): boolean {
  return /^history:u"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/.test(
    value,
  );
}

function isCanonicalRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isCanonicalNonblank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function distillWireError(reason: string): Error {
  return new Error(`agent.distill wire integrity: ${reason}`);
}

function malformedDistillResult(reason: string): Error {
  return new Error(`agent.distill returned a malformed result: ${reason}`);
}

function emitDistillError(
  code: RpcErrorCode,
  message: string,
  detail: Record<string, unknown>,
  options: Pick<DistillCommandOptions, "emitter">,
  writeStderr: (line: string) => void,
): void {
  const event = { type: "error", code, message, detail };
  writeStderr(JSON.stringify(event));
  options.emitter.emit(event);
}

export function parseDistillFormat(value: unknown): DistillFormat {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "markdown" || value === "jsonl" || value === "json") {
    return value;
  }
  throw new Error(
    `INVALID_PARAMS: --format must be one of auto | markdown | jsonl | json (got ${String(value)})`,
  );
}
