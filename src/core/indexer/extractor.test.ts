import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../llm/provider";
import { Extractor } from "./extractor";
import type { Chunk } from "./types";

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
});
