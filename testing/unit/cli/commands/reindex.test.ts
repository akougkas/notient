/**
 * Canonical reindex pattern parsing. Transport behavior is covered by the
 * integration CLI suite; timestamp clearing is covered by the awaken handler.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REINDEX_PATTERN,
  ReindexPatternError,
  resolveReindexPattern,
} from "../../../../src/cli/commands/reindex";

describe("resolveReindexPattern", () => {
  test("keeps the positional glob form", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: "notes/**/*.md",
        flagPattern: undefined,
      }),
    ).toBe("notes/**/*.md");
  });

  test("accepts the --pattern flag form", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: undefined,
        flagPattern: "4-archive/**",
      }),
    ).toBe("4-archive/**");
  });

  test("defaults to the full markdown vault glob when no pattern is supplied", () => {
    expect(resolveReindexPattern({})).toBe(DEFAULT_REINDEX_PATTERN);
  });

  test("accepts both forms when values match", () => {
    expect(
      resolveReindexPattern({
        positionalPattern: "daily/**",
        flagPattern: "daily/**",
      }),
    ).toBe("daily/**");
  });

  test("rejects both forms when values differ", () => {
    expect(() =>
      resolveReindexPattern({
        positionalPattern: "daily/**",
        flagPattern: "archive/**",
      }),
    ).toThrow(ReindexPatternError);
  });

  test("rejects --pattern without a glob value", () => {
    expect(() => resolveReindexPattern({ flagPattern: true })).toThrow(ReindexPatternError);
  });
});
