/**
 * `session.grant` RPC handler.
 *
 * Wraps SessionGrants.grant for a wire client. Input validation rejects
 * malformed payloads with INVALID_PARAMS so the CLI surfaces a clear error
 * before the row would have been written.
 */

import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../core/auth/agentIdentity";
import type { SessionGrants } from "../../core/services/sessionGrants";
import { type MethodHandler, RpcError } from "../rpc";

export interface SessionGrantHandlerDeps {
  sessionGrants: SessionGrants;
}

export interface SessionGrantRequest {
  client: string;
  allowedFolders: string[];
  allowedTools?: string[];
  maxWrites?: number;
  ttlMinutes: number;
}

export interface SessionGrantResponse {
  sessionId: string;
  client: string;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
}

export type SessionGrantHandler = MethodHandler;

export function makeSessionGrantHandler(deps: SessionGrantHandlerDeps): SessionGrantHandler {
  return async ({ params }) => {
    const parsed = parseGrantParams(params);
    const grant = await deps.sessionGrants.grant({
      client: parsed.client,
      allowedFolders: parsed.allowedFolders,
      allowedTools: parsed.allowedTools,
      maxWrites: parsed.maxWrites,
      ttlMinutes: parsed.ttlMinutes,
    });
    const response: SessionGrantResponse = {
      sessionId: grant.id,
      client: grant.client,
      expiresAt: grant.expiresAt,
      allowedFolders: grant.allowedFolders,
      allowedTools: grant.allowedTools,
      maxWrites: grant.maxWrites,
    };
    return { ok: true, ...response };
  };
}

interface ParsedGrantParams {
  client: string;
  allowedFolders: string[];
  allowedTools: string[] | undefined;
  maxWrites: number | undefined;
  ttlMinutes: number;
}

function parseGrantParams(params: Record<string, unknown>): ParsedGrantParams {
  // The grant subject must be named explicitly. A grant is what lets an
  // agent principal's writes auto-approve inside scope, so it can never be
  // inferred from the caller, and it can never be `human`.
  const rawClient = params.client;
  if (typeof rawClient !== "string" || rawClient.trim().length === 0) {
    throw new RpcError("INVALID_PARAMS", "client must be a non-empty agent id");
  }
  let client: string;
  try {
    client = normalizeAgentId(rawClient);
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
  if (client === DEFAULT_AGENT_ID) {
    throw new RpcError("INVALID_PARAMS", `client must be an agent id, not '${DEFAULT_AGENT_ID}'`);
  }
  const allowedFolders = parseStringArray(params.allowedFolders, "allowedFolders");
  if (allowedFolders.length === 0) {
    throw new RpcError("INVALID_PARAMS", "allowedFolders must contain at least one entry");
  }
  const allowedTools =
    params.allowedTools === undefined
      ? undefined
      : parseStringArray(params.allowedTools, "allowedTools");
  const maxWrites = parseOptionalPositiveInt(params.maxWrites, "maxWrites");
  const ttlMinutes = parseRequiredPositiveInt(params.ttlMinutes, "ttlMinutes");
  return { client, allowedFolders, allowedTools, maxWrites, ttlMinutes };
}

function parseStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new RpcError("INVALID_PARAMS", `${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new RpcError("INVALID_PARAMS", `${label} entries must be strings`);
    }
    out.push(entry);
  }
  return out;
}

function parseRequiredPositiveInt(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new RpcError("INVALID_PARAMS", `${label} must be a positive integer`);
  }
  return raw;
}

function parseOptionalPositiveInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new RpcError("INVALID_PARAMS", `${label} must be a positive integer when provided`);
  }
  return raw;
}
