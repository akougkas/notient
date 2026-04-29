/**
 * session.list RPC handler (Phase D1 T7).
 *
 * Returns the rows the storage layer surfaces, mapped to the wire response
 * shape. Defaults to active-only; callers pass `activeOnly: false` to also
 * see expired and revoked grants.
 */

import type { SessionGrant, SessionGrants } from "../../core/services/sessionGrants";

export interface SessionListHandlerDeps {
  sessionGrants: SessionGrants;
}

export interface SessionListRequest {
  client?: string;
  activeOnly?: boolean;
}

export interface SessionListEntry {
  sessionId: number;
  client: string;
  expiresAt: number;
  allowedFolders: string[];
  allowedTools: string[];
  maxWrites: number | null;
  usedWrites: number;
  revokedAt: number | null;
}

export interface SessionListResponse {
  sessions: SessionListEntry[];
}

export type SessionListHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

export function makeSessionListHandler(deps: SessionListHandlerDeps): SessionListHandler {
  return async (params) => {
    const filter = parseListParams(params);
    const grants = deps.sessionGrants.list(filter);
    const response: SessionListResponse = {
      sessions: grants.map(grantToEntry),
    };
    return { ok: true, ...response };
  };
}

function parseListParams(params: Record<string, unknown>): {
  client?: string;
  activeOnly?: boolean;
} {
  const filter: { client?: string; activeOnly?: boolean } = {};
  if (params.client !== undefined && params.client !== null) {
    if (typeof params.client !== "string") {
      throw new Error("INVALID_PARAMS: client must be a string when provided");
    }
    filter.client = params.client;
  }
  if (params.activeOnly !== undefined && params.activeOnly !== null) {
    if (typeof params.activeOnly !== "boolean") {
      throw new Error("INVALID_PARAMS: activeOnly must be a boolean when provided");
    }
    filter.activeOnly = params.activeOnly;
  }
  return filter;
}

function grantToEntry(grant: SessionGrant): SessionListEntry {
  return {
    sessionId: grant.id,
    client: grant.client,
    expiresAt: grant.expiresAt,
    allowedFolders: grant.allowedFolders,
    allowedTools: grant.allowedTools,
    maxWrites: grant.maxWrites,
    usedWrites: grant.usedWrites,
    revokedAt: grant.revokedAt,
  };
}
