import { describe, expect, test } from "bun:test";
import {
  ConversationIndex,
  type ConversationIndexFacade,
  decodeBase64Float32,
  encodeBase64Float32,
} from "./conversationIndex";
import type { Conversation } from "./types";

class InMemorySidecar implements ConversationIndexFacade {
  private current: string | null = null;

  async read(_path: string): Promise<string | null> {
    return this.current;
  }

  async write(_path: string, content: string): Promise<void> {
    this.current = content;
  }

  raw(): string | null {
    return this.current;
  }

  prime(content: string): void {
    this.current = content;
  }
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv",
    notePath: "Notient/conversations/2026-04-25 chat.md",
    model: "qwen3-4b-mlx",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Topic",
    summary: "",
    summaryEmbeddingB64: null,
    messageCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...overrides,
  };
}

function vectorB64(values: number[]): string {
  return encodeBase64Float32(new Float32Array(values));
}

describe("conversationIndex", () => {
  test("record appends a new entry and persists it to the sidecar", async () => {
    const sidecar = new InMemorySidecar();
    const index = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await index.load();
    await index.record(
      makeConversation({
        id: "c1",
        topic: "Hello",
        updatedAt: 1000,
        summaryEmbeddingB64: vectorB64([1, 0, 0]),
      }),
    );
    const list = index.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("c1");
    expect(list[0].embedding?.length).toBe(3);
    const persisted = JSON.parse(sidecar.raw() ?? "{}") as { conversations: unknown[] };
    expect(persisted.conversations.length).toBe(1);
  });

  test("record updates an existing entry in place when the id matches", async () => {
    const sidecar = new InMemorySidecar();
    const index = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await index.load();
    await index.record(makeConversation({ id: "c1", topic: "old", updatedAt: 1 }));
    await index.record(makeConversation({ id: "c1", topic: "new", updatedAt: 2 }));
    const list = index.list();
    expect(list.length).toBe(1);
    expect(list[0].topic).toBe("new");
  });

  test("search returns top-K cosine matches above the threshold", async () => {
    const sidecar = new InMemorySidecar();
    const index = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await index.load();

    await index.record(
      makeConversation({
        id: "near",
        topic: "near",
        updatedAt: 100,
        summaryEmbeddingB64: vectorB64([1, 0, 0]),
      }),
    );
    await index.record(
      makeConversation({
        id: "mid",
        topic: "mid",
        updatedAt: 90,
        summaryEmbeddingB64: vectorB64([0.7, 0.7, 0]),
      }),
    );
    await index.record(
      makeConversation({
        id: "far",
        topic: "far",
        updatedAt: 80,
        summaryEmbeddingB64: vectorB64([0, 1, 0]),
      }),
    );
    await index.record(
      makeConversation({
        id: "noembed",
        topic: "noembed",
        updatedAt: 70,
        summaryEmbeddingB64: null,
      }),
    );

    const query = new Float32Array([1, 0, 0]);
    const results = index.search(query, { k: 2, threshold: 0.5 });
    expect(results.length).toBe(2);
    expect(results[0].entry.id).toBe("near");
    expect(results[0].similarity).toBeCloseTo(1, 5);
    expect(results[1].entry.id).toBe("mid");
    expect(results.find((r) => r.entry.id === "far")).toBeUndefined();
    expect(results.find((r) => r.entry.id === "noembed")).toBeUndefined();
  });

  test("persistence roundtrips entries and embeddings", async () => {
    const sidecar = new InMemorySidecar();
    const writer = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await writer.load();
    await writer.record(
      makeConversation({
        id: "rt",
        topic: "Roundtrip",
        updatedAt: 42,
        summaryEmbeddingB64: vectorB64([0.25, 0.5, 0.75, 1]),
      }),
    );

    const reader = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await reader.load();
    const list = reader.list();
    expect(list.length).toBe(1);
    expect(list[0].topic).toBe("Roundtrip");
    expect(list[0].embedding).not.toBeNull();
    const decoded = list[0].embedding;
    expect(decoded).toBeDefined();
    if (decoded) {
      expect(decoded.length).toBe(4);
      expect(decoded[3]).toBeCloseTo(1, 5);
    }
  });

  test("load preserves unrelated sidecar keys when re-persisting", async () => {
    const sidecar = new InMemorySidecar();
    sidecar.prime(
      JSON.stringify({
        searchHistory: [{ query: "foo", mode: "balanced", ranAt: 100 }],
      }),
    );
    const index = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
    });
    await index.load();
    await index.record(makeConversation({ id: "c1", topic: "t", updatedAt: 1 }));
    const persisted = JSON.parse(sidecar.raw() ?? "{}") as {
      searchHistory: unknown[];
      conversations: unknown[];
    };
    expect(persisted.searchHistory).toEqual([{ query: "foo", mode: "balanced", ranAt: 100 }]);
    expect(persisted.conversations.length).toBe(1);
  });

  test("evicts oldest entries beyond maxEntries cap", async () => {
    const sidecar = new InMemorySidecar();
    const index = new ConversationIndex({
      facade: sidecar,
      indexPath: "Notient/.index.json",
      maxEntries: 2,
    });
    await index.load();
    await index.record(makeConversation({ id: "old", topic: "old", updatedAt: 1 }));
    await index.record(makeConversation({ id: "mid", topic: "mid", updatedAt: 2 }));
    await index.record(makeConversation({ id: "new", topic: "new", updatedAt: 3 }));
    const list = index.list();
    expect(list.length).toBe(2);
    expect(list.map((entry) => entry.id).sort()).toEqual(["mid", "new"]);
  });

  test("decodeBase64Float32 round-trips encodeBase64Float32", () => {
    const original = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const decoded = decodeBase64Float32(encodeBase64Float32(original));
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
  });
});
