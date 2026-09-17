import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import YAML from "yaml";
import { MaturityAdvancer, nextMaturity } from "../../../../src/core/agents/maturityAdvancer";
import { EventBus } from "../../../../src/core/events/eventBus";

const RUN_CONTEXT = {
  trigger: "idle-30m" as const,
  notePath: null,
  signal: new AbortController().signal,
  runId: 'agent_run:u"00000000-0000-4000-8000-000000000001"',
  bus: new EventBus(),
};

class ScriptedDb {
  readonly queries: Array<{ sql: string; bindings: Record<string, unknown> }> = [];

  constructor(private readonly results: unknown[]) {}

  query(sql: string, bindings: Record<string, unknown> = {}) {
    this.queries.push({ sql, bindings });
    const result = this.results.shift();
    return {
      collect: async () => result,
    };
  }
}

class MemoryFacade {
  readonly writes: Array<{ path: string; content: string }> = [];
  conflictsRemaining = 0;

  constructor(readonly files = new Map<string, string>()) {}

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing fixture ${path}`);
    return content;
  }

  async writeIfUnchanged(path: string, expected: string, content: string): Promise<boolean> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      this.files.set(path, `${this.files.get(path) ?? ""}\nexternal edit`);
      return false;
    }
    if (this.files.get(path) !== expected) return false;
    this.files.set(path, content);
    this.writes.push({ path, content });
    return true;
  }
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "a.md",
    word_count: 20,
    maturity: "raw",
    outbound: 0,
    inbound: 0,
    ...overrides,
  };
}

function makeAdvancer(
  db: ScriptedDb,
  facade = new MemoryFacade(),
  writeToFrontmatter = false,
): MaturityAdvancer {
  return new MaturityAdvancer({
    db: db as unknown as Surreal,
    facade,
    settings: () => ({ writeToFrontmatter }),
  });
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const close = content.indexOf("\n---\n", 4);
  if (close < 0) throw new Error("fixture has no closing frontmatter fence");
  return YAML.parse(content.slice(4, close)) as Record<string, unknown>;
}

describe("MaturityAdvancer storage integrity", () => {
  test("accepts native NONE as raw and verifies the promoted row", async () => {
    const db = new ScriptedDb([
      [[candidate({ maturity: undefined })]],
      [[{ path: "a.md", maturity: "adolescent" }]],
    ]);
    const result = await makeAdvancer(db).run(RUN_CONTEXT);

    expect(result).toEqual({ proposals: 1 });
    expect(db.queries[1]?.sql).toContain("RETURN AFTER");
  });

  test.each([
    ["null maturity", candidate({ maturity: null }), "null instead of NONE"],
    ["unknown maturity", candidate({ maturity: "legacy" }), "stored maturity is invalid"],
    ["fractional words", candidate({ word_count: 1.5 }), "word_count"],
    ["negative inbound", candidate({ inbound: -1 }), "inbound"],
    ["non-finite outbound", candidate({ outbound: Number.NaN }), "outbound"],
    ["blank path", candidate({ path: "  " }), "candidate path"],
  ])("rejects a corrupt %s row", async (_label, row, message) => {
    const db = new ScriptedDb([[[row]]]);
    await expect(makeAdvancer(db).run(RUN_CONTEXT)).rejects.toThrow(message);
    expect(db.queries).toHaveLength(1);
  });

  test("rejects a malformed statement envelope", async () => {
    const db = new ScriptedDb([[candidate()]]);
    await expect(makeAdvancer(db).run(RUN_CONTEXT)).rejects.toThrow("invalid statement envelope");
  });

  test("skips a candidate whose maturity changed before the guarded DB promotion", async () => {
    const db = new ScriptedDb([[[candidate()]], [[]]]);
    expect(await makeAdvancer(db).run(RUN_CONTEXT)).toEqual({ proposals: 0 });
  });
});

describe("MaturityAdvancer frontmatter writeback", () => {
  test("changes maturity without inventing or overwriting other vitals", async () => {
    const before = `---
title: A
notient:
  vitals:
    health: 0.42
    freshness: 0.73
  keeper: yes
---
# A
`;
    const facade = new MemoryFacade(new Map([["a.md", before]]));
    const db = new ScriptedDb([[[candidate()]], [[{ path: "a.md", maturity: "adolescent" }]]]);
    await makeAdvancer(db, facade, true).run(RUN_CONTEXT);

    expect(facade.writes).toHaveLength(1);
    const root = parseFrontmatter(facade.files.get("a.md") ?? "");
    const notient = root.notient as Record<string, unknown>;
    const vitals = notient.vitals as Record<string, unknown>;
    expect(vitals).toEqual({ health: 0.42, freshness: 0.73, maturity: "adolescent" });
    expect(notient.keeper).toBe("yes");
  });

  test("rejects an unterminated frontmatter block instead of prepending another one", async () => {
    const facade = new MemoryFacade(new Map([["a.md", "---\ntitle: broken\n# A\n"]]));
    const db = new ScriptedDb([[[candidate()]], [[{ path: "a.md", maturity: "adolescent" }]]]);

    await expect(makeAdvancer(db, facade, true).run(RUN_CONTEXT)).rejects.toThrow(
      "no closing fence",
    );
    expect(facade.writes).toEqual([]);
  });

  test("re-reads and retries after an external frontmatter write race", async () => {
    const facade = new MemoryFacade(new Map([["a.md", "# A\n"]]));
    facade.conflictsRemaining = 1;
    const db = new ScriptedDb([[[candidate()]], [[{ path: "a.md", maturity: "adolescent" }]]]);

    await makeAdvancer(db, facade, true).run(RUN_CONTEXT);

    expect(facade.writes).toHaveLength(1);
    expect(facade.files.get("a.md")).toContain("external edit");
    expect(facade.files.get("a.md")).toContain("maturity: adolescent");
  });

  test("surfaces a persistent guarded frontmatter conflict", async () => {
    const facade = new MemoryFacade(new Map([["a.md", "# A\n"]]));
    facade.conflictsRemaining = 5;
    const db = new ScriptedDb([[[candidate()]], [[{ path: "a.md", maturity: "adolescent" }]]]);

    await expect(makeAdvancer(db, facade, true).run(RUN_CONTEXT)).rejects.toThrow(
      "maturity frontmatter conflict",
    );
    expect(facade.writes).toEqual([]);
    expect(db.queries).toHaveLength(1);
  });

  test("rolls back exact frontmatter bytes when the DB promotion loses its precondition", async () => {
    const before = "# A\n";
    const facade = new MemoryFacade(new Map([["a.md", before]]));
    const db = new ScriptedDb([[[candidate()]], [[]], [[{ maturity: "raw" }]]]);

    expect(await makeAdvancer(db, facade, true).run(RUN_CONTEXT)).toEqual({ proposals: 0 });

    expect(facade.files.get("a.md")).toBe(before);
    expect(facade.writes).toHaveLength(2);
    expect(db.queries[2]?.sql).toContain("SELECT maturity FROM note");
  });
});

describe("nextMaturity numeric integrity", () => {
  test.each([
    { word_count: -1, inbound: 0, outbound: 0 },
    { word_count: 1.5, inbound: 0, outbound: 0 },
    { word_count: 1, inbound: Number.POSITIVE_INFINITY, outbound: 0 },
  ])("rejects corrupt ladder counts", (counts) => {
    expect(() => nextMaturity("raw", counts)).toThrow("safe integer");
  });
});
