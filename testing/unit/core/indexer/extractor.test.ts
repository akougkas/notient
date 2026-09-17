import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal, Table } from "surrealdb";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import {
  Extractor,
  type ExtractorOptions,
  PartialExtractionError,
  buildExtractionWindows,
  filterNoiseEntities,
  writeExtractionToSurreal,
} from "../../../../src/core/indexer/extractor";
import type { Chunk } from "../../../../src/core/indexer/types";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";

function makeExtractor(
  provider: LLMProvider,
  options: Omit<ExtractorOptions, "scheduler">,
): Extractor {
  return new Extractor(provider, {
    ...options,
    scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
  });
}

function chunk(text: string, ord = 0): Chunk {
  return {
    id: `c${ord}`,
    notePath: "/n.md",
    ord,
    text,
    sha: "sha",
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

/** A realistically sized chunk: 320 tokens, matching CHUNK.targetTokens. */
function fullChunk(ord: number): Chunk {
  return chunk(`chunk ${ord} `.padEnd(1280, "z"), ord);
}

function fullChunks(count: number): Chunk[] {
  return Array.from({ length: count }, (_unused, index) => fullChunk(index));
}

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
    ...impl,
  };
}

/** Records every chatJson call so tests can assert the call COUNT, not just the output. */
function recordingProvider(respond: (call: number, messages: ChatMessage[]) => unknown): {
  provider: LLMProvider;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  const provider = fakeProvider({
    chatJson: async <T>(messages: ChatMessage[]) => {
      calls.push(messages);
      return respond(calls.length, messages) as T;
    },
  });
  return { provider, calls };
}

function userText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

describe("buildExtractionWindows", () => {
  test("a note under the window size is one window", () => {
    expect(buildExtractionWindows(fullChunks(5))).toHaveLength(1);
  });

  test("packs 320-token chunks up to the 2400-token ceiling", () => {
    const windows = buildExtractionWindows(fullChunks(20));
    expect(windows.map((w) => w.length)).toEqual([7, 7, 6]);
    // Ordering is preserved and no chunk is lost or duplicated.
    expect(windows.flat().map((c) => c.ord)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index),
    );
  });

  test("empty input yields no windows", () => {
    expect(buildExtractionWindows([])).toEqual([]);
  });

  test("an H2 boundary closes a window that already holds the minimum", () => {
    const chunks = [
      ...fullChunks(4), // 1280 tokens, past headingBreakMinTokens (1200)
      chunk("## Second section\n\nbody", 4),
      chunk("more body", 5),
    ];
    const windows = buildExtractionWindows(chunks);
    expect(windows.map((w) => w.length)).toEqual([4, 2]);
  });

  test("an H2 boundary does not split a window still under the minimum", () => {
    const chunks = [...fullChunks(2), chunk("## Second section\n\nbody", 2)];
    expect(buildExtractionWindows(chunks)).toHaveLength(1);
  });

  test("a single oversized chunk still gets its own window rather than being dropped", () => {
    const huge = chunk("q".repeat(40_000), 0);
    const windows = buildExtractionWindows([huge, fullChunk(1)]);
    expect(windows.map((w) => w.length)).toEqual([1, 1]);
  });
});

describe("Extractor", () => {
  test("rejects invalid extraction concurrency instead of clamping it", () => {
    for (const concurrency of [0, 1.5, 129, Number.NaN]) {
      expect(
        () =>
          new Extractor(fakeProvider({}), {
            model: "test-model",
            scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
            concurrency,
          }),
      ).toThrow("concurrency must be an integer between 1 and 128");
    }
  });

  test("returns empty extraction for empty chunks list", async () => {
    const provider = fakeProvider({});
    const extractor = makeExtractor(provider, { model: "test-model", concurrency: 1 });
    const out = await extractor.extract([]);
    expect(out.entities).toEqual([]);
    expect(out.claims).toEqual([]);
    expect(out.questions).toEqual([]);
    expect(out.stats).toEqual({ llmCalls: 0, windows: 0 });
  });

  test("issues one call for a 5-chunk note and three for a 20-chunk note", async () => {
    const small = recordingProvider(() => ({ entities: [], claims: [], questions: [] }));
    const smallOut = await makeExtractor(small.provider, { model: "m", concurrency: 1 }).extract(
      fullChunks(5),
    );
    expect(small.calls).toHaveLength(1);
    expect(smallOut.stats).toEqual({ llmCalls: 1, windows: 1 });

    const large = recordingProvider(() => ({ entities: [], claims: [], questions: [] }));
    const largeOut = await makeExtractor(large.provider, { model: "m", concurrency: 1 }).extract(
      fullChunks(20),
    );
    expect(large.calls).toHaveLength(3);
    expect(largeOut.stats).toEqual({ llmCalls: 3, windows: 3 });
  });

  test("labels every chunk with its ordinal marker in the window prompt", async () => {
    const { provider, calls } = recordingProvider(() => ({
      entities: [],
      claims: [],
      questions: [],
    }));
    await makeExtractor(provider, { model: "m", concurrency: 1 }).extract([
      chunk("Alice met Bob.", 0),
      chunk("Bob left.", 1),
    ]);
    expect(calls).toHaveLength(1);
    const prompt = userText(calls[0]);
    expect(prompt).toContain("[c0]\nAlice met Bob.");
    expect(prompt).toContain("[c1]\nBob left.");
  });

  test("passes the schema, model, and chunkRefs contract to chatJson", async () => {
    const seen: Array<{ opts: ChatOptions; schema: JsonSchema }> = [];
    const provider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema) => {
        seen.push({ opts, schema });
        return { entities: [], claims: [], questions: [] } as T;
      },
    });
    await makeExtractor(provider, { model: "test-model", concurrency: 1 }).extract([
      chunk("Alice met Bob."),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].opts.model).toBe("test-model");
    expect(seen[0].opts.enableThinking).toBe(false);
    expect(seen[0].opts.maxTokens).toBe(4096);
    expect(seen[0].schema.name).toBe("Extraction");
    const schemaJson = JSON.stringify(seen[0].schema.schema);
    expect(schemaJson).toContain("chunkRefs");
    expect(schemaJson).toContain("proper_noun");
    expect(schemaJson).toContain("definition");
    expect(schemaJson).not.toContain('"additionalProperties":true');
    expect(schemaJson).not.toContain('"pattern"');
  });

  test("maps chunkRefs onto the chunk ids that support each item", async () => {
    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          entities: [{ label: "Hermes", kind: "system", chunkRefs: [2] }],
          claims: [{ text: "Hermes accelerates I/O.", kind: "assertion", chunkRefs: [0, 2] }],
          questions: [{ text: "How fast?", chunkRefs: [1] }],
        }) as T,
    });
    const out = await makeExtractor(provider, { model: "m", concurrency: 1 }).extract([
      chunk("a", 0),
      chunk("b", 1),
      chunk("c", 2),
    ]);
    expect(out.entityEvidence).toEqual({ Hermes: ["c2"] });
    expect(out.claimEvidence).toEqual({ "Hermes accelerates I/O.": ["c0", "c2"] });
    expect(out.questionEvidence).toEqual({ "How fast?": ["c1"] });
    expect(out.entityKinds).toEqual({ Hermes: "system" });
    expect(out.claimKinds).toEqual({ "Hermes accelerates I/O.": "assertion" });
  });

  test("rejects a window whose chunkRefs do not resolve", async () => {
    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          entities: [{ label: "Hermes", kind: "system", chunkRefs: [99, 1] }],
          claims: [],
          questions: [],
        }) as T,
    });
    await expect(
      makeExtractor(provider, { model: "m", concurrency: 1 }).extract([
        chunk("a", 0),
        chunk("b", 1),
      ]),
    ).rejects.toThrow("chunkRefs names absent ordinal 99");
  });

  test.each([
    [{ entities: [], claims: [] }, "exactly claims, entities, questions"],
    [{ entities: ["Hermes"], claims: [], questions: [] }, "entities[0] must be an object"],
    [
      {
        entities: [{ label: "Hermes", kind: "system", chunkRefs: [] }],
        claims: [],
        questions: [],
      },
      "chunkRefs must be a non-empty array",
    ],
    [
      {
        entities: [{ label: "Hermes", kind: "legacy", chunkRefs: [0] }],
        claims: [],
        questions: [],
      },
      "kind has an unsupported value",
    ],
    [
      {
        entities: [],
        claims: [],
        questions: [{ text: "Not actually a question", chunkRefs: [0] }],
      },
      "must end with '?'",
    ],
  ])("rejects malformed structured extraction output %#", async (response, message) => {
    const provider = fakeProvider({ chatJson: async <T>() => response as T });
    await expect(
      makeExtractor(provider, { model: "m", concurrency: 1 }).extract([chunk("a", 0)]),
    ).rejects.toThrow(message);
  });

  test("merges across windows, dedupes case-insensitively, and unions evidence", async () => {
    const responses = [
      {
        entities: [{ label: "Alice", kind: "proper_noun", chunkRefs: [0] }],
        claims: [{ text: "POSIX is leaky.", kind: "assertion", chunkRefs: [0] }],
        questions: [],
      },
      {
        entities: [{ label: "alice", kind: "other", chunkRefs: [7] }],
        claims: [{ text: "POSIX is leaky.", kind: "assertion", chunkRefs: [7] }],
        questions: [{ text: "Why?", chunkRefs: [7] }],
      },
      {
        entities: [{ label: "HPC", kind: "other", chunkRefs: [14] }],
        claims: [],
        questions: [],
      },
    ];
    const { provider, calls } = recordingProvider((call) => responses[call - 1]);
    const out = await makeExtractor(provider, { model: "m", concurrency: 1 }).extract(
      fullChunks(20),
    );
    expect(calls).toHaveLength(3);
    expect(out.entities.sort()).toEqual(["Alice", "HPC"]);
    expect(out.claims).toEqual(["POSIX is leaky."]);
    expect(out.questions).toEqual(["Why?"]);
    // "Alice" and "alice" collapse to one entity carrying both windows' evidence.
    expect(out.entityEvidence?.Alice).toEqual(["c0", "c7"]);
    expect(out.claimEvidence?.["POSIX is leaky."]).toEqual(["c0", "c7"]);
  });

  test("throws PartialExtractionError carrying the windows that succeeded", async () => {
    const { provider, calls } = recordingProvider((call) => {
      if (call === 2) throw new Error("model OOM");
      if (call === 3) return { entities: [], claims: [], questions: [] };
      return {
        entities: [{ label: `E${call}`, kind: "other", chunkRefs: [0] }],
        claims: [],
        questions: [],
      };
    });
    let caught: unknown;
    try {
      await makeExtractor(provider, { model: "m", concurrency: 1 }).extract(fullChunks(20));
    } catch (error) {
      caught = error;
    }
    expect(calls).toHaveLength(3);
    expect(caught).toBeInstanceOf(PartialExtractionError);
    const partial = caught as PartialExtractionError;
    expect(partial.failedWindows).toBe(1);
    expect(partial.totalWindows).toBe(3);
    expect(partial.message).toContain("1 of 3");
    // The successful windows are still persistable by runTier3. Coverage
    // includes the third window even though it returned an empty extraction,
    // and excludes every chunk in the rejected second window.
    expect(partial.extraction.entities).toEqual(["E1"]);
    expect([...partial.successfulChunkIds]).toEqual([
      ...Array.from({ length: 7 }, (_unused, index) => `c${index}`),
      ...Array.from({ length: 6 }, (_unused, index) => `c${index + 14}`),
    ]);
    expect(partial.extraction.stats).toEqual({ llmCalls: 3, windows: 3 });
  });

  test("propagates AbortError instead of reporting a partial extraction", async () => {
    const provider = fakeProvider({
      chatJson: async <T>(): Promise<T> => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const extractor = makeExtractor(provider, { model: "test-model", concurrency: 1 });
    await expect(extractor.extract([chunk("a", 0)])).rejects.toThrow("aborted");
  });

  test("filters generic noise entities from merged extraction output", async () => {
    const responses = [
      {
        entities: [
          { label: "structure", kind: "other", chunkRefs: [0] },
          { label: "Drive API v3", kind: "system", chunkRefs: [0] },
          { label: "connection_builder", kind: "other", chunkRefs: [0] },
        ],
        claims: [],
        questions: [],
      },
      {
        entities: [
          { label: "Stakeholder Trifecta", kind: "technique", chunkRefs: [7] },
          { label: "Illumina MiSeq", kind: "system", chunkRefs: [7] },
        ],
        claims: [],
        questions: [],
      },
    ];
    const { provider } = recordingProvider((call) => responses[call - 1]);
    const out = await makeExtractor(provider, { model: "m", concurrency: 1 }).extract(
      fullChunks(14),
    );
    expect(out.entities.sort()).toEqual(
      ["Drive API v3", "Stakeholder Trifecta", "Illumina MiSeq"].sort(),
    );
  });
});

describe("filterNoiseEntities", () => {
  test("returns [] for empty input", () => {
    expect(filterNoiseEntities([])).toEqual([]);
  });

  describe("predicate (a): single short lowercase token", () => {
    test("drops 'structure'", () => {
      expect(filterNoiseEntities(["structure"])).toEqual([]);
    });

    test("drops 'wrappers'", () => {
      expect(filterNoiseEntities(["wrappers"])).toEqual([]);
    });

    test("drops 'haiku'", () => {
      expect(filterNoiseEntities(["haiku"])).toEqual([]);
    });

    test("keeps capitalized 'Haiku'", () => {
      expect(filterNoiseEntities(["Haiku"])).toEqual(["Haiku"]);
    });

    test("keeps 'Drive' (length 5)", () => {
      expect(filterNoiseEntities(["Drive"])).toEqual(["Drive"]);
    });

    test("keeps uppercase 'POSIX' (not lowercase)", () => {
      expect(filterNoiseEntities(["POSIX"])).toEqual(["POSIX"]);
    });
  });

  describe("predicate (b): short snake/kebab identifier", () => {
    test("drops 'connection_builder'", () => {
      expect(filterNoiseEntities(["connection_builder"])).toEqual([]);
    });

    test("drops 'npm-db'", () => {
      expect(filterNoiseEntities(["npm-db"])).toEqual([]);
    });

    test("keeps long hyphenated model name 'text-embedding-nomic-embed-text-v2-moe'", () => {
      expect(filterNoiseEntities(["text-embedding-nomic-embed-text-v2-moe"])).toEqual([
        "text-embedding-nomic-embed-text-v2-moe",
      ]);
    });

    test("keeps 'Drive API v3' (has spaces, not a single token)", () => {
      expect(filterNoiseEntities(["Drive API v3"])).toEqual(["Drive API v3"]);
    });
  });

  describe("prompt-only handling for two-word Title Case phrases", () => {
    test("keeps 'Container Dark' in the post-filter", () => {
      expect(filterNoiseEntities(["Container Dark"])).toEqual(["Container Dark"]);
    });

    test("keeps 'Stakeholder Trifecta'", () => {
      expect(filterNoiseEntities(["Stakeholder Trifecta"])).toEqual(["Stakeholder Trifecta"]);
    });

    test("keeps 'Drive API' (API is short and uppercase)", () => {
      expect(filterNoiseEntities(["Drive API"])).toEqual(["Drive API"]);
    });

    test("keeps 'Illumina MiSeq' (mixed case in second word)", () => {
      expect(filterNoiseEntities(["Illumina MiSeq"])).toEqual(["Illumina MiSeq"]);
    });
  });

  describe("kept cases (no predicate fires)", () => {
    test("keeps multi-word phrase 'RAG filtering protocols'", () => {
      expect(filterNoiseEntities(["RAG filtering protocols"])).toEqual(["RAG filtering protocols"]);
    });

    test("keeps single capitalized 'Distributed' (intentional trade-off)", () => {
      expect(filterNoiseEntities(["Distributed"])).toEqual(["Distributed"]);
    });

    test("keeps proper noun 'Hermes'", () => {
      expect(filterNoiseEntities(["Hermes"])).toEqual(["Hermes"]);
    });

    test("keeps proper noun 'Nemotron'", () => {
      expect(filterNoiseEntities(["Nemotron"])).toEqual(["Nemotron"]);
    });
  });

  test("filters mixed batch correctly", () => {
    const input = [
      "structure",
      "Drive API v3",
      "connection_builder",
      "Stakeholder Trifecta",
      "Illumina MiSeq",
      "npm-db",
      "wrappers",
    ];
    expect(filterNoiseEntities(input)).toEqual([
      "Drive API v3",
      "Stakeholder Trifecta",
      "Illumina MiSeq",
    ]);
  });
});

describe("writeExtractionToSurreal", () => {
  test("reconciles mentions, asserts, and asks in one transaction", async () => {
    const queries: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    let counter = 0;
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          queries.push({ sql, bindings });
          return sql.startsWith("SELECT id, out, evidence FROM mentions") ? [[], [], []] : [[]];
        },
      }),
      create: (target: unknown) => {
        const tableName = target instanceof Table ? target.name : String(target);
        return {
          content: async () => {
            counter += 1;
            return [{ id: new RecordId(tableName, `test-${counter}`) }];
          },
        };
      },
    } as unknown as Surreal;
    const noteId = new RecordId("note", "sample");
    const evidence = new RecordId("chunk", "sample-0");

    await writeExtractionToSurreal(
      db,
      noteId,
      {
        entities: ["POSIX"],
        entityKinds: { POSIX: "system" },
        claims: ["POSIX is leaky."],
        claimKinds: { "POSIX is leaky.": "assertion" },
        questions: ["Why is POSIX leaky?"],
        entityEvidence: { POSIX: ["c0"] },
        claimEvidence: { "POSIX is leaky.": ["c0"] },
        questionEvidence: { "Why is POSIX leaky?": ["c0"] },
      },
      { chunkIndex: new Map([["c0", evidence]]), coverage: { kind: "full" } },
    );

    const transactionQueries = queries.filter((query) =>
      query.sql.startsWith("BEGIN TRANSACTION;"),
    );
    expect(transactionQueries).toHaveLength(1);
    expect(transactionQueries[0].sql).toContain("RELATE $note->mentions->");
    expect(transactionQueries[0].sql).toContain("RELATE $note->asserts->");
    expect(transactionQueries[0].sql).toContain("RELATE $note->asks->");
    expect(transactionQueries[0].sql).not.toContain("evidence = NONE");
    expect(transactionQueries[0].sql).toEndWith("COMMIT TRANSACTION;");
    expect(queries.some((query) => query.sql.startsWith("DELETE mentions WHERE"))).toBe(false);
  });

  test("retries the complete write when an enforced target disappears before RELATE", async () => {
    let created = 0;
    let relationAttempts = 0;
    let atomicCleanups = 0;
    const fixedReply = (sql: string): unknown[] | undefined => {
      if (sql.startsWith("SELECT id, out, evidence FROM mentions")) return [[], [], []];
      if (sql.startsWith("SELECT id FROM concept")) return [[]];
      if (!sql.includes("LET $incoming")) return undefined;
      atomicCleanups += 1;
      return [];
    };
    const relationReply = (): unknown[] => {
      relationAttempts += 1;
      if (relationAttempts === 1) {
        throw new Error("The record 'concept:vanished' does not exist");
      }
      return [[]];
    };
    const collect = async (sql: string): Promise<unknown[]> => {
      const fixed = fixedReply(sql);
      if (fixed !== undefined) return fixed;
      const isRelation =
        sql.startsWith("BEGIN TRANSACTION;") && sql.includes("RELATE $note->mentions");
      return isRelation ? relationReply() : [[]];
    };
    const db = {
      query: (sql: string) => ({
        collect: () => collect(sql),
      }),
      create: () => ({
        content: async () => {
          created += 1;
          return [{ id: new RecordId("concept", `retry-${created}`) }];
        },
      }),
    } as unknown as Surreal;
    const evidence = new RecordId("chunk", "retry-0");

    await writeExtractionToSurreal(
      db,
      new RecordId("note", "retry"),
      {
        entities: ["Concurrent target"],
        claims: [],
        questions: [],
        entityEvidence: { "Concurrent target": ["c0"] },
      },
      { chunkIndex: new Map([["c0", evidence]]), coverage: { kind: "full" } },
    );

    expect(relationAttempts).toBe(2);
    expect(created).toBe(2);
    expect(atomicCleanups).toBe(1);
  });

  test("partial reconciliation retains failed-window evidence and deletes covered rows", async () => {
    const noteId = new RecordId("note", "partial");
    const chunk0 = new RecordId("chunk", "c0");
    const chunk1 = new RecordId("chunk", "c1");
    const conceptA = new RecordId("concept", "a");
    const conceptB = new RecordId("concept", "b");
    const edgeA = new RecordId("mentions", "edge-a");
    const edgeB = new RecordId("mentions", "edge-b");
    const queries: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          queries.push({ sql, bindings });
          if (sql.startsWith("SELECT id, out, evidence FROM mentions")) {
            return [
              [
                { id: edgeA, out: conceptA, evidence: [chunk0] },
                { id: edgeB, out: conceptB, evidence: [chunk1] },
              ],
              [],
              [],
            ];
          }
          return [[]];
        },
      }),
    } as unknown as Surreal;

    await writeExtractionToSurreal(
      db,
      noteId,
      { entities: [], claims: [], questions: [] },
      {
        chunkIndex: new Map([
          [chunk0.toString(), chunk0],
          [chunk1.toString(), chunk1],
        ]),
        coverage: { kind: "partial", chunkIds: new Set([chunk0.toString()]) },
      },
    );

    const transaction = queries.find((query) => query.sql.startsWith("BEGIN TRANSACTION;"));
    expect(transaction).toBeDefined();
    const bindings = Object.entries(transaction?.bindings ?? {});
    const isBoundAs = (suffix: string, id: RecordId): boolean =>
      bindings.some(([name, value]) => name.endsWith(suffix) && String(value) === id.toString());

    // A was supported only by the successful c0 window, so an empty result
    // removes it. B retains current failed-window c1 evidence and receives
    // canonical provenance.
    expect(isBoundAs("_deleteId", edgeA)).toBe(true);
    expect(isBoundAs("_deleteId", edgeB)).toBe(false);
    expect(isBoundAs("_keeperId", edgeB)).toBe(true);
    expect(transaction?.sql).toContain(
      "SET source = 'extractor', class = 'INFERRED', confidence = 0.7, agent = 'extractor', approved = true, applied = true, evidence =",
    );
    expect(transaction?.sql).not.toContain("evidence = NONE");
  });

  test("rejects an impossible stored extractor relation without evidence", async () => {
    const noteId = new RecordId("note", "corrupt");
    const db = {
      query: (sql: string) => ({
        collect: async () =>
          sql.startsWith("SELECT id, out, evidence FROM mentions")
            ? [
                [
                  {
                    id: new RecordId("mentions", "corrupt-edge"),
                    out: new RecordId("concept", "corrupt-target"),
                  },
                ],
                [],
                [],
              ]
            : [[]],
      }),
    } as unknown as Surreal;

    await expect(
      writeExtractionToSurreal(
        db,
        noteId,
        { entities: [], claims: [], questions: [] },
        { chunkIndex: new Map(), coverage: { kind: "full" } },
      ),
    ).rejects.toThrow("mentions row has invalid evidence");
  });

  test("drops extracted items whose evidence does not resolve to a current chunk", async () => {
    const queries: string[] = [];
    let nodesCreated = 0;
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          queries.push(sql);
          return [[], [], []];
        },
      }),
      create: () => ({
        content: async () => {
          nodesCreated += 1;
          return { id: new RecordId("concept", `unexpected-${nodesCreated}`) };
        },
      }),
    } as unknown as Surreal;

    await writeExtractionToSurreal(
      db,
      new RecordId("note", "missing-evidence"),
      {
        entities: ["Unresolved concept"],
        claims: ["Unresolved claim."],
        questions: ["Unresolved question?"],
        entityEvidence: { "Unresolved concept": ["missing"] },
        claimEvidence: { "Unresolved claim.": ["missing"] },
        questionEvidence: { "Unresolved question?": ["missing"] },
      },
      { chunkIndex: new Map(), coverage: { kind: "full" } },
    );

    expect(nodesCreated).toBe(0);
    const transaction = queries.find((sql) => sql.startsWith("BEGIN TRANSACTION;"));
    expect(transaction).toBe("BEGIN TRANSACTION;\nCOMMIT TRANSACTION;");
  });
});
