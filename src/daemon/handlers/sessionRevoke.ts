/**
 * `session.revoke` RPC handler.
 *
 * Sets revoked_at on the matching row. If no row matches, the handler raises
 * an error so the CLI surfaces a non-zero exit code instead of pretending the
 * grant was already torn down.
 */

import { type SessionGrants, parseSessionGrantRecordId } from "../../core/services/sessionGrants";
import { type MethodHandler, RpcError } from "../rpc";

export interface SessionRevokeHandlerDeps {
  sessionGrants: SessionGrants;
}

export interface SessionRevokeRequest {
  sessionId: string;
}

export interface SessionRevokeResponse {
  sessionId: string;
  revokedAt: number;
}

export type SessionRevokeHandler = MethodHandler;

export function makeSessionRevokeHandler(deps: SessionRevokeHandlerDeps): SessionRevokeHandler {
  return async ({ params }) => {
    const sessionId = parseSessionId(params.sessionId);
    const revoked = await deps.sessionGrants.revoke(sessionId);
    if (revoked === null) {
      throw new RpcError("SESSION_NOT_FOUND", `no session with id ${sessionId}`);
    }
    if (revoked.revokedAt === null) {
      // SessionGrants.revoke only returns a null revokedAt when the row was
      // missing, which the branch above already handled. The defensive check
      // here keeps the response type honest for any future change.
      throw new RpcError("SESSION_NOT_FOUND", `session ${sessionId} could not be revoked`);
    }
    const response: SessionRevokeResponse = {
      sessionId: revoked.id,
      revokedAt: revoked.revokedAt,
    };
    return { ok: true, ...response };
  };
}

function parseSessionId(raw: unknown): string {
  try {
    return parseSessionGrantRecordId(raw).toString();
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}
