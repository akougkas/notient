/**
 * `session.list` RPC handler.
 *
 * Returns the rows the storage layer surfaces, mapped to the wire response
 * shape. Defaults to active-only; callers pass `activeOnly: false` to also
 * see expired and revoked grants.
 */

import type { SessionGrant, SessionGrants } from "../../core/services/sessionGrants";
import { type MethodHandler, RpcError } from "../rpc";

export interface SessionListHandlerDeps {
  sessionGrants: SessionGrants;
}

export interface SessionListRequest {
  client?: string;
  activeOnly?: boolean;
}

export interface SessionListEntry {
  sessionId: string;
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

export type SessionListHandler = MethodHandler;

export function makeSessionListHandler(deps: SessionListHandlerDeps): SessionListHandler {
  return async ({ params, principal }) => {
    const filter = parseListParams(params);
    // An agent sees only its own grants; the `client` filter it passed is
    // overridden rather than rejected so the common call still works.
    if (principal.kind !== "human") {
      filter.client = principal.id;
    }
    const grants = await deps.sessionGrants.list(filter);
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
      throw new RpcError("INVALID_PARAMS", "client must be a string when provided");
    }
    filter.client = params.client;
  }
  if (params.activeOnly !== undefined && params.activeOnly !== null) {
    if (typeof params.activeOnly !== "boolean") {
      throw new RpcError("INVALID_PARAMS", "activeOnly must be a boolean when provided");
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
