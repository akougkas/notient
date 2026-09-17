import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { VitalsSettings } from "../../../../src/core/vitals/types";
import { VitalsService } from "../../../../src/core/vitals/vitalsService";

interface QueryCall {
  sql: string;
  bindings: Record<string, unknown>;
}

const settings: VitalsSettings = {
  freshnessHalfLifeDays: 14,
  healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
  connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
  writeToFrontmatter: false,
};

function makeServiceHarness(): { service: VitalsService; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => ({
      collect: async () => {
        calls.push({ sql, bindings });
        if (sql.startsWith("SELECT word_count")) {
          return [[{ word_count: 100, maturity: undefined, last_user_edit_at: undefined }]];
        }
        if (sql.includes("FROM chunk")) return [[{ count: 1 }]];
        if (sql.includes("FROM wikilink")) return [[{ count: 2 }]];
        return [[]];
      },
    }),
  } as unknown as Surreal;
  return {
    calls,
    service: new VitalsService({
      db,
      now: () => 1_000,
      settings: () => settings,
      facade: { updateFrontmatter: async () => {} },
    }),
  };
}

describe("VitalsService tombstone boundary", () => {
  test.each([".hidden.md", "folder/.hidden.md", "../escape.md", "note.txt"])(
    "rejects non-public note path %s before querying storage",
    async (path) => {
      const { service, calls } = makeServiceHarness();

      await expect(service.computeSnapshot(path)).rejects.toThrow(
        "vitals note path must be an exact public vault-relative Markdown path",
      );
      expect(calls).toHaveLength(0);
    },
  );

  test("excludes tombstoned notes, chunk owners, and edge endpoints", async () => {
    const { service, calls } = makeServiceHarness();

    const snapshot = await service.computeSnapshot("note.md");

    expect(snapshot?.connectivityCount).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain("path = $path AND tombstoned_at = NONE");
    expect(calls[1].sql).toContain("note.tombstoned_at IS NONE");
    expect(calls[2].sql).toContain("in.tombstoned_at IS NONE");
    expect(calls[2].sql).toContain("in.note.tombstoned_at IS NONE");
    expect(calls[2].sql).toContain("out.tombstoned_at IS NONE");
    expect(calls[2].sql).toContain("out.note.tombstoned_at IS NONE");
    expect(calls.every((call) => call.bindings.path === "note.md")).toBe(true);
  });

  test("guards the persisted snapshot update against a concurrent tombstone", async () => {
    const { service, calls } = makeServiceHarness();

    await service.persistSnapshot("note.md");

    expect(calls).toHaveLength(4);
    expect(calls[3].sql).toContain("WHERE path = $path AND tombstoned_at = NONE");
  });
});
