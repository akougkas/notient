import { describe, expect, test } from "bun:test";
import { applyPostFilters, buildChunkNoteFilter } from "../../../../src/core/search/filters";

const thresholds = { sparse: 1, connected: 4, hub: 12 };

describe("buildChunkNoteFilter", () => {
  test("empty filters yield empty fragment", () => {
    const fragment = buildChunkNoteFilter(undefined);
    expect(fragment.where).toBe("");
    expect(fragment.bindings).toEqual({});
  });

  test("emits folder + date range + maturity clauses with parameters", () => {
    const fragment = buildChunkNoteFilter({
      folders: ["Projects", "Notes/"],
      maturity: ["draft", "review"],
      fromDate: 1_000,
      toDate: 2_000,
    });
    expect(fragment.where).toContain("string::starts_with(note.path, $f_folder_0)");
    expect(fragment.where).toContain("string::starts_with(note.path, $f_folder_1)");
    expect(fragment.where).toContain("note.maturity INSIDE $f_maturity");
    expect(fragment.where).toContain("note.last_user_edit_at >= $f_from");
    expect(fragment.where).toContain("note.last_user_edit_at <= $f_to");
    expect(fragment.where.startsWith(" AND ")).toBe(true);
    expect(fragment.bindings.f_folder_0).toBe("Projects/");
    expect(fragment.bindings.f_folder_1).toBe("Notes/");
    expect(fragment.bindings.f_maturity).toEqual(["draft", "review"]);
    expect(fragment.bindings.f_from).toBeInstanceOf(Date);
    expect(fragment.bindings.f_to).toBeInstanceOf(Date);
    expect((fragment.bindings.f_from as Date).getTime()).toBe(1_000);
    expect((fragment.bindings.f_to as Date).getTime()).toBe(2_000);
  });

  test("ignores unrelated filter keys", () => {
    const fragment = buildChunkNoteFilter({
      connectivityTiers: ["hub"],
      hasPendingProposals: true,
      minConfidence: 0.7,
      agents: ["linker"],
    });
    expect(fragment.where).toBe("");
    expect(fragment.bindings).toEqual({});
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
