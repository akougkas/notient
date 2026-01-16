/**
 * Centralized ID Generation
 *
 * Standardized ID format: {prefix}_{uuid8}
 * All IDs follow this pattern for consistency and traceability.
 *
 * Prefixes:
 * - tsk_ = Task (ephemeral, runtime only)
 * - ins_ = Insight (persistent container)
 * - act_ = Action (persistent, for undo)
 * - sug_ = Suggestion (persistent)
 * - rec_ = Undo Record (derived from action ID)
 * - stm_ = Stream line (UI only)
 * - msg_ = Chat message
 * - wfl_ = Workflow (batch operations)
 * - ses_ = Session (agent execution context)
 * - mig_ = Migration (data migration operations)
 */

export type IdPrefix =
  | "tsk"
  | "ins"
  | "act"
  | "sug"
  | "rec"
  | "stm"
  | "msg"
  | "wfl"
  | "ses"
  | "mig";

/**
 * Generate a standardized ID with prefix.
 * Format: {prefix}_{8-char-uuid}
 */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Derive an undo record ID from an action ID.
 * Format: rec_{actionId}_{timestamp}
 */
export function deriveRecordId(actionId: string): string {
  return `rec_${actionId}_${Date.now()}`;
}

/**
 * Parse an ID to extract its components.
 * Returns null if the ID doesn't match the expected format.
 */
export function parseId(id: string): { prefix: IdPrefix; uuid: string } | null {
  const match = id.match(/^(tsk|ins|act|sug|rec|stm|msg|wfl|ses|mig)_(.+)$/);
  if (!match) return null;
  return { prefix: match[1] as IdPrefix, uuid: match[2] };
}
