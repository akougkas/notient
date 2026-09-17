import { describe, expect, it } from "bun:test";
import { isRetryableSurrealError, withSurrealRetry } from "../../../../src/core/db/retry";

describe("withSurrealRetry", () => {
  it("retries a retryable transaction conflict and returns the eventual result", async () => {
    let calls = 0;
    const result = await withSurrealRetry(
      async ({ attempt, idempotencyKey }) => {
        calls += 1;
        expect(attempt).toBe(calls);
        expect(idempotencyKey).toBe("operation-1");
        if (calls < 3) {
          throw new Error(
            "Query not executed: Transaction conflict: Resource busy: . This transaction can be retried",
          );
        }
        return "ok";
      },
      {
        attempts: 5,
        baseDelayMs: 1,
        idempotencyKey: "operation-1",
        sleep: async () => {},
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("reuses one idempotency key after a landed commit loses its response", async () => {
    const rows = new Map<string, { seq: number }>();
    let nextSeq = 0;
    let attempts = 0;

    const result = await withSurrealRetry(
      async ({ idempotencyKey }) => {
        attempts += 1;
        let row = rows.get(idempotencyKey);
        if (row === undefined) {
          nextSeq += 1;
          row = { seq: nextSeq };
          rows.set(idempotencyKey, row);
        }
        if (attempts === 1) {
          // The transaction committed; only its response was lost.
          throw new Error("The call was terminated because the connection was closed");
        }
        return row;
      },
      {
        baseDelayMs: 0,
        idempotencyKey: "logical-grant-1",
        sleep: async () => {},
      },
    );

    expect(result).toEqual({ seq: 1 });
    expect(attempts).toBe(2);
    expect(rows.size).toBe(1);
    expect(nextSeq).toBe(1);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withSurrealRetry(
        async () => {
          calls += 1;
          throw new Error("Parse error: unexpected token");
        },
        { attempts: 5, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("Parse error");
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      withSurrealRetry(
        async () => {
          calls += 1;
          throw new Error("Transaction conflict");
        },
        { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("Transaction conflict");
    expect(calls).toBe(3);
  });

  it("rejects an empty idempotency key before starting the operation", async () => {
    let called = false;
    await expect(
      withSurrealRetry(
        async () => {
          called = true;
        },
        { idempotencyKey: "" },
      ),
    ).rejects.toThrow("idempotencyKey must not be empty");
    expect(called).toBe(false);
  });

  it("classifies messages", () => {
    expect(isRetryableSurrealError(new Error("Resource busy"))).toBe(true);
    expect(
      isRetryableSurrealError(
        new Error("The call has been terminated because the connection was closed"),
      ),
    ).toBe(true);
    const sdkError = new Error("opaque");
    sdkError.name = "CallTerminatedError";
    expect(isRetryableSurrealError(sdkError)).toBe(true);
    expect(isRetryableSurrealError(new Error("boom"))).toBe(false);
    expect(isRetryableSurrealError("This transaction can be retried")).toBe(true);
  });
});
