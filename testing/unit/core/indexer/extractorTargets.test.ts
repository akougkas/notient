import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import { deleteExtractorTargetWhenUnreferenced } from "../../../../src/core/indexer/extractorTargets";

describe("deleteExtractorTargetWhenUnreferenced", () => {
  test("retries the atomic incoming-edge check and target delete as one operation", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          calls.push({ sql, bindings });
          if (calls.length === 1) {
            throw new Error("Transaction conflict: Resource busy. This transaction can be retried");
          }
          return [];
        },
      }),
    } as unknown as Surreal;
    const target = new RecordId("concept", "shared");

    await deleteExtractorTargetWhenUnreferenced(db, "mentions", target);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.bindings).toEqual({ id: target });
    expect(calls[0]?.sql).toBe(
      [
        "BEGIN TRANSACTION;",
        "LET $incoming = (SELECT VALUE id FROM mentions WHERE out = $id LIMIT 1);",
        "DELETE $id WHERE array::len($incoming) = 0 RETURN NONE;",
        "COMMIT TRANSACTION;",
      ].join("\n"),
    );
    expect(calls[1]).toEqual(calls[0]);
  });
});
