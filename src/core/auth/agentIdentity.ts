/**
 * Canonical identity contract for authenticated visitors and persisted client
 * attribution. Wire, storage, conversation, approval, and CLI boundaries all
 * consume this exact pattern and predicate.
 */

export const DEFAULT_AGENT_ID = "human";

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Requester identity of the in-app assistant: this prefix plus the
 * conversation's authenticated client. The colon is outside the wire id
 * grammar, so no connecting client can claim it.
 */
export const CHAT_ASSISTANT_PREFIX = "assistant:";

export type ValidateAgentIdResult = { valid: true; id: string } | { valid: false; reason: string };

export function isCanonicalAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

export function validateAgentId(candidate: string): ValidateAgentIdResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "Invalid agent id: value must not be blank." };
  }
  if (!isCanonicalAgentId(trimmed)) {
    return {
      valid: false,
      reason: `Invalid agent id "${candidate}": must match ${AGENT_ID_PATTERN.source} (lowercase letter, then up to 31 lowercase letters, digits, or hyphens; max 32 chars).`,
    };
  }
  return { valid: true, id: trimmed };
}

export function normalizeAgentId(input: string | undefined): string {
  if (input === undefined) return DEFAULT_AGENT_ID;
  const trimmed = input.trim();
  const result = validateAgentId(trimmed);
  if (!result.valid) {
    throw new Error(result.reason);
  }
  return result.id;
}
