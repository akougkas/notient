import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type DatabaseAdapter } from "../db/database";
import { EventBus } from "../events/eventBus";
import { GraphStore } from "../graph/graphStore";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../llm/provider";
import { Embedder } from "./embedder";
import { Extractor } from "./extractor";
import { indexNote } from "./indexNote";
import type { Extraction } from "./types";
import { InMemoryVectorIndex } from "./vectorIndex";

class MemoryAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(initial: Record<string, ArrayBuffer> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(path) ?? null;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
}

function loadWasm(): ArrayBuffer {
  const wasmPath = resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function fakeProvider(extraction: Extraction, dim = 4): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>() => extraction as unknown as T,
    embed: async (input) => input.map(() => Array.from({ length: dim }, () => 0.1)),
  };
}

async function setup() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const graph = new GraphStore(database);
  const vectorIndex = new InMemoryVectorIndex();
  await vectorIndex.init(4);
  const bus = new EventBus();
  return { database, graph, vectorIndex, bus };
}

describe("indexNote (no SurrealDB path)", () => {
  test("returns a minimal IndexResult and does not write to SQLite when surrealDb is undefined", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({
      entities: ["POSIX"],
      claims: ["POSIX is leaky."],
      questions: ["Why is POSIX leaky?"],
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });

    const result = await indexNote({
      notePath: "/note.md",
      noteBody: "POSIX is leaky in HPC.\n\nWhy is it like this?",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });

    expect(result.notePath).toBe("/note.md");
    expect(result.chunkCount).toBe(0);
    expect(result.embedCount).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);

    const noteRows = database.query<{ path: string }>("SELECT path FROM notes;");
    expect(noteRows).toHaveLength(0);
    const chunkRows = database.query<{ id: string }>("SELECT id FROM chunks;");
    expect(chunkRows).toHaveLength(0);
  });

  test("does not emit indexer:note-indexed when surrealDb is undefined", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: [], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });

    let noteIndexedSeen = 0;
    bus.on("indexer:note-indexed", () => {
      noteIndexedSeen += 1;
    });
    let tier1Seen = 0;
    bus.on("indexer:tier1-done", () => {
      tier1Seen += 1;
    });

    await indexNote({
      notePath: "/n.md",
      noteBody: "Hello world.",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });

    expect(noteIndexedSeen).toBe(0);
    expect(tier1Seen).toBe(0);
  });

  test("computes a stable noteSha for identical bodies", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: [], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    const args = {
      notePath: "/n.md",
      noteBody: "Hello world.",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    };
    const first = await indexNote(args);
    const second = await indexNote(args);
    expect(first.noteSha).toBe(second.noteSha);
    expect(first.noteSha).toMatch(/^[0-9a-f]{64}$/);
  });
});
