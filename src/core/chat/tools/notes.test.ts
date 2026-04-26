import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { ApprovalGate } from "../approvalGate";
import type { ApprovalMode } from "../types";
import {
  type NotesFacade,
  type NotesHistoryRecord,
  type NotesToolsContext,
  makeAppendNoteTool,
  makeCreateNoteTool,
  makeHistoryRecorder,
  makeReplaceSectionTool,
  makeUpdateFrontmatterTool,
  mergeFrontmatter,
  replaceSection,
} from "./notes";

async function waitForPending(
  gate: ApprovalGate,
  count: number,
  maxTicks = 50,
): Promise<ReturnType<ApprovalGate["list"]>> {
  for (let i = 0; i < maxTicks; i++) {
    const pending = gate.list();
    if (pending.length >= count) return pending;
    await Promise.resolve();
  }
  throw new Error(`approvalGate did not reach ${count} pending entries`);
}

class InMemoryFacade implements NotesFacade {
  public files = new Map<string, string>();
  public writeCount = 0;

  async readNote(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing: ${path}`);
    return content;
  }

  async writeNote(path: string, content: string): Promise<void> {
    this.writeCount += 1;
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

interface Harness {
  context: NotesToolsContext;
  facade: InMemoryFacade;
  approvalGate: ApprovalGate;
  echoMarks: { path: string; sha: string }[];
  history: NotesHistoryRecord[];
  approvalsAutoYolo: number;
  setMode: (mode: ApprovalMode) => void;
  callIdCounter: number;
}

function newHarness(initialMode: ApprovalMode = "yolo"): Harness {
  const facade = new InMemoryFacade();
  const echoMarks: { path: string; sha: string }[] = [];
  const history: NotesHistoryRecord[] = [];
  let mode: ApprovalMode = initialMode;
  let autoYolo = 0;
  const approvalGate = new ApprovalGate({
    events: { onPending: () => {}, onResolved: () => {} },
    recordHistoryAutoApprove: async () => {
      autoYolo += 1;
    },
  });
  let callIdCounter = 0;
  const context: NotesToolsContext = {
    facade,
    approvalGate,
    echoGuard: {
      mark: (path, sha) => echoMarks.push({ path, sha }),
    },
    hash: async (content) => `sha-${content.length}`,
    approvalMode: () => mode,
    recordHistory: async (record) => {
      history.push(record);
    },
    generateCallId: () => {
      callIdCounter += 1;
      return `call-${callIdCounter}`;
    },
  };
  return {
    context,
    facade,
    approvalGate,
    echoMarks,
    history,
    get approvalsAutoYolo() {
      return autoYolo;
    },
    setMode: (next) => {
      mode = next;
    },
    callIdCounter,
  };
}

describe("notes.create", () => {
  test("creates a new note when path does not exist (yolo)", async () => {
    const harness = newHarness("yolo");
    const tool = makeCreateNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/note.md", body: "# Hello" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.path).toBe("/note.md");
      expect(result.sha).toBe("sha-7");
    }
    expect(harness.facade.files.get("/note.md")).toBe("# Hello");
    expect(harness.echoMarks).toEqual([{ path: "/note.md", sha: "sha-7" }]);
    expect(harness.history).toEqual([
      { kind: "notes.create", target: "/note.md", before: null, after: "# Hello" },
    ]);
  });

  test("returns applied=false when path already exists", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("/note.md", "existing");
    const tool = makeCreateNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/note.md", body: "new" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toContain("already exists");
    }
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("safe mode awaits user approval before writing", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const promise = tool.invoke(
      { notePath: "/note.md", body: "Body" },
      new AbortController().signal,
    );
    // Drain the microtask queue so the tool reaches approvalGate.request().
    await waitForPending(harness.approvalGate, 1);
    expect(harness.facade.writeCount).toBe(0);
    harness.approvalGate.resolve(harness.approvalGate.list()[0].callId, { approved: true });
    const result = await promise;
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("/note.md")).toBe("Body");
  });

  test("safe mode rejection returns applied=false with reason", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const promise = tool.invoke({ notePath: "/n.md", body: "B" }, new AbortController().signal);
    const pending = await waitForPending(harness.approvalGate, 1);
    harness.approvalGate.resolve(pending[0].callId, {
      approved: false,
      reason: "wrong path",
    });
    const result = await promise;
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe("wrong path");
    }
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("abort during pending approval rejects the invocation", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const controller = new AbortController();
    const promise = tool.invoke({ notePath: "/n.md", body: "x" }, controller.signal);
    await waitForPending(harness.approvalGate, 1);
    controller.abort();
    let caught: unknown = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("AbortError");
    expect(harness.facade.writeCount).toBe(0);
  });

  test("validate rejects missing fields", () => {
    const harness = newHarness("yolo");
    const tool = makeCreateNoteTool(harness.context);
    expect(() => tool.validate({})).toThrow();
    expect(() => tool.validate({ notePath: "" })).toThrow();
    expect(() => tool.validate({ notePath: "/x.md" })).toThrow();
  });
});

describe("notes.append", () => {
  test("appends to existing note with newline boundary", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("/n.md", "first");
    const tool = makeAppendNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/n.md", text: "second" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("/n.md")).toBe("first\nsecond");
    expect(harness.history[0]).toMatchObject({
      kind: "notes.append",
      target: "/n.md",
      before: "first",
      after: "first\nsecond",
    });
  });

  test("preserves trailing newline when present", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("/n.md", "first\n");
    const tool = makeAppendNoteTool(harness.context);
    await tool.invoke({ notePath: "/n.md", text: "second" }, new AbortController().signal);
    expect(harness.facade.files.get("/n.md")).toBe("first\nsecond");
  });

  test("returns applied=false when path is missing", async () => {
    const harness = newHarness("yolo");
    const tool = makeAppendNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/missing.md", text: "x" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(false);
    expect(harness.facade.writeCount).toBe(0);
  });

  test("validate rejects empty text", () => {
    const harness = newHarness("yolo");
    const tool = makeAppendNoteTool(harness.context);
    expect(() => tool.validate({ notePath: "/x.md", text: "" })).toThrow();
  });
});

describe("notes.replace_section", () => {
  test("replaces body under matching heading and keeps the heading line", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set(
      "/n.md",
      "# Title\nintro\n\n## Plans\nold body\nmore old\n\n## Other\nkeep me\n",
    );
    const tool = makeReplaceSectionTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/n.md", heading: "Plans", body: "fresh body" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("/n.md")).toBe(
      "# Title\nintro\n\n## Plans\nfresh body\n## Other\nkeep me\n",
    );
  });

  test("returns applied=false when heading not found", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("/n.md", "# Title\nbody");
    const tool = makeReplaceSectionTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/n.md", heading: "Missing", body: "x" },
      new AbortController().signal,
    );
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toContain("heading not found");
    }
    expect(harness.facade.writeCount).toBe(0);
  });

  test("replaceSection helper handles trailing-section replacement", () => {
    const out = replaceSection("# A\nbody\n## B\nold\n", "B", "new");
    expect(out).toBe("# A\nbody\n## B\nnew\n");
  });
});

describe("notes.update_frontmatter", () => {
  test("merges patch into existing frontmatter, preserving body", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("/n.md", "---\ntitle: old\n---\nbody\n");
    const tool = makeUpdateFrontmatterTool(harness.context);
    const result = await tool.invoke(
      { notePath: "/n.md", patch: { title: "new", tag: "alpha" } },
      new AbortController().signal,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("/n.md")).toBe("---\ntitle: new\ntag: alpha\n---\nbody\n");
    expect(harness.history[0].kind).toBe("notes.update_frontmatter");
  });

  test("creates frontmatter when absent", () => {
    const out = mergeFrontmatter("body only", { foo: "bar" });
    expect(out).toBe("---\nfoo: bar\n---\nbody only");
  });

  test("validate rejects non-object patches", () => {
    const harness = newHarness("yolo");
    const tool = makeUpdateFrontmatterTool(harness.context);
    expect(() => tool.validate({ notePath: "/x.md", patch: "no" })).toThrow();
  });
});

describe("makeHistoryRecorder", () => {
  test("inserts a row into the history table", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const recorder = makeHistoryRecorder(db, () => 999);
    await recorder({
      kind: "notes.create",
      target: "/n.md",
      before: null,
      after: "body",
    });
    const rows = db.query<{
      kind: string;
      target: string;
      before: string | null;
      after: string;
      created_at: number;
    }>("SELECT kind, target, before, after, created_at FROM history;");
    expect(rows).toEqual([
      { kind: "notes.create", target: "/n.md", before: null, after: "body", created_at: 999 },
    ]);
  });
});
