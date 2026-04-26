import { describe, expect, test } from "bun:test";
import { createIndexerRuntimeConfig } from "./indexerRuntime";

describe("indexer runtime config", () => {
  test("uses the inline indexer pipeline in Obsidian runtime", () => {
    expect(createIndexerRuntimeConfig()).toEqual({
      mode: "inline",
      workerPath: null,
    });
  });
});
