import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { VaultPathError } from "../../../../src/adapters/vaultAdapter";
import { readNoteNeighbors } from "../../../../src/core/graph/noteNeighbors";
import {
  type SentientHandlerDeps,
  makeSentientHandlers as createSentientHandlers,
  readActiveNotePath,
  readSwarmStatus,
} from "../../../../src/daemon/handlers/sentient";
import { RpcError } from "../../../../src/daemon/rpc";
import { rpcRequest } from "../../../rpcRequest";

const makeSentientHandlers = (deps: Omit<SentientHandlerDeps, "graph">) =>
  createSentientHandlers({
    ...deps,
    graph: {
      path: async () => {
        throw new Error("path was not requested");
      },
    },
  });

type Responder = (sql: string, bindings: Record<string, unknown>) => unknown[];

function makeFakeDb(respond: Responder, autoLiveNeighborSource = true): Surreal {
  return {
    query: (sql: string, bindings: Record<string, unknown> = {}) => ({
      collect: async () => [
        autoLiveNeighborSource &&
        sql.startsWith("SELECT id, path FROM note") &&
        sql.includes("tombstoned_at IS NONE")
          ? [{ id: new RecordId("note", "source0000000000000001"), path: bindings.path }]
          : respond(sql, bindings).map((row, index) =>
              typeof row === "object" && row !== null && "fromPath" in row
                ? {
                    id: new RecordId(sql.match(/FROM (\w+)/)?.[1] ?? "wikilink", String(index)),
                    ...row,
                  }
                : row,
            ),
      ],
    }),
  } as unknown as Surreal;
}

const accessibleVault = { exists: async () => true };

describe("vault.neighbors public note boundary", () => {
  test("requires one exact indexed public note before graph traversal", async () => {
    const queries: string[] = [];
    const checked: string[] = [];
    const db = makeFakeDb((sql, bindings) => {
      queries.push(sql);
      if (sql.startsWith("SELECT id, path FROM note")) {
        return [{ id: new RecordId("note", "a0000000000000000001"), path: bindings.path }];
      }
      return [];
    });
    const result = await makeSentientHandlers({
      db,
      vault: {
        exists: async (path) => {
          checked.push(path);
          return true;
        },
      },
    }).neighbors(rpcRequest({ notePath: "a.md", includePending: false }));
    expect(result).toEqual({ ok: true, notePath: "a.md", neighbors: [] });
    expect(checked).toEqual(["a.md"]);
    expect(queries[0]).toContain("tombstoned_at = NONE");
    expect(queries).toHaveLength(10);
  });

  test.each([".notient/.env", "../outside.md", "/etc/passwd"])(
    "rejects nonpublic path %s before filesystem or database access",
    async (notePath) => {
      let touched = false;
      const db = makeFakeDb(() => {
        touched = true;
        return [];
      });
      const error = await makeSentientHandlers({
        db,
        vault: {
          exists: async () => {
            touched = true;
            return true;
          },
        },
      })
        .neighbors(rpcRequest({ notePath }))
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect(touched).toBe(false);
    },
  );

  test("rejects missing and symlink-escaping notes before database access", async () => {
    for (const vault of [
      { exists: async () => false },
      {
        exists: async () => {
          throw new VaultPathError("escape");
        },
      },
    ]) {
      let queries = 0;
      const db = makeFakeDb(() => {
        queries += 1;
        return [];
      });
      const error = await makeSentientHandlers({ db, vault })
        .neighbors(rpcRequest({ notePath: "escape/secret.md" }))
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect(queries).toBe(0);
    }
  });

  test("rejects an accessible note that is not indexed", async () => {
    const error = await makeSentientHandlers({ db: makeFakeDb(() => []), vault: accessibleVault })
      .neighbors(rpcRequest({ notePath: "missing.md" }))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("not indexed");
  });

  test("fails closed on duplicate or malformed indexed-note rows", async () => {
    const id = new RecordId("note", "a0000000000000000001");
    for (const rows of [
      [
        { id, path: "a.md" },
        { id: new RecordId("note", "a0000000000000000002"), path: "a.md" },
      ],
      [{ id: "note:a", path: "a.md" }],
      [{ id, path: "other.md" }],
      [{ id, path: "a.md", extra: true }],
    ]) {
      const db = makeFakeDb(() => rows);
      await expect(
        makeSentientHandlers({ db, vault: accessibleVault }).neighbors(
          rpcRequest({ notePath: "a.md" }),
        ),
      ).rejects.toThrow("neighbor note storage integrity");
    }
  });
});

describe("readNeighbors", () => {
  test("requires one exact live indexed source note", async () => {
    const queries: string[] = [];
    const db = makeFakeDb((sql) => {
      queries.push(sql);
      return [];
    }, false);
    await expect(readNoteNeighbors(db, "missing.md")).rejects.toThrow("source note is missing");
    expect(queries[0]).toContain("tombstoned_at IS NONE");
  });

  test("labels direction relative to the queried note", async () => {
    const db = makeFakeDb((sql) =>
      sql.includes("FROM supports")
        ? [
            {
              fromPath: "a.md",
              toPath: "b.md",
              source: "linker",
              agent: "linker",
              confidence: 0.9,
            },
            {
              fromPath: "c.md",
              toPath: "a.md",
              source: "linker",
              agent: "linker",
              confidence: 0.7,
            },
          ]
        : [],
    );
    const neighbors = await readNoteNeighbors(db, "a.md");
    expect(neighbors).toEqual([
      {
        notePath: "b.md",
        table: "supports",
        direction: "outgoing",
        agent: "linker",
        confidence: 0.9,
        proposed: false,
      },
      {
        notePath: "c.md",
        table: "supports",
        direction: "incoming",
        agent: "linker",
        confidence: 0.7,
        proposed: false,
      },
    ]);
  });

  test("filters on approved and applied so pending proposals stay hidden", async () => {
    let seen = "";
    const db = makeFakeDb((sql) => {
      if (seen === "") seen = sql;
      return [];
    });
    await readNoteNeighbors(db, "a.md");
    expect(seen).toContain("approved = true AND applied = true");
    expect(seen).toContain("tombstoned_at");
    expect(seen).toContain("in.note.path");
  });

  test("rejects self-edges and rows with a null endpoint", async () => {
    const db = makeFakeDb((sql) =>
      sql.includes("FROM supports")
        ? [
            {
              fromPath: "a.md",
              toPath: "a.md",
              source: "linker",
              agent: "linker",
              confidence: 0.8,
            },
            {
              fromPath: null,
              toPath: "b.md",
              source: "linker",
              agent: "linker",
              confidence: 0.8,
            },
          ]
        : [],
    );
    await expect(readNoteNeighbors(db, "a.md")).rejects.toThrow("incident to one other note");
  });

  test("resolves block-anchored wikilinks through their live public parent notes", async () => {
    const db = makeFakeDb((sql) =>
      sql.includes("FROM wikilink")
        ? [
            {
              fromPath: "block-parent.md",
              toPath: "a.md",
              source: "wikilink",
              agent: undefined,
              confidence: 1,
            },
          ]
        : [],
    );
    expect(await readNoteNeighbors(db, "a.md")).toEqual([
      {
        notePath: "block-parent.md",
        table: "wikilink",
        direction: "incoming",
        agent: "wikilink",
        confidence: 1,
        proposed: false,
      },
    ]);
  });

  test("rejects private endpoint paths returned by corrupt storage", async () => {
    const db = makeFakeDb((sql) =>
      sql.includes("FROM supports")
        ? [
            {
              fromPath: "a.md",
              toPath: ".hidden.md",
              source: "linker",
              agent: "linker",
              confidence: 0.8,
            },
          ]
        : [],
    );
    await expect(readNoteNeighbors(db, "a.md")).rejects.toThrow("private or invalid");
  });
});

describe("readNeighbors with includePending", () => {
  test("pending linker rows are excluded by default", async () => {
    const seen: string[] = [];
    const db = makeFakeDb((sql) => {
      seen.push(sql);
      return [];
    });
    await readNoteNeighbors(db, "a.md");
    // One query per table: wikilink, embed, frontmatter_ref plus the six writeback tables.
    expect(seen).toHaveLength(9);
    expect(seen.some((sql) => sql.includes("approved = false"))).toBe(false);
  });

  test("includePending adds a second pass over the six linker tables only", async () => {
    const seen: string[] = [];
    const db = makeFakeDb((sql) => {
      seen.push(sql);
      return [];
    });
    await readNoteNeighbors(db, "a.md", { includePending: true });
    expect(seen).toHaveLength(15);
    expect(seen.filter((sql) => sql.includes("approved = false"))).toHaveLength(6);
    expect(seen.some((sql) => sql.includes("FROM wikilink WHERE approved = false"))).toBe(false);
  });

  test("a pending row is flagged proposed, an applied row is not", async () => {
    const db = makeFakeDb((sql) => {
      if (!sql.includes("FROM supports")) return [];
      return sql.includes("approved = false")
        ? [
            {
              fromPath: "a.md",
              toPath: "pending.md",
              source: "linker",
              agent: "linker",
              confidence: 0.4,
            },
          ]
        : [
            {
              fromPath: "a.md",
              toPath: "live.md",
              source: "linker",
              agent: "linker",
              confidence: 0.9,
            },
          ];
    });
    const neighbors = await readNoteNeighbors(db, "a.md", { includePending: true });
    expect(neighbors).toEqual([
      {
        notePath: "live.md",
        table: "supports",
        direction: "outgoing",
        agent: "linker",
        confidence: 0.9,
        proposed: false,
      },
      {
        notePath: "pending.md",
        table: "supports",
        direction: "outgoing",
        agent: "linker",
        confidence: 0.4,
        proposed: true,
      },
    ]);
  });
});

describe("readActiveNotePath", () => {
  test("returns the most recently edited note", async () => {
    const db = makeFakeDb(() => [
      {
        path: "notes/latest.md",
        last_user_edit_at: new DateTime(new Date(1_800_000_000_000)),
      },
    ]);
    expect(await readActiveNotePath(db)).toBe("notes/latest.md");
  });

  test("returns null when nothing has been edited", async () => {
    const db = makeFakeDb(() => []);
    expect(await readActiveNotePath(db)).toBeNull();
  });

  test("projects the order-by field, which surreal requires", async () => {
    let seen = "";
    const db = makeFakeDb((sql) => {
      seen = sql;
      return [];
    });
    await readActiveNotePath(db);
    expect(seen).toContain("SELECT path, last_user_edit_at FROM note");
    expect(seen).toContain("ORDER BY last_user_edit_at DESC");
  });

  test("excludes tombstoned notes", async () => {
    let seen = "";
    const db = makeFakeDb((sql) => {
      seen = sql;
      return [];
    });
    await readActiveNotePath(db);
    expect(seen).toContain("tombstoned_at = NONE");
  });

  test("rejects a private or malformed active-note path from storage", async () => {
    for (const path of [".notient/private.md", "notes//invalid.md", "notes/not-markdown.txt"]) {
      const db = makeFakeDb(() => [
        { path, last_user_edit_at: new DateTime(new Date(1_800_000_000_000)) },
      ]);
      await expect(readActiveNotePath(db), path).rejects.toThrow(
        "active note storage integrity: path is private or invalid",
      );
    }
  });
});

describe("readSwarmStatus", () => {
  test("projects the order-by field, which surreal requires", async () => {
    let seen = "";
    const db = makeFakeDb((sql) => {
      seen = sql;
      return [];
    });
    await readSwarmStatus(db);
    expect(seen).toContain("started_at");
    expect(seen).toContain("ORDER BY started_at DESC");
  });

  test("reports idle for an agent that has never run", async () => {
    const db = makeFakeDb(() => []);
    const statuses = await readSwarmStatus(db);
    expect(statuses).toHaveLength(4);
    expect(statuses.every((s) => s.state === "idle")).toBe(true);
  });

  test("reports running while finished_at is unset", async () => {
    const db = makeFakeDb((_sql, bindings) =>
      bindings.agent === "linker" ? [{ agent: "linker", started_at: 1, proposals_count: 0 }] : [],
    );
    const linker = (await readSwarmStatus(db)).find((s) => s.agent === "linker");
    expect(linker?.state).toBe("running");
  });

  test("reports error when the last run failed", async () => {
    const db = makeFakeDb((_sql, bindings) =>
      bindings.agent === "synthesizer"
        ? [
            {
              agent: "synthesizer",
              started_at: 1,
              finished_at: 42,
              ok: false,
              proposals_count: 0,
            },
          ]
        : [],
    );
    const synth = (await readSwarmStatus(db)).find((s) => s.agent === "synthesizer");
    expect(synth?.state).toBe("error");
  });

  test("carries the proposal count of a successful run", async () => {
    const db = makeFakeDb((_sql, bindings) =>
      bindings.agent === "linker"
        ? [{ agent: "linker", started_at: 1, finished_at: 99, ok: true, proposals_count: 3 }]
        : [],
    );
    const linker = (await readSwarmStatus(db)).find((s) => s.agent === "linker");
    expect(linker).toEqual({ agent: "linker", state: "ok", proposals: 3, finishedAt: 99 });
  });

  test("rejects finished runs without a final result", async () => {
    const db = makeFakeDb((_sql, bindings) =>
      bindings.agent === "linker"
        ? [{ agent: "linker", started_at: 1, finished_at: 99, proposals_count: 3 }]
        : [],
    );
    await expect(readSwarmStatus(db)).rejects.toThrow("linker finished row is incomplete");
  });

  test("rejects a row for another agent or a malformed proposal count", async () => {
    const wrongAgent = makeFakeDb((_sql, bindings) =>
      bindings.agent === "linker"
        ? [{ agent: "synthesizer", started_at: 1, proposals_count: 0 }]
        : [],
    );
    await expect(readSwarmStatus(wrongAgent)).rejects.toThrow(
      "linker query returned another agent",
    );

    const badCount = makeFakeDb((_sql, bindings) =>
      bindings.agent === "linker"
        ? [{ agent: "linker", started_at: 1, proposals_count: null }]
        : [],
    );
    await expect(readSwarmStatus(badCount)).rejects.toThrow("linker proposal count is invalid");
  });
});
