import { expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import { contentRevision } from "../../../../src/api/notes";
import { NoteRetrieval } from "../../../../src/core/search/retrieval";

test("hybrid retrieval retains grounded lexical results during an embedding outage; semantic-only and cancellation stay explicit", async () => {
  const body = "# Storage\nA durable journal protects committed writes.";
  const controller = new AbortController();
  const retrieval = new NoteRetrieval({
    vault: {
      listMarkdown: async () => {
        throw new Error("retrieval must not walk the entire vault");
      },
      isIndexablePath: () => true,
      read: async () => body,
      readBounded: async () => body,
    },
    db: {
      query: (sql: string) => ({
        collect: async () =>
          sql.startsWith("SELECT path FROM note")
            ? [[{ path: "Storage.md" }]]
            : [
                [
                  {
                    id: new RecordId("chunk", "journal"),
                    note: { id: new RecordId("note", "storage"), path: "Storage.md" },
                    text: body,
                    source_revision: contentRevision(body),
                    start_line: 1,
                    end_line: 2,
                    score: 1,
                  },
                ],
              ],
      }),
    } as unknown as Surreal,
    embed: async () => {
      throw new Error("endpoint unavailable");
    },
  });
  const result = await retrieval.search(
    { query: "journal", mode: "hybrid", limit: 3, scope: {} },
    controller.signal,
  );
  expect(result.hits[0].evidence?.quote).toBe(body);
  expect(result.coverage.state).toBe("incomplete");
  expect(result.coverage.message).toContain("lexical results only");
  await expect(
    retrieval.search(
      { query: "journal", mode: "semantic", limit: 3, scope: {} },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "INFERENCE_UNAVAILABLE" });
  controller.abort();
  await expect(
    retrieval.search({ query: "journal", mode: "hybrid", limit: 3, scope: {} }, controller.signal),
  ).rejects.toThrow();
});

test("indexed candidates keep live exclusions, scope and changed/deleted evidence authoritative without a filesystem walk", async () => {
  const signal = new AbortController().signal;
  const original = "---\ntags: [research]\n---\n# Evidence\nJournal evidence.";
  let excluded = "Private/Hidden.md";
  let changeDuringQuery = false;
  const files = new Map([
    ["Inbox/Good.md", original],
    ["Inbox-old/Outside.md", original],
    ["Private/Hidden.md", original],
    ["Inbox/Changed.md", `${original}\nNew human edit.`],
  ]);
  const paths = [...files.keys(), "Inbox/Deleted.md"];
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    const body = files.get(path);
    if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return body;
  };
  const retrieval = new NoteRetrieval({
    vault: {
      listMarkdown: async () => {
        throw new Error("unexpected filesystem walk");
      },
      isIndexablePath: (path) => path !== excluded,
      read,
      readBounded: read,
    },
    db: {
      query: (sql: string, bindings: Record<string, unknown> = {}) => ({
        collect: async () => {
          if (sql.startsWith("SELECT path FROM note")) return [paths.map((path) => ({ path }))];
          if (changeDuringQuery) excluded = "Inbox/Good.md";
          return [
            (bindings.f_paths as string[]).map((path, index) => ({
              id: new RecordId("chunk", `c${index}`),
              note: { id: new RecordId("note", `n${index}`), path },
              text: original,
              source_revision: contentRevision(original),
              start_line: 1,
              end_line: 6,
              score: 1,
            })),
          ];
        },
      }),
    } as unknown as Surreal,
    embed: async () => null,
  });
  const request = { query: "journal", mode: "lexical", limit: 10, scope: { folders: ["Inbox"] } };
  const first = await retrieval.search(request, signal);
  expect(first.hits.map((hit) => hit.note.path).sort()).toEqual([
    "Inbox/Changed.md",
    "Inbox/Good.md",
  ]);
  expect(first.hits.find((hit) => hit.note.path === "Inbox/Good.md")?.evidence?.quote).toBe(
    original,
  );
  expect(first.hits.find((hit) => hit.note.path === "Inbox/Changed.md")?.freshness.state).toBe(
    "lagging",
  );
  expect(first.hits.find((hit) => hit.note.path === "Inbox/Changed.md")?.evidence).toBeNull();
  expect(first.omitted).toBe(1);
  expect(reads).not.toContain("Private/Hidden.md");
  expect(reads).not.toContain("Inbox-old/Outside.md");
  reads.length = 0;
  changeDuringQuery = true;
  const second = await retrieval.search(request, signal);
  expect(second.hits.map((hit) => hit.note.path)).toEqual(["Inbox/Changed.md"]);
  expect(reads).not.toContain("Inbox/Good.md");
  files.set("Inbox/Changed.md", "---\ntags: [private]\n---\nJournal evidence.");
  const scoped = await retrieval.search(
    { ...request, scope: { folders: ["Inbox"], tags: ["research"] } },
    signal,
  );
  expect(scoped.hits).toEqual([]);
});

test("named-note retrieval finds a filename absent from the body without bypassing scope or revision guards", async () => {
  const original = "# Native storage\nKeep durable buffers close to the application.\n";
  let body = original;
  const path = "Projects/Orchid — storage engine.md";
  let excluded = false;
  const reads: string[] = [];
  const read = async (name: string) => {
    reads.push(name);
    return body;
  };
  const retrieval = new NoteRetrieval({
    vault: {
      read,
      readBounded: read,
      listMarkdown: async () => {
        throw new Error("no walk");
      },
      isIndexablePath: () => !excluded,
    },
    db: {
      query: (sql: string) => ({
        collect: async () => {
          if (sql.startsWith("SELECT path FROM note")) return [[{ path }]];
          if (sql.startsWith("SELECT sha FROM note")) return [[{ sha: contentRevision(original) }]];
          return [[]];
        },
      }),
    } as unknown as Surreal,
    embed: async () => null,
  });
  const request = { query: "Orchid", mode: "lexical", limit: 5, scope: {} };
  const signal = new AbortController().signal;
  const result = await retrieval.search(request, signal);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.scoreKind).toBe("reciprocal-rank");
  const evidence = result.hits[0]?.evidence;
  if (!evidence) throw new Error("Named source must carry evidence");
  expect(evidence.quote).toBe(original);
  expect(
    (await retrieval.context({ query: "Orchid", scope: {}, limit: 5, maxCharacters: 5000 }, signal))
      .sources,
  ).toEqual([evidence]);
  expect((await retrieval.search({ ...request, query: '"Orchid"' }, signal)).hits).toEqual([]);
  expect((await retrieval.search({ ...request, query: "Orch" }, signal)).hits).toEqual([]);
  reads.length = 0;
  expect(
    (await retrieval.search({ ...request, scope: { folders: ["Private"] } }, signal)).hits,
  ).toEqual([]);
  expect(reads).toEqual([]);
  body += "A newer edit.\n";
  const stale = await retrieval.search(request, signal);
  expect(stale.hits[0]?.freshness.state).toBe("lagging");
  expect(stale.hits[0]?.evidence).toBeNull();
  excluded = true;
  expect((await retrieval.search(request, signal)).hits).toEqual([]);
});
