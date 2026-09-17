import { describe, expect, test } from "bun:test";
import { assertCompatibleEmbeddingSnapshot } from "../../../../src/cli/commands/embeddingSnapshot";

describe("restore embedding compatibility", () => {
  test("accepts only an exact model and dimension match", () => {
    const backup = { model: "local/model-a", dimension: 768 };

    expect(() => assertCompatibleEmbeddingSnapshot(backup, { ...backup })).not.toThrow();
    expect(() =>
      assertCompatibleEmbeddingSnapshot(backup, { model: "local/model-b", dimension: 768 }),
    ).toThrow("restore embedding mismatch");
    expect(() =>
      assertCompatibleEmbeddingSnapshot(backup, { model: "local/model-a", dimension: 1_024 }),
    ).toThrow("restore embedding mismatch");
  });
});
