/**
 * `session.hello` authentication.
 *
 * The daemon mints one random root token for each boot. That token establishes
 * the reserved `human` principal. Every named agent instead presents an
 * HMAC-SHA256 credential bound to its canonical id and this protocol domain.
 * A credential for one id is therefore unusable for another id, and neither a
 * missing nor an invalid credential degrades into an attributed agent.
 *
 * The root token file is protected by the operating-system account boundary.
 * A same-account process that can read it is trusted as the vault owner and can
 * derive any agent credential or authenticate as human. Agent transports such
 * as MCP may derive their credential from that file, but never send the root
 * token over the daemon socket.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_AGENT_ID, validateAgentId } from "../core/auth/agentIdentity";
import { AGENT_SCOPES, type Authenticator, HUMAN_SCOPES, type Principal, RpcError } from "./rpc";

export interface HelloAuthenticatorOptions {
  /** The live root token, or `null` when the daemon minted none. */
  adminToken: string | null;
}

const ROOT_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_CREDENTIAL_DOMAIN = "notient/session.hello/agent-identity/v1\0";

export function makeHelloAuthenticator(options: HelloAuthenticatorOptions): Authenticator {
  return (params) => authenticateHello(params, options.adminToken);
}

/** Derive the one boot-scoped credential valid for a canonical non-human id. */
export function deriveAgentCredential(adminToken: string, clientIdentity: string): string {
  assertRootToken(adminToken);
  const id = canonicalIdentity(clientIdentity);
  if (id === DEFAULT_AGENT_ID) {
    throw new Error("the reserved human identity does not have an agent credential");
  }
  return createHmac("sha256", adminToken)
    .update(AGENT_CREDENTIAL_DOMAIN, "utf8")
    .update(id, "utf8")
    .digest("hex");
}

export function authenticateHello(
  params: Record<string, unknown>,
  adminToken: string | null,
): Principal {
  assertKnownHelloFields(params);
  const id = parseWireIdentity(params.clientIdentity);
  return id === DEFAULT_AGENT_ID
    ? authenticateHuman(params, adminToken)
    : authenticateAgent(params, id, adminToken);
}

function authenticateHuman(params: Record<string, unknown>, adminToken: string | null): Principal {
  assertExactHelloFields(params, ["clientIdentity", "token"], "human");
  const supplied = params.token;
  if (
    adminToken === null ||
    typeof supplied !== "string" ||
    !ROOT_TOKEN_PATTERN.test(adminToken) ||
    !ROOT_TOKEN_PATTERN.test(supplied) ||
    !constantTimeHexEquals(supplied, adminToken)
  ) {
    throw unauthenticated("human authentication failed");
  }
  return { id: DEFAULT_AGENT_ID, kind: "human", scopes: [...HUMAN_SCOPES] };
}

function authenticateAgent(
  params: Record<string, unknown>,
  id: string,
  adminToken: string | null,
): Principal {
  assertExactHelloFields(params, ["clientIdentity", "agentCredential"], "agent");
  const supplied = params.agentCredential;
  if (
    adminToken === null ||
    typeof supplied !== "string" ||
    !ROOT_TOKEN_PATTERN.test(adminToken) ||
    !AGENT_CREDENTIAL_PATTERN.test(supplied)
  ) {
    throw unauthenticated("agent authentication failed");
  }
  const expected = deriveAgentCredential(adminToken, id);
  if (!constantTimeHexEquals(supplied, expected)) {
    throw unauthenticated("agent authentication failed");
  }
  return { id, kind: "agent", scopes: [...AGENT_SCOPES] };
}

function parseWireIdentity(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new RpcError("INVALID_PARAMS", "clientIdentity must be a canonical string");
  }
  try {
    return canonicalIdentity(raw);
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}

function canonicalIdentity(raw: string): string {
  const validated = validateAgentId(raw);
  if (!validated.valid || validated.id !== raw) {
    throw new Error("clientIdentity must be one exact canonical agent id");
  }
  return validated.id;
}

function assertRootToken(token: string): void {
  if (!ROOT_TOKEN_PATTERN.test(token)) {
    throw new Error("daemon root token must be exactly 64 lowercase hexadecimal characters");
  }
}

function assertKnownHelloFields(params: Record<string, unknown>): void {
  const known = new Set(["clientIdentity", "token", "agentCredential"]);
  const unknown = Object.keys(params).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new RpcError(
      "INVALID_PARAMS",
      `session.hello contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
}

function assertExactHelloFields(
  params: Record<string, unknown>,
  expected: readonly string[],
  kind: "human" | "agent",
): void {
  const actual = Object.keys(params).sort();
  const canonical = [...expected].sort();
  if (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  ) {
    return;
  }
  const hasOppositeCredential =
    kind === "human" ? Object.hasOwn(params, "agentCredential") : Object.hasOwn(params, "token");
  if (hasOppositeCredential) {
    throw new RpcError(
      "INVALID_PARAMS",
      `${kind} session.hello must contain exactly ${canonical.join(" and ")}`,
    );
  }
  throw unauthenticated(`${kind} authentication failed`);
}

function constantTimeHexEquals(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unauthenticated(message: string): RpcError {
  return new RpcError("UNAUTHENTICATED", message);
}
