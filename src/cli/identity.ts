/**
 * Per-invocation client identity for the Notient RPC envelope.
 *
 * Phase D1 LD-5 locks identity to per-invocation. Every RPC frame may carry
 * a `clientIdentity` string. The CLI sets it from the `--as <agent-id>`
 * global flag. Absence on the wire means `human` server-side.
 *
 * Validation pattern: `^[a-z][a-z0-9-]{0,31}$`. Reserved ids (`human`,
 * `claude-code`, etc.) all match the pattern; the constant exists so callers
 * can advertise the canonical names without re-deriving them.
 */

export const DEFAULT_AGENT_ID = "human";

export const RESERVED_AGENT_IDS = ["human", "claude-code", "cursor", "codex", "aider"] as const;

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type ValidateAgentIdResult = { valid: true; id: string } | { valid: false; reason: string };

export function validateAgentId(candidate: string): ValidateAgentIdResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return { valid: true, id: DEFAULT_AGENT_ID };
  }
  if (!AGENT_ID_PATTERN.test(trimmed)) {
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
  if (trimmed.length === 0) return DEFAULT_AGENT_ID;
  const result = validateAgentId(trimmed);
  if (!result.valid) {
    throw new Error(result.reason);
  }
  return result.id;
}
