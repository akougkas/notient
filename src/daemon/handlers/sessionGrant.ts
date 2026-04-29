/**
 * session.grant RPC handler (Phase D1 T7).
 *
 * Wraps SessionGrants.grant for a wire client. Input validation rejects
 * malformed payloads with INVALID_PARAMS so the CLI surfaces a clear error
 * before the row would have been written.
 */

import type { SessionGrants } from "../../core/services/sessionGrants";

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
  sessionId: number;
  client: string;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
}

export type SessionGrantHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

export function makeSessionGrantHandler(deps: SessionGrantHandlerDeps): SessionGrantHandler {
  return async (params) => {
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
  const client = params.client;
  if (typeof client !== "string" || client.trim().length === 0) {
    throw new Error("INVALID_PARAMS: client must be a non-empty string");
  }
  const allowedFolders = parseStringArray(params.allowedFolders, "allowedFolders");
  if (allowedFolders.length === 0) {
    throw new Error("INVALID_PARAMS: allowedFolders must contain at least one entry");
  }
  const allowedTools =
    params.allowedTools === undefined
      ? undefined
      : parseStringArray(params.allowedTools, "allowedTools");
  const maxWrites = parseOptionalPositiveInt(params.maxWrites, "maxWrites");
  const ttlMinutes = parseRequiredPositiveNumber(params.ttlMinutes, "ttlMinutes");
  return { client, allowedFolders, allowedTools, maxWrites, ttlMinutes };
}

function parseStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`INVALID_PARAMS: ${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(`INVALID_PARAMS: ${label} entries must be strings`);
    }
    out.push(entry);
  }
  return out;
}

function parseRequiredPositiveNumber(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`INVALID_PARAMS: ${label} must be a positive number`);
  }
  return raw;
}

function parseOptionalPositiveInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`INVALID_PARAMS: ${label} must be a positive integer when provided`);
  }
  return raw;
}
