import { describe, expect, test } from "bun:test";
import { applyPostFilters, buildPathFilter } from "./filters";

const thresholds = { sparse: 1, connected: 4, hub: 12 };

describe("buildPathFilter", () => {
  test("empty filters yield empty fragment", () => {
    const fragment = buildPathFilter(undefined);
    expect(fragment.where).toBe("");
    expect(fragment.params).toEqual([]);
  });

  test("emits folder + date range + maturity clauses with parameters", () => {
    const fragment = buildPathFilter({
      folders: ["Projects", "Notes/"],
      maturity: ["draft", "review"],
      fromDate: 1_000,
      toDate: 2_000,
    });
    expect(fragment.where).toContain("(notes.path LIKE ? OR notes.path LIKE ?)");
    expect(fragment.where).toContain("notes.maturity IN (?,?)");
    expect(fragment.where).toContain("notes.updated_at >= ?");
    expect(fragment.where).toContain("notes.updated_at <= ?");
    expect(fragment.where.startsWith(" AND ")).toBe(true);
    expect(fragment.params).toEqual(["Projects/%", "Notes/%", "draft", "review", 1_000, 2_000]);
  });

  test("ignores unrelated filter keys", () => {
    const fragment = buildPathFilter({
      connectivityTiers: ["hub"],
      hasPendingProposals: true,
      minConfidence: 0.7,
      agents: ["linker"],
    });
    expect(fragment.where).toBe("");
    expect(fragment.params).toEqual([]);
  });
});

describe("applyPostFilters", () => {
  const context = {
    approvedEdgeCountByPath: new Map<string, number>([
      ["a.md", 0],
      ["b.md", 2],
      ["c.md", 6],
      ["d.md", 20],
    ]),
    pendingByPath: new Map<string, number>([
      ["a.md", 0],
      ["b.md", 1],
      ["c.md", 0],
      ["d.md", 5],
    ]),
    thresholds,
  };

  test("returns input unchanged when filters undefined", () => {
    const hits = [{ notePath: "a.md" }];
    expect(applyPostFilters(hits, undefined, context)).toBe(hits);
  });

  test("filters by connectivity tier", () => {
    const hits = [
      { notePath: "a.md" },
      { notePath: "b.md" },
      { notePath: "c.md" },
      { notePath: "d.md" },
    ];
    const result = applyPostFilters(hits, { connectivityTiers: ["hub"] }, context);
    expect(result.map((h) => h.notePath)).toEqual(["d.md"]);
  });

  test("filters by hasPendingProposals", () => {
    const hits = [{ notePath: "a.md" }, { notePath: "b.md" }, { notePath: "c.md" }];
    const result = applyPostFilters(hits, { hasPendingProposals: true }, context);
    expect(result.map((h) => h.notePath)).toEqual(["b.md"]);
  });

  test("combines tier and pending filters", () => {
    const hits = [
      { notePath: "a.md" },
      { notePath: "b.md" },
      { notePath: "c.md" },
      { notePath: "d.md" },
    ];
    const result = applyPostFilters(
      hits,
      { connectivityTiers: ["hub", "connected"], hasPendingProposals: true },
      context,
    );
    expect(result.map((h) => h.notePath)).toEqual(["d.md"]);
  });
});
