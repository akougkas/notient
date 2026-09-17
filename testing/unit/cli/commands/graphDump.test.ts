import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import {
  decodeDumpEdge,
  decodeDumpNode,
  parseDumpFormat,
  parseDumpTier,
} from "../../../../src/cli/commands/graphDump";

describe("graph dump argument parsers", () => {
  test("parseDumpTier accepts 1, 2, 3", () => {
    expect(parseDumpTier("1")).toBe(1);
    expect(parseDumpTier("2")).toBe(2);
    expect(parseDumpTier("3")).toBe(3);
    expect(parseDumpTier(undefined)).toBeUndefined();
  });

  test("parseDumpTier rejects out-of-range and non-numeric", () => {
    expect(() => parseDumpTier("0")).toThrow();
    expect(() => parseDumpTier("4")).toThrow();
    expect(() => parseDumpTier("abc")).toThrow();
    expect(() => parseDumpTier(1)).toThrow();
    expect(() => parseDumpTier(" 1")).toThrow();
  });

  test("parseDumpFormat defaults to json and accepts the three supported formats", () => {
    expect(parseDumpFormat(undefined)).toBe("json");
    expect(parseDumpFormat("json")).toBe("json");
    expect(parseDumpFormat("graphml")).toBe("graphml");
    expect(parseDumpFormat("cypher")).toBe("cypher");
  });

  test("parseDumpFormat rejects unknown formats", () => {
    expect(() => parseDumpFormat("dot")).toThrow();
  });
});

describe("graph dump storage contracts", () => {
  test("decodes native node attributes without generic string coercion", () => {
    const node = decodeDumpNode(
      {
        id: new RecordId("note", "alpha"),
        path: "alpha.md",
        tier1_at: new DateTime("2026-08-29T12:00:00Z"),
        optional: undefined,
        nested: { target: new RecordId("note", "beta") },
      },
      "note",
    );
    expect(node).toEqual({
      id: "note:alpha",
      table: "note",
      attributes: {
        path: "alpha.md",
        tier1_at: "2026-08-29T12:00:00.000Z",
        optional: null,
        nested: { target: "note:beta" },
      },
    });
  });

  test("decodes the exact native edge row", () => {
    const edge = decodeDumpEdge(
      {
        id: new RecordId("supports", "proposal"),
        in: new RecordId("note", "alpha"),
        out: new RecordId("note", "beta"),
        source: "linker",
        class: "INFERRED",
        confidence: 0.8,
        evidence: [new RecordId("chunk", "evidence")],
        agent: "linker",
        approved: false,
        applied: true,
        created_at: new DateTime("2026-08-29T12:00:00Z"),
      },
      "supports",
    );
    expect(edge).toMatchObject({
      id: "supports:proposal",
      table: "supports",
      in: "note:alpha",
      out: "note:beta",
      source: "linker",
      confidenceClass: "INFERRED",
      createdAt: "2026-08-29T12:00:00.000Z",
      attributes: {
        confidence: 0.8,
        evidence: ["chunk:evidence"],
        agent: "linker",
        approved: false,
        applied: true,
      },
    });
  });

  test.each([
    ["string id", { id: "note:alpha", path: "alpha.md" }, "note"],
    ["wrong table", { id: new RecordId("chunk", "alpha"), path: "alpha.md" }, "note"],
    ["unsupported Date alias", { id: new RecordId("note", "alpha"), at: new Date() }, "note"],
  ])("rejects a node with %s", (_label, row, table) => {
    expect(() => decodeDumpNode(row, table as "note")).toThrow(/storage integrity/);
  });

  test.each([
    ["an extra field", { legacy: true }],
    ["a string created_at alias", { created_at: "2026-08-29T12:00:00Z" }],
    ["a missing source", { source: undefined }],
    [
      "duplicate evidence",
      { evidence: [new RecordId("chunk", "one"), new RecordId("chunk", "one")] },
    ],
  ])("rejects an edge with %s", (_label, replacement) => {
    const row: Record<string, unknown> = {
      id: new RecordId("supports", "proposal"),
      in: new RecordId("note", "alpha"),
      out: new RecordId("note", "beta"),
      source: "linker",
      class: "INFERRED",
      confidence: 0.8,
      evidence: [new RecordId("chunk", "one")],
      agent: "linker",
      approved: false,
      applied: true,
      created_at: new DateTime("2026-08-29T12:00:00Z"),
      ...replacement,
    };
    expect(() => decodeDumpEdge(row, "supports")).toThrow(/storage integrity/);
  });

  test("requires evidence on extractor edges", () => {
    expect(() =>
      decodeDumpEdge(
        {
          id: new RecordId("mentions", "relation"),
          in: new RecordId("note", "alpha"),
          out: new RecordId("concept", "beta"),
          source: "extractor",
          class: "INFERRED",
          confidence: 0.8,
          approved: true,
          applied: true,
          created_at: new DateTime("2026-08-29T12:00:00Z"),
        },
        "mentions",
      ),
    ).toThrow(/lacks evidence/);
  });
});
