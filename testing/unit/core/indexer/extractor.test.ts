import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecordId, type Surreal, Table } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import {
  Extractor,
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
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

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

describe("Extractor", () => {
  test("returns empty extraction for empty chunks list", async () => {
    const provider = fakeProvider({});
    const extractor = new Extractor(provider, { model: "test-model" });
    const out = await extractor.extract([]);
    expect(out).toEqual({ entities: [], claims: [], questions: [] });
  });

  test("aggregates entities/claims/questions across chunks and dedupes case-insensitively", async () => {
    const responses: Array<{ entities: string[]; claims: string[]; questions: string[] }> = [
      { entities: ["Alice", "POSIX"], claims: ["POSIX is leaky."], questions: [] },
      { entities: ["alice", "HPC"], claims: ["POSIX is leaky."], questions: ["Why?"] },
    ];
    let i = 0;
    const provider = fakeProvider({
      chatJson: async <T>() => responses[i++] as T,
    });
    const extractor = new Extractor(provider, {
      model: "test-model",
      concurrency: 1,
    });
    const out = await extractor.extract([chunk("first", 0), chunk("second", 1)]);
    expect(out.entities.sort()).toEqual(["Alice", "HPC", "POSIX"].sort());
    expect(out.claims).toEqual(["POSIX is leaky."]);
    expect(out.questions).toEqual(["Why?"]);
  });

  test("passes the schema and chunk text to chatJson", async () => {
    const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions; schema: JsonSchema }> = [];
    const provider = fakeProvider({
      chatJson: async <T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema) => {
        calls.push({ messages, opts, schema });
        return { entities: [], claims: [], questions: [] } as T;
      },
    });
    const extractor = new Extractor(provider, { model: "test-model" });
    await extractor.extract([chunk("Alice met Bob.")]);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.model).toBe("test-model");
    expect(calls[0].schema.name).toBe("Extraction");
    expect(JSON.stringify(calls[0].messages)).toContain("Alice met Bob.");
    expect(JSON.stringify(calls[0].schema.schema)).toContain("proper_noun");
    expect(JSON.stringify(calls[0].schema.schema)).toContain("definition");
  });

  test("threads entity and claim kinds from extractor JSON", async () => {
    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          entities: [{ label: "Hermes", kind: "system" }],
          claims: [{ text: "Hermes accelerates I/O.", kind: "assertion" }],
          questions: [],
        }) as T,
    });
    const extractor = new Extractor(provider, { model: "test-model" });
    const out = await extractor.extract([chunk("Hermes accelerates I/O.")]);
    expect(out.entities).toEqual(["Hermes"]);
    expect(out.entityKinds).toEqual({ Hermes: "system" });
    expect(out.claims).toEqual(["Hermes accelerates I/O."]);
    expect(out.claimKinds).toEqual({ "Hermes accelerates I/O.": "assertion" });
  });

  test("survives a single failing chunk and continues with others", async () => {
    let i = 0;
    const provider = fakeProvider({
      chatJson: async <T>() => {
        i++;
        if (i === 2) throw new Error("model OOM");
        return { entities: [`E${i}`], claims: [], questions: [] } as T;
      },
    });
    const extractor = new Extractor(provider, {
      model: "test-model",
      concurrency: 1,
    });
    const out = await extractor.extract([chunk("a", 0), chunk("b", 1), chunk("c", 2)]);
    expect(out.entities.sort()).toEqual(["E1", "E3"]);
  });

  test("filters generic noise entities from merged extraction output", async () => {
    const responses: Array<{ entities: string[]; claims: string[]; questions: string[] }> = [
      {
        entities: ["structure", "Drive API v3", "connection_builder"],
        claims: [],
        questions: [],
      },
      { entities: ["Stakeholder Trifecta", "Illumina MiSeq"], claims: [], questions: [] },
    ];
    let i = 0;
    const provider = fakeProvider({
      chatJson: async <T>() => responses[i++] as T,
    });
    const extractor = new Extractor(provider, {
      model: "test-model",
      concurrency: 1,
    });
    const out = await extractor.extract([chunk("first", 0), chunk("second", 1)]);
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
  test("replaces prior extractor relations for the note before writing new extraction", async () => {
    const queries: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    let counter = 0;
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          queries.push({ sql, bindings });
          return [[]];
        },
      }),
      create: (target: unknown) => {
        const tableName = target instanceof Table ? target.name : String(target);
        return {
          content: async () => {
            counter += 1;
            return { id: new RecordId(tableName, `test-${counter}`) };
          },
        };
      },
    } as unknown as Surreal;
    const noteId = new RecordId("note", "sample");

    await writeExtractionToSurreal(db, noteId, {
      entities: ["POSIX"],
      entityKinds: { POSIX: "system" },
      claims: ["POSIX is leaky."],
      claimKinds: { "POSIX is leaky.": "assertion" },
      questions: ["Why is POSIX leaky?"],
    });

    const deleteQueries = queries.filter((query) => query.sql.startsWith("DELETE "));
    expect(deleteQueries.slice(0, 3).map((query) => query.sql)).toEqual([
      "DELETE mentions WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
      "DELETE asserts WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
      "DELETE asks WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
    ]);
    for (const query of deleteQueries.slice(0, 3)) {
      expect(query.bindings).toEqual({ note: noteId });
    }
  });
});

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
