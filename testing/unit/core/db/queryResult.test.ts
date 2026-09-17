import { describe, expect, test } from "bun:test";
import {
  isExactRecord,
  readAggregateCount,
  readSingleStatementRows,
} from "../../../../src/core/db/queryResult";

describe("SurrealDB query result contracts", () => {
  test("reads the exact single-statement envelope", () => {
    const rows = [{ id: "one" }];
    expect(readSingleStatementRows([rows], "test query")).toBe(rows);
  });

  test.each([[undefined], [null], [{}], [[]], [[[{}], []]], [[{}]]])(
    "rejects malformed statement envelope %p",
    (raw) => {
      expect(() => readSingleStatementRows(raw, "test query")).toThrow(/statement result envelope/);
    },
  );

  test("reads empty and populated aggregate counts", () => {
    expect(readAggregateCount([[]], "test count")).toBe(0);
    expect(readAggregateCount([[{ count: 42 }]], "test count")).toBe(42);
  });

  test.each([
    [[{ count: 1 }, { count: 2 }]],
    [[{ count: -1 }]],
    [[{ count: 1.5 }]],
    [[{ count: Number.NaN }]],
    [[{ count: "1" }]],
    [[{ count: 1, legacy: true }]],
    [[{}]],
  ])("rejects malformed aggregate count result %p", (raw) => {
    expect(() => readAggregateCount(raw, "test count")).toThrow(/storage integrity/);
  });

  test("matches exact records without accepting extra or missing keys", () => {
    expect(isExactRecord({ source: "linker", count: 1 }, ["source", "count"])).toBe(true);
    expect(isExactRecord({ source: "linker" }, ["source", "count"])).toBe(false);
    expect(isExactRecord({ source: "linker", count: 1, old: true }, ["source", "count"])).toBe(
      false,
    );
  });
});
