import { describe, expect, test } from "bun:test";
import { unwrapNativeValue, wrapNativeValue } from "../../../../src/core/db/nativeValue";

describe("native Surreal value envelopes", () => {
  test("round-trips scalar and structured values without JSON encoding", () => {
    const values: unknown[] = ["text", 42, true, null, ["a", 1], { nested: { ok: true } }];
    for (const value of values) {
      expect(unwrapNativeValue(wrapNativeValue(value), "test value")).toEqual(value);
    }
  });

  test("rejects malformed persisted state instead of guessing", () => {
    for (const malformed of [
      "encoded",
      [],
      {},
      { value: "wrong key" },
      { data: "valid value", extra: "non-canonical field" },
    ]) {
      expect(() => unwrapNativeValue(malformed, "corrupt row")).toThrow();
    }
  });
});
