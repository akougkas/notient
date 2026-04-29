/**
 * session.revoke RPC handler (Phase D1 T7).
 *
 * Sets revoked_at on the matching row. If no row matches, the handler raises
 * an error so the CLI surfaces a non-zero exit code instead of pretending the
 * grant was already torn down.
 */

import type { SessionGrants } from "../../core/services/sessionGrants";

export interface SessionRevokeHandlerDeps {
  sessionGrants: SessionGrants;
}

export interface SessionRevokeRequest {
  sessionId: number;
}

export interface SessionRevokeResponse {
  sessionId: number;
  revokedAt: number;
}

export type SessionRevokeHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

export function makeSessionRevokeHandler(deps: SessionRevokeHandlerDeps): SessionRevokeHandler {
  return async (params) => {
    const sessionId = parseSessionId(params.sessionId);
    const revoked = deps.sessionGrants.revoke(sessionId);
    if (revoked === null) {
      throw new Error(`SESSION_NOT_FOUND: no session with id ${sessionId}`);
    }
    if (revoked.revokedAt === null) {
      // SessionGrants.revoke only returns a null revokedAt when the row was
      // missing, which the branch above already handled. The defensive check
      // here keeps the response type honest for any future change.
      throw new Error(`SESSION_NOT_FOUND: session ${sessionId} could not be revoked`);
    }
    const response: SessionRevokeResponse = {
      sessionId: revoked.id,
      revokedAt: revoked.revokedAt,
    };
    return { ok: true, ...response };
  };
}

function parseSessionId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error("INVALID_PARAMS: sessionId must be a positive integer");
  }
  return raw;
}
