/** Maximum stored length for an operator-supplied rejection reason. */
export const REJECTION_REASON_MAX_CHARS = 1000;

/**
 * Canonicalize an optional rejection reason at every ingress boundary.
 * Omission is meaningful; a supplied but empty value is invalid.
 */
export function normalizeRejectionReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = reason.trim();
  if (normalized.length === 0) {
    throw new Error("rejection reason must not be empty");
  }
  if (normalized.length > REJECTION_REASON_MAX_CHARS) {
    throw new Error(`rejection reason must be at most ${REJECTION_REASON_MAX_CHARS} characters`);
  }
  return normalized;
}
