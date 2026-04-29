import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { ChatJsonParseError, type JsonSchema, type LLMProvider } from "../llm/provider";
import { ContradictionHunter } from "./contradictionHunter";

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

describe("ContradictionHunter", () => {
  test("stages contradicts edges between claim nodes", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?), (?,?,?,?,?,?);`,
      [
        "claim:abc",
        "claim",
        "POSIX is leaky in HPC.",
        "/a.md",
        JSON.stringify({ chunkIds: ["c1"] }),
        1,
        "claim:def",
        "claim",
        "POSIX semantics are fully respected by parallel filesystems.",
        "/b.md",
        JSON.stringify({ chunkIds: ["c2"] }),
        1,
      ],
    );
    const provider = fakeProvider({
      pairs: [
        {
          claimAId: "claim:abc",
          claimBId: "claim:def",
          confidence: 0.84,
          rationale: "Direct negation of the same property.",
          evidenceChunkIds: ["c1", "c2"],
        },
      ],
    });
    const hunter = new ContradictionHunter({
      db,
      provider,
      reasoningModel: "test-model",
      neighbors: async () => [{ id: "claim:def", score: 0.91, chunkIds: ["c2"] }],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "new-claim",
      notePath: "/a.md",
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
    }>("SELECT type, source_id, target_id, confidence FROM staging_edges;");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("contradicts");
    expect(rows[0].source_id).toBe("claim:abc");
    expect(rows[0].target_id).toBe("claim:def");
    expect(rows[0].confidence).toBeCloseTo(0.84);
  });

  test("returns 0 proposals (no throw) when chatJson rejects with ChatJsonParseError from a truncated payload", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?), (?,?,?,?,?,?);`,
      [
        "claim:abc",
        "claim",
        "POSIX is leaky.",
        "/a.md",
        JSON.stringify({ chunkIds: ["c1"] }),
        1,
        "claim:def",
        "claim",
        "POSIX is fully respected.",
        "/b.md",
        JSON.stringify({ chunkIds: ["c2"] }),
        1,
      ],
    );
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async () => {
        throw new ChatJsonParseError(
          "JSON Parse error: Unterminated string",
          '{ "pairs": [ { "claimAId": "claim:abc"',
        );
      },
      embed: async () => [],
    };
    const hunter = new ContradictionHunter({
      db,
      provider,
      reasoningModel: "test-model",
      neighbors: async () => [{ id: "claim:def", score: 0.91, chunkIds: ["c2"] }],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "new-claim",
      notePath: "/a.md",
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });

  test("returns 0 proposals (no throw) when chatJson returns an object missing the pairs array", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?), (?,?,?,?,?,?);`,
      ["claim:abc", "claim", "x", "/a.md", null, 1, "claim:def", "claim", "y", "/b.md", null, 1],
    );
    const hunter = new ContradictionHunter({
      db,
      provider: fakeProvider({}),
      reasoningModel: "test-model",
      neighbors: async () => [{ id: "claim:def", score: 0.91, chunkIds: ["c2"] }],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "new-claim",
      notePath: "/a.md",
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });

  test("returns 0 proposals when no claims exist", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const hunter = new ContradictionHunter({
      db,
      provider: fakeProvider({ pairs: [] }),
      reasoningModel: "test-model",
      neighbors: async () => [],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });
});
