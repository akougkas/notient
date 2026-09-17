import { describe, expect, test } from "bun:test";
import { serializeConversation } from "../../../../src/core/chat/conversationParser";
import {
  ConversationStore,
  type ConversationStoreFacade,
  computeConversationPath,
  slugifyTopic,
} from "../../../../src/core/chat/conversationStore";
import type { Conversation } from "../../../../src/core/chat/types";

class InMemoryFacade implements ConversationStoreFacade {
  private readonly files = new Map<string, string>();
  private readonly unreadable = new Set<string>();
  beforeGuardedMutation: ((path: string) => void) | undefined;
  listedPaths: string[] | undefined;
  readonly readPaths: string[] = [];

  async list(folder: string): Promise<string[]> {
    if (this.listedPaths !== undefined) return [...this.listedPaths];
    const prefix = `${folder}/`;
    return Array.from(this.files.keys())
      .filter((path) => path.startsWith(prefix) && path.endsWith(".md"))
      .sort();
  }

  async read(path: string): Promise<string> {
    this.readPaths.push(path);
    if (this.unreadable.has(path)) throw new Error(`unreadable: ${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`not found: ${path}`);
    return value;
  }

  async createIfAbsent(path: string, content: string): Promise<boolean> {
    this.beforeGuardedMutation?.(path);
    if (this.files.has(path)) return false;
    this.files.set(path, content);
    return true;
  }

  /** Models the guarded replacement's window in which the target is renamed away. */
  hideDuringWrite = false;

  async writeIfUnchanged(path: string, expected: string, content: string): Promise<boolean> {
    this.beforeGuardedMutation?.(path);
    if (this.files.get(path) !== expected) return false;
    if (this.hideDuringWrite) {
      this.files.delete(path);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.files.set(path, content);
    return true;
  }

  async removeIfUnchanged(path: string, expected: string): Promise<boolean> {
    this.beforeGuardedMutation?.(path);
    if (this.files.get(path) !== expected) return false;
    this.files.delete(path);
    return true;
  }

  raw(path: string): string | undefined {
    return this.files.get(path);
  }

  failReadsFor(path: string): void {
    this.unreadable.add(path);
  }

  seed(path: string, content: string): void {
    this.files.set(path, content);
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
      clientIdentity: "human",
    });
    expect(created.notePath).toBe("Notient/conversations/2026-04-25 hello-world conv10.md");
    expect(facade.raw(created.notePath)).toBeDefined();
    expect(facade.raw(created.notePath)).toContain('conversation_id: "conv-1"');
  });

  test("list ignores the vault writer's in-flight artifacts beside a conversation", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "conv-inflight",
      model: "qwen3-4b-mlx",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "In flight",
      clientIdentity: "human",
    });
    const id = "c433db40-e408-4c13-ae35-7c1d650d9150";
    facade.listedPaths = [
      created.notePath,
      `${created.notePath}.notient-tmp-1343999-${id}`,
      `${created.notePath}.notient-claim-1343999-${id}`,
      `${created.notePath}.notient-rollback-1343999-${id}`,
    ];
    expect((await store.list()).map((conversation) => conversation.id)).toEqual(["conv-inflight"]);
    expect(facade.readPaths.every((path) => path === created.notePath)).toBe(true);
    // Any other foreign file is still an integrity failure, not skipped.
    facade.listedPaths = [`${created.notePath}.bak`];
    await expect(store.list()).rejects.toThrow("conversation storage integrity");
  });

  test("list and load wait out this store's own in-flight save", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "conv-race",
      model: "qwen3-4b-mlx",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Race",
      clientIdentity: "human",
    });
    facade.hideDuringWrite = true;
    const saving = store.updateSummary(created.notePath, "conv-race", "refreshed");
    const [listed, loaded] = await Promise.all([store.list(), store.load(created.notePath)]);
    expect(listed.map((conversation) => conversation.summary)).toEqual(["refreshed"]);
    expect(loaded.summary).toBe("refreshed");
    await saving;
    // A save queued while a scan runs still completes.
    const [, saved] = await Promise.all([
      store.list(),
      store.updateSummary(created.notePath, "conv-race", "again"),
    ]);
    expect(saved.summary).toBe("again");
  });

  test("load reads a saved conversation back", async () => {
    const { store } = makeStore();
    const created = await store.create({
      id: "conv-2",
      model: "qwen3-4b-mlx",
      pinnedContext: ["Notes/Pinned.md"],
      approvalMode: "safe",
      topic: "Reload",
      clientIdentity: "human",
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
      clientIdentity: "human",
    });
    advance(60_000);
    const second = await store.create({
      id: "b",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Beta",
      clientIdentity: "human",
    });
    advance(60_000);
    await store.save(first, { ...first, messages: [], summary: "touched" });
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
      clientIdentity: "human",
    });
    advance(120);
    const saved = await store.save(created, {
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

  test("updateSummary reads the latest transcript and preserves every message", async () => {
    const { store } = makeStore(3000);
    const created = await store.create({
      id: "summary",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Summary lane",
      clientIdentity: "human",
    });
    const latest = await store.save(created, {
      ...created,
      messages: [
        { id: "u", role: "user", content: "question", createdAt: 3000 },
        { id: "a", role: "assistant", content: "answer", createdAt: 3001 },
      ],
    });

    const summarized = await store.updateSummary(latest.notePath, latest.id, "canonical recap");

    expect(summarized.summary).toBe("canonical recap");
    expect(summarized.messages.map((message) => message.content)).toEqual(["question", "answer"]);
    expect((await store.load(latest.notePath)).messageCount).toBe(2);
  });

  test("updateSummary refuses to write through a mismatched conversation id", async () => {
    const { store } = makeStore();
    const created = await store.create({
      id: "expected",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Identity",
      clientIdentity: "human",
    });

    await expect(
      store.updateSummary(created.notePath, "different", "must not land"),
    ).rejects.toThrow("conversation id mismatch");
    expect((await store.load(created.notePath)).summary).toBe("");
  });

  test("delete removes the file", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "d",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Delete me",
      clientIdentity: "human",
    });
    await store.delete(created.notePath);
    expect(facade.raw(created.notePath)).toBeUndefined();
    const list = await store.list();
    expect(list.length).toBe(0);
  });

  test("create preserves a file that appears at the exclusive publish point", async () => {
    const { store, facade } = makeStore();
    facade.beforeGuardedMutation = (path) => facade.seed(path, "human-at-create");

    await expect(
      store.create({
        id: "race-create",
        model: "m",
        pinnedContext: [],
        approvalMode: "safe",
        topic: "Race",
        clientIdentity: "human",
      }),
    ).rejects.toThrow("conversation changed during guarded mutation");
    const path = computeConversationPath(
      "Notient/conversations",
      1745625600000,
      "Race",
      "race-create",
    );
    expect(facade.raw(path)).toBe("human-at-create");
  });

  test("save preserves an external edit that lands after its comparison read", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "race-save",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Race save",
      clientIdentity: "human",
    });
    facade.beforeGuardedMutation = (path) => facade.seed(path, "human-at-save");

    await expect(store.save(created, { ...created, summary: "notient" })).rejects.toThrow(
      "conversation changed during guarded mutation",
    );
    expect(facade.raw(created.notePath)).toBe("human-at-save");
  });

  test("a stale save cannot overwrite a newer transcript queued in the same lane", async () => {
    const { store } = makeStore(10_000);
    const created = await store.create({
      id: "stale-save",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Stale save",
      clientIdentity: "human",
    });
    const first = await store.save(created, {
      ...created,
      messages: [{ id: "a", role: "user", content: "first", createdAt: 10_001 }],
    });

    await expect(
      store.save(created, {
        ...created,
        messages: [{ id: "b", role: "user", content: "stale", createdAt: 10_002 }],
      }),
    ).rejects.toThrow("conversation changed during guarded mutation");
    expect((await store.load(created.notePath)).messages.map((message) => message.content)).toEqual(
      first.messages.map((message) => message.content),
    );
  });

  test("a stale save cannot overwrite a newer pinned-context frontmatter revision", async () => {
    const { store } = makeStore(10_000);
    const created = await store.create({
      id: "stale-pinned",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Stale pinned",
      clientIdentity: "human",
    });
    const latest = await store.save(created, {
      ...created,
      pinnedContext: ["Projects/current.md"],
    });

    await expect(
      store.save(created, {
        ...created,
        pinnedContext: ["Projects/stale.md"],
      }),
    ).rejects.toThrow("conversation changed during guarded mutation");
    expect((await store.load(created.notePath)).pinnedContext).toEqual(latest.pinnedContext);
  });

  test("save rejects persisted identity and configuration rewrites", async () => {
    const { store } = makeStore();
    const created = await store.create({
      id: "immutable",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Immutable",
      clientIdentity: "human",
    });

    await expect(store.save(created, { ...created, clientIdentity: "codex" })).rejects.toThrow(
      "cannot change persisted identity",
    );
    await expect(store.save(created, { ...created, model: "other" })).rejects.toThrow(
      "cannot change persisted configuration",
    );
  });

  test("delete preserves an external edit that lands after its comparison read", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "race-delete",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Race delete",
      clientIdentity: "human",
    });
    facade.beforeGuardedMutation = (path) => facade.seed(path, "human-at-delete");

    await expect(store.delete(created.notePath)).rejects.toThrow(
      "conversation changed during guarded mutation",
    );
    expect(facade.raw(created.notePath)).toBe("human-at-delete");
  });

  test("list ignores ordinary Markdown without a conversation marker", async () => {
    const { store, facade } = makeStore();
    facade.seed("Notient/conversations/garbage.md", "not a conversation at all");
    const created = await store.create({
      id: "ok",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Good",
      clientIdentity: "human",
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("ok");
    expect(list[0].notePath).toBe(created.notePath);
  });

  test("list rejects duplicate paths and duplicate conversation ids instead of choosing one", async () => {
    const { store, facade } = makeStore();
    const first = await store.create({
      id: "shared-id",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "First",
      clientIdentity: "human",
    });
    const secondPath = "Notient/conversations/2026-04-25 second.md";
    facade.seed(
      secondPath,
      serializeConversation({
        ...first,
        notePath: secondPath,
        topic: "Second",
      }),
    );

    await expect(store.list()).rejects.toThrow("duplicate conversation id 'shared-id'");

    facade.listedPaths = [first.notePath, first.notePath];
    await expect(store.list()).rejects.toThrow(`duplicate path '${first.notePath}'`);
  });

  test("load rejects a path outside the exact conversation folder before reading", async () => {
    const { store, facade } = makeStore();
    await expect(store.load("Projects/private.md")).rejects.toThrow(
      "conversation storage integrity: path is outside",
    );
    await expect(store.load("Notient/conversations/nested/private.md")).rejects.toThrow(
      "conversation storage integrity: path is outside",
    );
    expect(facade.readPaths).toEqual([]);
  });

  test("list surfaces corruption in a marked Notient conversation", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "corrupt",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Corrupt",
      clientIdentity: "human",
    });
    const raw = facade.raw(created.notePath);
    if (raw === undefined) throw new Error("expected the created conversation to exist");
    facade.seed(created.notePath, raw.replace('model: "m"', "model: null"));

    await expect(store.list()).rejects.toThrow(
      `invalid Notient conversation '${created.notePath}': invalid conversation: model must be a JSON string`,
    );
  });

  test("list surfaces read failures instead of presenting an incomplete history", async () => {
    const { store, facade } = makeStore();
    const created = await store.create({
      id: "unreadable",
      model: "m",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Unreadable",
      clientIdentity: "human",
    });
    facade.failReadsFor(created.notePath);

    await expect(store.list()).rejects.toThrow(`unreadable: ${created.notePath}`);
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
