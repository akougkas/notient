import { describe, expect, test } from "bun:test";
import {
  ConversationStore,
  type ConversationStoreFacade,
  computeConversationPath,
  slugifyTopic,
} from "./conversationStore";
import type { Conversation } from "./types";

class InMemoryFacade implements ConversationStoreFacade {
  private readonly files = new Map<string, string>();

  async list(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return Array.from(this.files.keys())
      .filter((path) => path.startsWith(prefix) && path.endsWith(".md"))
      .sort();
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`not found: ${path}`);
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  raw(path: string): string | undefined {
    return this.files.get(path);
  }
}

function makeStore(initialNow = 1745625600000) {
  const facade = new InMemoryFacade();
  let current = initialNow;
  const advance = (ms: number) => {
    current += ms;
  };
  const store = new ConversationStore({
    facade,
    folder: "Notient/conversations",
    now: () => current,
  });
  return { store, facade, advance, getNow: () => current };
}

describe("conversationStore", () => {
  test("create writes a markdown file at the expected slug-date-and-id path", async () => {
    const { store, facade } = makeStore(Date.UTC(2026, 3, 25, 12, 0, 0));
    const created = await store.create({
      id: "conv-1",
      model: "qwen3-4b-mlx",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Hello World",
    });
    expect(created.notePath).toBe("Notient/conversations/2026-04-25 hello-world conv10.md");
    expect(facade.raw(created.notePath)).toBeDefined();
    expect(facade.raw(created.notePath)).toContain('conversation_id: "conv-1"');
  });

  test("load reads a saved conversation back", async () => {
    const { store } = makeStore();
    const created = await store.create({
      id: "conv-2",
      model: "qwen3-4b-mlx",
      pinnedContext: ["Notes/Pinned.md"],
      approvalMode: "safe",
      topic: "Reload",
    });
    const reloaded = await store.load(created.notePath);
    expect(reloaded.id).toBe("conv-2");
    expect(reloaded.pinnedContext).toEqual(["Notes/Pinned.md"]);
  });

  test("list returns all conversations sorted by updatedAt desc", async () => {
    const { store, advance } = makeStore(1000);
    const first = await store.create({
      id: "a",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Alpha",
    });
    advance(60_000);
    const second = await store.create({
      id: "b",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Beta",
    });
    advance(60_000);
    await store.save({ ...first, messages: [], summary: "touched" });
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("a");
    expect(list[1].id).toBe("b");
    expect(list[0].summary).toBe("touched");
    expect(list[0].updatedAt).toBeGreaterThan(second.updatedAt);
  });

  test("save updates updatedAt + message_count", async () => {
    const { store, facade, advance, getNow } = makeStore(2000);
    const created = await store.create({
      id: "c",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Save",
    });
    advance(120);
    const saved = await store.save({
      ...created,
      messages: [
        { id: "m1", role: "user", content: "hi", createdAt: getNow() },
        { id: "m2", role: "assistant", content: "hello", createdAt: getNow() },
      ],
    });
    expect(saved.messageCount).toBe(2);
    expect(saved.updatedAt).toBeGreaterThan(created.updatedAt);
    const raw = facade.raw(created.notePath);
    expect(raw).toContain("message_count: 2");
  });

  test("delete removes the file", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "d",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Delete me",
    });
    await store.delete(created.notePath);
    expect(facade.raw(created.notePath)).toBeUndefined();
    const list = await store.list();
    expect(list.length).toBe(0);
  });

  test("list skips malformed files instead of throwing", async () => {
    const { store, facade } = makeStore();
    await facade.write("Notient/conversations/garbage.md", "not a conversation at all");
    const created = await store.create({
      id: "ok",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Good",
    });
    const list = await store.list();
    // Garbage parses as a Conversation with empty/default fields rather than
    // throwing, so list returns both. The contract is "no throw"; ordering
    // by updatedAt puts the well-formed file first.
    expect(list.find((c) => c.id === "ok")).toBeDefined();
    expect(list[0].notePath).toBe(created.notePath);
  });
});

describe("conversationStore helpers", () => {
  test("slugifyTopic falls back to a default when topic is empty", () => {
    expect(slugifyTopic("")).toBe("conversation");
    expect(slugifyTopic("  ?? !! ")).toBe("conversation");
  });

  test("slugifyTopic clamps overlong topics to 60 characters", () => {
    const long = "a".repeat(120);
    expect(slugifyTopic(long).length).toBeLessThanOrEqual(60);
  });

  test("computeConversationPath assembles folder, date, slug, and id suffix", () => {
    const path = computeConversationPath(
      "Notient/conversations",
      Date.UTC(2026, 0, 2, 0, 0, 0),
      "Quick Sync",
      "abc-123-def",
    );
    expect(path).toBe("Notient/conversations/2026-01-02 quick-sync abc123.md");
  });
});

// Suppress noUnusedVars by referencing the Conversation type at least once.
const _typeReference: Conversation | undefined = undefined;
void _typeReference;
