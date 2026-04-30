import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { EDGE_TABLES } from "./edgeTables";
import { applySchema } from "./schemaApplier";

interface RecordedCall {
  method: "set" | "query";
  args: unknown[];
  index: number;
}

function createFakeSurreal(): {
  db: Surreal;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const stub = {
    set(key: string, value: unknown): Promise<void> {
      calls.push({ method: "set", args: [key, value], index: index++ });
      return Promise.resolve();
    },
    query(sql: string): Promise<unknown> {
      calls.push({ method: "query", args: [sql], index: index++ });
      return Promise.resolve([]);
    },
  };
  // Justified cast: the applier uses only `set` and `query`, so a minimal stub
  // is sufficient for behavioral tests without pulling in the full SDK shape.
  return { db: stub as unknown as Surreal, calls };
}

describe("applySchema", () => {
  test("calls set with NOTIENT_AGENT_JWT_KEY before any query", async () => {
    const { db, calls } = createFakeSurreal();

    await applySchema(db, "test-secret-value");

    const setCalls = calls.filter((call) => call.method === "set");
    const queryCalls = calls.filter((call) => call.method === "query");

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.args[0]).toBe("NOTIENT_AGENT_JWT_KEY");
    expect(setCalls[0]?.args[1]).toBe("test-secret-value");
    expect(queryCalls.length).toBeGreaterThan(0);
    const firstQueryIndex = queryCalls[0]?.index ?? -1;
    expect(setCalls[0]?.index).toBeLessThan(firstQueryIndex);
  });

  test("base schema query contains the canonical DDL strings", async () => {
    const { db, calls } = createFakeSurreal();

    await applySchema(db, "secret");

    const combined = calls
      .filter((call) => call.method === "query")
      .map((call) => call.args[0] as string)
      .join("\n");

    expect(combined).toContain("DEFINE NAMESPACE IF NOT EXISTS notient");
    expect(combined).toContain("DEFINE TABLE OVERWRITE note SCHEMAFULL");
    expect(combined).toContain("DEFINE TABLE OVERWRITE wikilink TYPE RELATION");
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE kind ON concept TYPE string DEFAULT 'other'",
    );
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE source ON concept TYPE string DEFAULT 'extractor'",
    );
    expect(combined).toContain(
      "DEFINE FIELD OVERWRITE kind ON claim TYPE string DEFAULT 'assertion'",
    );
    expect(combined).toContain("DEFINE ACCESS OVERWRITE agent_jwt");
  });

  test("provenance query emits one source field per edge table", async () => {
    const { db, calls } = createFakeSurreal();

    await applySchema(db, "secret");

    const queryCalls = calls.filter((call) => call.method === "query");
    expect(queryCalls).toHaveLength(2);

    const provenanceSql = queryCalls[1]?.args[0] as string;
    expect(provenanceSql).toContain("DEFINE FIELD OVERWRITE source ON wikilink");
    expect(provenanceSql).toContain("DEFINE FIELD OVERWRITE source ON related_to");

    const sourceFieldMatches = provenanceSql.match(/DEFINE FIELD OVERWRITE source ON /g);
    expect(sourceFieldMatches).not.toBeNull();
    expect(sourceFieldMatches?.length).toBe(EDGE_TABLES.length);
    expect(EDGE_TABLES.length).toBe(15);
  });
});
