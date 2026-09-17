/** Human CLI for deciding pending typed-edge proposals through the vault daemon. */

import { isCanonicalAgentId } from "../../core/auth/agentIdentity";
import { WRITEBACK_EDGE_TABLES, type WritebackEdgeTable } from "../../core/db/edgeTables";
import { parseSurrealRelationRecordId, parseUuidRecordId } from "../../core/db/recordId";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { ProposalWire } from "../../daemon/wire";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";
import type { Emitter } from "../output";

type Connector = (options: ClientOptions) => Promise<ClientHandle>;

interface CommandConnectionOptions {
  vaultPath: string;
  clientIdentity?: string;
  connect?: Connector;
}

export interface ProposalsListOptions extends CommandConnectionOptions {
  emitter: Emitter;
  asJson: boolean;
  notePath?: string;
  agent?: string;
  limit?: number;
  /** Test seam for the JSON array mode. */
  writeStdout?: (line: string) => void;
}

export interface ProposalsApproveOptions extends CommandConnectionOptions {
  emitter: Emitter;
  id: string;
}

export interface ProposalsRejectOptions extends CommandConnectionOptions {
  emitter: Emitter;
  id: string;
  reason?: string;
}

interface RpcSuccess {
  ok: true;
  frame: RpcResponseFrame;
}

interface RpcFailure {
  ok: false;
  code: string;
  message: string;
}

type RpcOutcome = RpcSuccess | RpcFailure;

async function connect(options: CommandConnectionOptions): Promise<ClientHandle> {
  const connector = options.connect ?? connectClient;
  return await connector({
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    vaultPath: options.vaultPath,
    ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
  });
}

async function callOnce(
  client: ClientHandle,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcOutcome> {
  for await (const frame of client.call(method, params)) {
    if (frame.type === "error") {
      return {
        ok: false,
        code: typeof frame.code === "string" ? frame.code : "INTERNAL",
        message: typeof frame.message === "string" ? frame.message : `${method} failed`,
      };
    }
    if (frame.type === "result") return { ok: true, frame };
  }
  return { ok: false, code: "INTERNAL", message: `${method} returned no result` };
}

function emitFailure(emitter: Emitter, action: string, failure: RpcFailure): number {
  emitter.emit({
    type: "error",
    code: failure.code,
    message: `proposals ${action} failed: ${failure.message}`,
  });
  return failure.code === "INVALID_PARAMS" ? 2 : 1;
}

export async function runProposalsListCommand(options: ProposalsListOptions): Promise<number> {
  let client: ClientHandle | undefined;
  try {
    client = await connect(options);
    const params: Record<string, unknown> = {};
    if (options.notePath !== undefined) params.notePath = options.notePath;
    if (options.agent !== undefined) params.agent = options.agent;
    if (options.limit !== undefined) params.limit = options.limit;
    const outcome = await callOnce(client, "links.proposals", params);
    if (!outcome.ok) return emitFailure(options.emitter, "list", outcome);
    if (!Array.isArray(outcome.frame.proposals)) {
      throw new Error("links.proposals returned an invalid proposals payload");
    }
    const proposals = (outcome.frame.proposals as ProposalWire[]).map((proposal) => {
      const parsed = parseSurrealRelationRecordId(
        proposal.id,
        WRITEBACK_EDGE_TABLES,
        "proposal id",
      );
      if (parsed.table !== proposal.table) {
        throw new Error("links.proposals returned a proposal whose id and table disagree");
      }
      return proposal;
    });
    if (options.asJson) {
      const writeStdout = options.writeStdout ?? ((line: string) => process.stdout.write(line));
      writeStdout(
        `${JSON.stringify(
          proposals.map((proposal) => ({
            id: proposal.id,
            table: proposal.table,
            source: proposal.fromNotePath,
            target: proposal.toNotePath,
            agent: proposal.agent,
            confidence: proposal.confidence,
          })),
        )}\n`,
      );
      return 0;
    }
    for (const proposal of proposals) {
      options.emitter.emit({
        type: "proposals:list",
        id: proposal.id,
        table: proposal.table,
        source: proposal.fromNotePath,
        target: proposal.toNotePath,
        agent: proposal.agent,
        confidence: proposal.confidence,
      });
    }
    if (proposals.length === 0) options.emitter.emit({ type: "proposals:list:empty" });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals list failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    await client?.close().catch(() => {});
  }
}

function validateProposalId(
  action: "approve" | "reject",
  id: string,
  emitter: Emitter,
): WritebackEdgeTable | null {
  if (id.length === 0) {
    emitter.emit({
      type: "error",
      code: "INVALID_PARAMS",
      message: `proposals ${action} requires an id`,
    });
    return null;
  }
  try {
    return parseSurrealRelationRecordId(id, WRITEBACK_EDGE_TABLES, "id").table;
  } catch (error) {
    emitter.emit({
      type: "error",
      code: "INVALID_ID",
      message: `proposals ${action}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

function assertDecisionIdentity(
  frame: RpcResponseFrame,
  expectedId: string,
  expectedTable: WritebackEdgeTable,
): void {
  const parsed = parseSurrealRelationRecordId(frame.edgeId, WRITEBACK_EDGE_TABLES, "edgeId");
  if (parsed.id !== expectedId || parsed.table !== expectedTable || frame.table !== expectedTable) {
    throw new Error("proposal decision returned an identity that differs from the request");
  }
  if (typeof frame.found !== "boolean") {
    throw new Error("proposal decision returned an invalid found flag");
  }
}

export async function runProposalsApproveCommand(
  options: ProposalsApproveOptions,
): Promise<number> {
  const table = validateProposalId("approve", options.id, options.emitter);
  if (table === null) return 2;
  let client: ClientHandle | undefined;
  try {
    client = await connect(options);
    const outcome = await callOnce(client, "links.approve", { id: options.id });
    if (!outcome.ok) return emitFailure(options.emitter, "approve", outcome);
    assertDecisionIdentity(outcome.frame, options.id, table);
    if (outcome.frame.found !== true) {
      if (outcome.frame.historyId !== null || outcome.frame.approvedBy !== null) {
        throw new Error("missing proposal returned an unexpected approval receipt");
      }
      options.emitter.emit({
        type: "proposals:not_found",
        id: options.id,
        message: "proposal not found or already applied",
      });
      return 0;
    }
    const historyId = parseUuidRecordId(
      outcome.frame.historyId,
      "history",
      "approval historyId",
    ).toString();
    if (!isCanonicalAgentId(outcome.frame.approvedBy)) {
      throw new Error("proposal approval returned an invalid approving principal");
    }
    options.emitter.emit({
      type: "proposals:approved",
      id: options.id,
      table,
      historyId,
      approvedBy: outcome.frame.approvedBy,
    });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals approve failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runProposalsRejectCommand(options: ProposalsRejectOptions): Promise<number> {
  const table = validateProposalId("reject", options.id, options.emitter);
  if (table === null) return 2;
  let client: ClientHandle | undefined;
  try {
    client = await connect(options);
    const params: Record<string, unknown> = { id: options.id };
    if (options.reason !== undefined) params.reason = options.reason;
    const outcome = await callOnce(client, "links.reject", params);
    if (!outcome.ok) return emitFailure(options.emitter, "reject", outcome);
    assertDecisionIdentity(outcome.frame, options.id, table);
    if (outcome.frame.found !== true) {
      options.emitter.emit({
        type: "proposals:not_found",
        id: options.id,
        message: "proposal not found or already applied",
      });
      return 0;
    }
    const historyId = parseUuidRecordId(outcome.frame.historyId, "history", "historyId").toString();
    options.emitter.emit({
      type: "proposals:rejected",
      id: options.id,
      table,
      reason: outcome.frame.reason,
      historyId,
    });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `proposals reject failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    await client?.close().catch(() => {});
  }
}
