import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type DatabaseAdapter } from "../db/database";
import { EventBus } from "../events/eventBus";
import type { AppEvent } from "../events/types";
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

describe("indexNote", () => {
  test("populates notes/chunks/embeddings/graph in one transaction", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({
      entities: ["POSIX"],
      claims: ["POSIX is leaky."],
      questions: ["Why is POSIX leaky?"],
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });

    const events: AppEvent[] = [];
    bus.on("indexer:node-added", (e) => events.push(e));
    bus.on("indexer:edge-added", (e) => events.push(e));
    bus.on("indexer:note-indexed", (e) => events.push(e));

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

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.edgeCount).toBeGreaterThan(0);

    const noteRows = database.query<{ path: string; sha: string }>("SELECT path, sha FROM notes;");
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0].path).toBe("/note.md");

    const chunkRows = database.query<{ note_path: string }>("SELECT note_path FROM chunks;");
    expect(chunkRows.length).toBe(result.chunkCount);

    const embRows = database.query<{ chunk_id: string }>("SELECT chunk_id FROM embeddings;");
    expect(embRows.length).toBe(result.embedCount);

    const conceptNodes = graph.nodesByType("concept");
    expect(conceptNodes.some((n) => n.label === "POSIX")).toBe(true);

    const noteIndexedEvents = events.filter((e) => e.type === "indexer:note-indexed");
    expect(noteIndexedEvents).toHaveLength(1);
    expect(vectorIndex.size()).toBe(result.embedCount);
  });

  test("idempotent on identical body — short-circuits when sha unchanged", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: ["A"], claims: [], questions: [] });
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
    const r1 = await indexNote(args);
    const r2 = await indexNote(args);
    expect(r2.chunkCount).toBe(0);
    expect(r2.embedCount).toBe(0);
    const chunkRows = database.query<{ id: string }>("SELECT id FROM chunks;");
    expect(chunkRows.length).toBe(r1.chunkCount);
  });

  test("re-indexing on modified body deletes old chunks/edges before writing new", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: ["A"], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    await indexNote({
      notePath: "/n.md",
      noteBody: "old body",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    await indexNote({
      notePath: "/n.md",
      noteBody: "new body that is different",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    const chunkRows = database.query<{ id: string; note_path: string }>(
      "SELECT id, note_path FROM chunks WHERE note_path = '/n.md';",
    );
    expect(chunkRows.length).toBeGreaterThan(0);
    const distinctSha = database.query<{ sha: string }>(
      "SELECT DISTINCT sha FROM notes WHERE path = '/n.md';",
    );
    expect(distinctSha).toHaveLength(1);
  });

  test("strips frontmatter from body before chunking", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: [], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    await indexNote({
      notePath: "/n.md",
      noteBody: "---\ntitle: Hi\n---\nactual body",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    const chunkRows = database.query<{ text: string }>("SELECT text FROM chunks;");
    expect(chunkRows[0].text).not.toContain("title: Hi");
    expect(chunkRows[0].text).toContain("actual body");
  });
});
