import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { ChatJsonParseError, type JsonSchema, type LLMProvider } from "../llm/provider";
import { Synthesizer } from "./synthesizer";

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

function vecBlob(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function seedCluster(db: Database): void {
  const now = Date.now();
  for (const path of ["/a.md", "/b.md", "/c.md"]) {
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      path,
      "s",
      100,
      now,
      now,
    ]);
  }
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    "ca",
    "/a.md",
    0,
    "POSIX leaks",
    "s",
  ]);
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    "cb",
    "/b.md",
    0,
    "POSIX limits",
    "s",
  ]);
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    "cc",
    "/c.md",
    0,
    "Astronomy",
    "s",
  ]);
  db.run("INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);", [
    "ca",
    "primary-embed",
    2,
    vecBlob([1, 0]),
  ]);
  db.run("INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);", [
    "cb",
    "primary-embed",
    2,
    vecBlob([0.99, 0.01]),
  ]);
  db.run("INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);", [
    "cc",
    "primary-embed",
    2,
    vecBlob([-1, -1]),
  ]);
}

describe("Synthesizer", () => {
  test("clusters recent notes and stages a synthesis node", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    seedCluster(db);
    const provider = fakeProvider({
      title: "POSIX Limits in Distributed Systems",
      body: "## Themes\n- POSIX is leaky.\n- ...",
      memberPaths: ["/a.md", "/b.md"],
      confidence: 0.78,
    });
    const synth = new Synthesizer({
      db,
      provider,
      reasoningModel: "test-model",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ type: string; agent: string; payload: string; label: string }>(
      "SELECT type, agent, payload, label FROM staging_nodes;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("synthesis");
    expect(rows[0].agent).toBe("synthesizer");
    expect(rows[0].label).toContain("POSIX");
    const payload = JSON.parse(rows[0].payload);
    expect(payload.memberPaths).toEqual(["/a.md", "/b.md"]);
  });

  test("falls back to a markdown synthesis draft when chatJson exposes raw text", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    seedCluster(db);
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async () => {
        throw new ChatJsonParseError(
          "chatJson failed",
          "# Synthesis Note: POSIX Limits\n\n## Themes\n- [[/a.md]] and [[/b.md]] overlap.",
        );
      },
      embed: async () => [],
    };
    const synth = new Synthesizer({
      db,
      provider,
      reasoningModel: "qwen",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ label: string; payload: string; confidence: number }>(
      "SELECT label, payload, confidence FROM staging_nodes;",
    );
    expect(rows[0].label).toBe("POSIX Limits");
    expect(rows[0].confidence).toBe(0.6);
    expect(JSON.parse(rows[0].payload).memberPaths).toEqual(["/a.md", "/b.md"]);
  });

  test("backfills a missing title and stages with a derived label when confidence is met", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    seedCluster(db);
    // Local LLMs occasionally drop the title field even with strict
    // json_schema. The Synthesizer must not crash on slug(undefined) and
    // must derive a usable label from the body's first heading.
    const provider = fakeProvider({
      body: "# POSIX Limits\n- whatever",
      memberPaths: ["/a.md", "/b.md"],
      confidence: 0.7,
    });
    const synth = new Synthesizer({
      db,
      provider,
      reasoningModel: "test-model",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ label: string; payload: string; confidence: number }>(
      "SELECT label, payload, confidence FROM staging_nodes;",
    );
    expect(rows[0].label).toBe("POSIX Limits");
    expect(rows[0].confidence).toBe(0.7);
  });

  test("silently disqualifies a malformed payload when confidence is missing (defaults to 0)", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    seedCluster(db);
    // Confidence missing → backfilled to 0 → below the 0.6 staging gate.
    // The agent must not throw and must not stage a corrupt row.
    const provider = fakeProvider({
      body: "## Themes\n- whatever",
      memberPaths: ["/a.md", "/b.md"],
    });
    const synth = new Synthesizer({
      db,
      provider,
      reasoningModel: "test-model",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
    const staged = db.query<{ id: string }>("SELECT id FROM staging_nodes;");
    expect(staged).toHaveLength(0);
  });

  test("returns 0 proposals when no cluster meets minSize", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const synth = new Synthesizer({
      db,
      provider: fakeProvider({}),
      reasoningModel: "test-model",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });
});
