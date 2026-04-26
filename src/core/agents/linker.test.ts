import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import type { JsonSchema, LLMProvider } from "../llm/provider";
import { Linker } from "./linker";

function fakeProvider(json: unknown): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>(_messages: unknown, _options: unknown, _schema: JsonSchema) => json as T,
    embed: async () => [],
  };
}

describe("Linker", () => {
  test("stages typed edges to staging_edges with evidence + confidence", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      "/active.md",
      "sha",
      100,
      1,
      1,
    ]);
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      "/neighbor.md",
      "sha",
      100,
      1,
      1,
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c1",
      "/active.md",
      0,
      "POSIX is leaky in HPC.",
      "s1",
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c2",
      "/neighbor.md",
      0,
      "Distributed file systems break POSIX assumptions.",
      "s2",
    ]);
    const provider = fakeProvider({
      edges: [
        {
          targetNotePath: "/neighbor.md",
          type: "supports",
          confidence: 0.84,
          rationale: "Both note POSIX limits.",
          evidenceChunkIds: ["c1", "c2"],
        },
      ],
    });
    const linker = new Linker({
      db,
      provider,
      reasoningModel: "nemotron",
      neighborhood: async () => [
        {
          notePath: "/neighbor.md",
          chunkId: "c2",
          text: "Distributed file systems break POSIX assumptions.",
          score: 0.91,
        },
      ],
    });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "/active.md",
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ type: string; agent: string; confidence: number; evidence: string }>(
      "SELECT type, agent, confidence, evidence FROM staging_edges;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("supports");
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].confidence).toBeCloseTo(0.84);
    expect(JSON.parse(rows[0].evidence)).toEqual(["c1", "c2"]);
  });

  test("returns 0 proposals when notePath is null", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const linker = new Linker({
      db,
      provider: fakeProvider({ edges: [] }),
      reasoningModel: "nemotron",
      neighborhood: async () => [],
    });
    const result = await linker.run({
      trigger: "idle-30s",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(0);
  });

  test("respects abort signal mid-run", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      "/active.md",
      "sha",
      100,
      1,
      1,
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c1",
      "/active.md",
      0,
      "x",
      "s",
    ]);
    let saw: AbortSignal | undefined;
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>(
        _messages: unknown,
        options: { signal?: AbortSignal },
        _schema: JsonSchema,
      ) => {
        saw = options.signal;
        return { edges: [] } as T;
      },
      embed: async () => [],
    };
    const linker = new Linker({
      db,
      provider,
      reasoningModel: "nemotron",
      neighborhood: async () => [{ notePath: "/n.md", chunkId: "c2", text: "x", score: 0.5 }],
    });
    const ctrl = new AbortController();
    await linker.run({
      trigger: "vault-save",
      notePath: "/active.md",
      signal: ctrl.signal,
    });
    expect(saw).toBe(ctrl.signal);
  });
});
