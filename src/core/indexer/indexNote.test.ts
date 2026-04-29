import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { Embedder } from "./embedder";
import { Extractor } from "./extractor";
import { indexNote } from "./indexNote";
import type { Extraction } from "./types";

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

describe("indexNote (no SurrealDB path)", () => {
  test("returns a minimal IndexResult when surrealDb is undefined", async () => {
    const bus = new EventBus();
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
      embedder,
      extractor,
      bus,
    });

    expect(result.notePath).toBe("/note.md");
    expect(result.chunkCount).toBe(0);
    expect(result.embedCount).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
  });

  test("does not emit indexer:note-indexed when surrealDb is undefined", async () => {
    const bus = new EventBus();
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
      embedder,
      extractor,
      bus,
    });

    expect(noteIndexedSeen).toBe(0);
    expect(tier1Seen).toBe(0);
  });

  test("computes a stable noteSha for identical bodies", async () => {
    const bus = new EventBus();
    const provider = fakeProvider({ entities: [], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    const args = {
      notePath: "/n.md",
      noteBody: "Hello world.",
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
