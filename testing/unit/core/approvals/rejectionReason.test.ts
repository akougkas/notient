import { describe, expect, test } from "bun:test";
import {
  REJECTION_REASON_MAX_CHARS,
  normalizeRejectionReason,
} from "../../../../src/core/approvals/rejectionReason";

describe("normalizeRejectionReason", () => {
  test("preserves omission and trims a supplied reason", () => {
    expect(normalizeRejectionReason(undefined)).toBeUndefined();
    expect(normalizeRejectionReason("  wrong target  ")).toBe("wrong target");
  });

  test("rejects supplied empty text", () => {
    expect(() => normalizeRejectionReason("   ")).toThrow("must not be empty");
  });

  test("enforces the shared storage bound", () => {
    expect(normalizeRejectionReason("x".repeat(REJECTION_REASON_MAX_CHARS))).toHaveLength(
      REJECTION_REASON_MAX_CHARS,
    );
    expect(() => normalizeRejectionReason("x".repeat(REJECTION_REASON_MAX_CHARS + 1))).toThrow(
      `at most ${REJECTION_REASON_MAX_CHARS} characters`,
    );
  });
});
