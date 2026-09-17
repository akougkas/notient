import { describe, expect, test } from "bun:test";
import { contentRevision, inspectMarkdown } from "../../../../../src/api/notes";
import { NoteApiError } from "../../../../../src/api/schema";
import { ApprovalGate } from "../../../../../src/core/chat/approvalGate";
import {
  type NotesFacade,
  type NotesHistoryRecord,
  type NotesToolsContext,
  makeAppendNoteTool,
  makeCreateNoteTool,
  makeReplaceSectionTool,
  makeUpdateFrontmatterTool,
  planSectionReplacement,
} from "../../../../../src/core/chat/tools/notes";
import type { ApprovalMode } from "../../../../../src/core/chat/types";
import { createUuidRecordId } from "../../../../../src/core/db/recordId";
import { patchFrontmatter } from "../../../../../src/core/markdown/frontmatter";

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
  public beforeGuardedWrite: ((path: string) => void) | undefined;

  async readNote(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing: ${path}`);
    return content;
  }

  async createNote(path: string, content: string): Promise<boolean> {
    this.beforeGuardedWrite?.(path);
    if (this.files.has(path)) return false;
    this.writeCount += 1;
    this.files.set(path, content);
    return true;
  }

  async writeNoteIfUnchanged(path: string, expected: string, content: string): Promise<boolean> {
    this.beforeGuardedWrite?.(path);
    if (this.files.get(path) !== expected) return false;
    this.writeCount += 1;
    this.files.set(path, content);
    return true;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

interface Harness {
  context: NotesToolsContext;
  facade: InMemoryFacade;
  approvalGate: ApprovalGate;
  history: NotesHistoryRecord[];
  approvalsAutoYolo: number;
  setMode: (mode: ApprovalMode) => void;
  callIdCounter: number;
}

function newHarness(initialMode: ApprovalMode = "yolo"): Harness {
  const facade = new InMemoryFacade();
  const history: NotesHistoryRecord[] = [];
  let mode: ApprovalMode = initialMode;
  let autoYolo = 0;
  const approvalGate = new ApprovalGate({
    recordHistoryAutoApprove: async () => {
      autoYolo += 1;
    },
    perToolPolicy: () => ({}),
    sessionGrants: { claim: async () => null },
  });
  let callIdCounter = 0;
  const context: NotesToolsContext = {
    facade,
    approvalGate,
    hash: async (content) => `sha-${content.length}`,
    approvalMode: () => mode,
    applyWrite: async (record) => {
      const applied =
        record.before === null
          ? await facade.createNote(record.target, record.after)
          : await facade.writeNoteIfUnchanged(record.target, record.before, record.after);
      if (!applied) return { applied: false, reason: "conflict" } as const;
      history.push(record);
      return {
        applied: true,
        historyId: createUuidRecordId(
          "history",
          `018f05cd-3f7b-7000-8000-${history.length.toString().padStart(12, "0")}`,
        ).toString(),
      } as const;
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

const HOSTILE_BODY = [
  "# Doc",
  "",
  "- [ ] buy milk",
  "- [x] ship it",
  "",
  "> [!note] Heads up",
  "> Careful with 5 * 3.",
  "",
  "Math $a_i$ and an escaped \\* star.",
  "",
].join("\n");
const TEST_CONTEXT = { clientIdentity: "human" } as const;
const HUMAN = { id: "human", kind: "human" as const, scopes: ["read", "write", "admin"] };

/** Exact saved revision a caller would have read; absent notes get a fixed stand-in. */
function rev(harness: Harness, path: string): string {
  return contentRevision(harness.facade.files.get(path) ?? "missing");
}

function section(source: string, heading: string, body: string, occurrence?: number): string {
  return planSectionReplacement(
    { body: source, structure: inspectMarkdown(source) },
    heading,
    body,
    occurrence,
  ).after;
}

describe("notes.create", () => {
  test("creates a new note when path does not exist (yolo)", async () => {
    const harness = newHarness("yolo");
    const tool = makeCreateNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "note.md", body: "# Hello" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.path).toBe("note.md");
      expect(result.sha).toBe("sha-7");
    }
    expect(harness.facade.files.get("note.md")).toBe("# Hello");
    expect(harness.history).toEqual([
      {
        kind: "notes.create",
        target: "note.md",
        before: null,
        after: "# Hello",
        clientIdentity: "human",
        authorize: expect.any(Function),
        toolApproval: {
          clientIdentity: "human",
          tool: "notes.create",
          paths: ["note.md"],
          edgeId: null,
          permission: { kind: "policy" },
        },
      },
    ]);
  });

  test("refuses an existing path before requesting approval", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "existing");
    const tool = makeCreateNoteTool(harness.context);
    await expect(
      tool.invoke({ notePath: "note.md", body: "new" }, new AbortController().signal, TEST_CONTEXT),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "path already exists: note.md" });
    expect(harness.approvalGate.hasPending()).toBe(false);
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("safe mode awaits user approval before writing", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const promise = tool.invoke(
      { notePath: "note.md", body: "Body" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    // Drain the microtask queue so the tool reaches approvalGate.request().
    await waitForPending(harness.approvalGate, 1);
    expect(harness.facade.writeCount).toBe(0);
    harness.approvalGate.resolve(
      harness.approvalGate.list()[0].callId,
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    const result = await promise;
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("note.md")).toBe("Body");
  });

  test("safe mode rejection returns applied=false with reason", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const promise = tool.invoke(
      { notePath: "n.md", body: "B" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
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
    const promise = tool.invoke({ notePath: "n.md", body: "x" }, controller.signal, TEST_CONTEXT);
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
    expect(() => tool.validate({ notePath: "x.md" })).toThrow();
  });
});

describe("notes.append", () => {
  test("appends to existing note with newline boundary", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", "first");
    const tool = makeAppendNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), text: "second" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("n.md")).toBe("first\nsecond");
    expect(harness.history[0]).toMatchObject({
      kind: "notes.append",
      target: "n.md",
      before: "first",
      after: "first\nsecond",
    });
  });

  test("preserves trailing newline when present", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", "first\n");
    const tool = makeAppendNoteTool(harness.context);
    await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), text: "second" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(harness.facade.files.get("n.md")).toBe("first\nsecond");
  });

  test("refuses a missing note before requesting approval", async () => {
    const harness = newHarness("yolo");
    const tool = makeAppendNoteTool(harness.context);
    await expect(
      tool.invoke(
        { notePath: "missing.md", revision: rev(harness, "missing.md"), text: "x" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(harness.facade.writeCount).toBe(0);
  });

  test("validate requires an exact revision and rejects unexpected arguments", () => {
    const tool = makeAppendNoteTool(newHarness("yolo").context);
    const revision = contentRevision("body");
    expect(() => tool.validate({ notePath: "x.md", text: "t" })).toThrow("revision");
    expect(() => tool.validate({ notePath: "x.md", revision: "abc", text: "t" })).toThrow(
      "revision",
    );
    expect(() =>
      tool.validate({ notePath: "x.md", revision, text: "t", heading: "ignored?" }),
    ).toThrow('Unrecognized key: "heading"');
    expect(tool.validate({ notePath: "x.md", revision, text: "t" })).toEqual({
      notePath: "x.md",
      revision,
      text: "t",
    });
    expect(tool.schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["revision"]),
    });
  });

  test("a stale revision is refused before any approval card exists", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("n.md", "saved\n");
    const stale = rev(harness, "n.md");
    harness.facade.files.set("n.md", "saved\nhuman edit\n");
    await expect(
      makeAppendNoteTool(harness.context).invoke(
        { notePath: "n.md", revision: stale, text: "agent" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("revision changed"),
    });
    expect(harness.approvalGate.hasPending()).toBe(false);
    expect(harness.facade.files.get("n.md")).toBe("saved\nhuman edit\n");
    expect(harness.history).toEqual([]);
  });

  test("the pending approval shows the exact addition and both revisions", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("n.md", "saved");
    const promise = makeAppendNoteTool(harness.context).invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), text: "agent line" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    const [pending] = await waitForPending(harness.approvalGate, 1);
    expect(pending.preview).toContain("\nagent line");
    expect(pending.preview).toContain(
      `Revision: ${contentRevision("saved").slice(0, 12)} -> ${contentRevision("saved\nagent line").slice(0, 12)}`,
    );
    expect(pending.args).toMatchObject({
      revision: contentRevision("saved"),
      afterRevision: contentRevision("saved\nagent line"),
    });
    harness.approvalGate.resolve(pending.callId, { approved: true }, HUMAN);
    expect(await promise).toMatchObject({ applied: true });
    expect(harness.facade.files.get("n.md")).toBe("saved\nagent line");
  });

  test("validate rejects empty text", () => {
    const harness = newHarness("yolo");
    const tool = makeAppendNoteTool(harness.context);
    expect(() =>
      tool.validate({ notePath: "x.md", revision: rev(harness, "x.md"), text: "" }),
    ).toThrow();
  });

  test("append never re-serializes the existing body", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", HOSTILE_BODY);
    const tool = makeAppendNoteTool(harness.context);
    await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), text: "- [ ] appended\n" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    const after = harness.facade.files.get("n.md") as string;
    expect(after.startsWith(HOSTILE_BODY)).toBe(true);
    expect(after.endsWith("- [ ] appended\n")).toBe(true);
  });
});

describe("notes.create", () => {
  test("writes the body verbatim, no markdown normalization", async () => {
    const harness = newHarness("yolo");
    const tool = makeCreateNoteTool(harness.context);
    const result = await tool.invoke(
      { notePath: "new.md", body: HOSTILE_BODY },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("new.md")).toBe(HOSTILE_BODY);
  });
});

describe("notes.replace_section", () => {
  test("replaces body under matching heading and keeps the heading line", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set(
      "n.md",
      "# Title\nintro\n\n## Plans\nold body\nmore old\n\n## Other\nkeep me\n",
    );
    const tool = makeReplaceSectionTool(harness.context);
    const result = await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), heading: "Plans", body: "fresh body" },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("n.md")).toBe(
      "# Title\nintro\n\n## Plans\nfresh body\n## Other\nkeep me\n",
    );
  });

  test("refuses a missing heading before approval", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", "# Title\nbody");
    const tool = makeReplaceSectionTool(harness.context);
    await expect(
      tool.invoke(
        { notePath: "n.md", revision: rev(harness, "n.md"), heading: "Missing", body: "x" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "heading not found: Missing" });
    expect(harness.facade.writeCount).toBe(0);
  });

  test("a repeated heading is never guessed; an exact occurrence selects one section", async () => {
    const harness = newHarness("safe");
    const source = "# Log\n\n## Notes\nfirst\n\n## Notes\nsecond\n";
    harness.facade.files.set("n.md", source);
    const tool = makeReplaceSectionTool(harness.context);
    await expect(
      tool.invoke(
        { notePath: "n.md", revision: rev(harness, "n.md"), heading: "Notes", body: "x" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("occurs 2 times"),
    });
    expect(harness.approvalGate.hasPending()).toBe(false);
    const promise = tool.invoke(
      {
        notePath: "n.md",
        revision: rev(harness, "n.md"),
        heading: "Notes",
        occurrence: 2,
        body: "replaced",
      },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    const [pending] = await waitForPending(harness.approvalGate, 1);
    expect(pending.preview).toContain("occurrence 2");
    expect(pending.preview).toContain("--- removed (7 chars)\nsecond\n");
    expect(pending.preview).toContain("+++ inserted (9 chars)\nreplaced\n");
    harness.approvalGate.resolve(pending.callId, { approved: true }, HUMAN);
    expect(await promise).toMatchObject({ applied: true });
    expect(harness.facade.files.get("n.md")).toBe(
      "# Log\n\n## Notes\nfirst\n\n## Notes\nreplaced\n",
    );
  });

  test("section splice handles trailing-section replacement", () => {
    const out = section("# A\nbody\n## B\nold\n", "B", "new");
    expect(out).toBe("# A\nbody\n## B\nnew\n");
  });

  test("replaceSection stops at the next heading of the same or higher level", () => {
    const source = "## A\nold\n### A.1\nsub\n## B\nkeep\n";
    expect(section(source, "A", "new")).toBe("## A\nnew\n## B\nkeep\n");
  });

  test("replaceSection leaves task checkboxes, callouts, math and escapes intact", () => {
    const source = [
      "# Doc",
      "",
      "- [ ] buy milk",
      "- [x] ship it",
      "",
      "> [!warning]+ Careful",
      "> Body with 5 * 3 and $a_i$ and \\* escaped.",
      "",
      "## Target",
      "",
      "old body",
      "",
      "## Tail",
      "",
      "- [ ] still open",
      "",
    ].join("\n");
    const out = section(source, "Target", "new body") as string;
    expect(out).toContain("- [ ] buy milk");
    expect(out).toContain("- [x] ship it");
    expect(out).toContain("> [!warning]+ Careful");
    expect(out).toContain("5 * 3");
    expect(out).toContain("$a_i$");
    expect(out).toContain("\\* escaped");
    expect(out).toContain("## Target\nnew body\n");
    expect(out).toContain("## Tail\n\n- [ ] still open\n");
  });

  test("replaceSection ignores heading lines inside fenced code blocks", () => {
    const source = "# T\n\n```\n## Sec\n```\n\n## Sec\n\nreal\n";
    expect(section(source, "Sec", "new")).toBe("# T\n\n```\n## Sec\n```\n\n## Sec\nnew\n");
  });

  test("replaceSection ignores heading lines inside tilde fences", () => {
    const source = "# T\n\n~~~\n## Sec\n~~~\n\n## Sec\n\nreal\n";
    expect(section(source, "Sec", "new")).toBe("# T\n\n~~~\n## Sec\n~~~\n\n## Sec\nnew\n");
  });

  test("replaceSection matches headings in CRLF files and preserves the line endings", () => {
    const source = "# T\r\n\r\n## Sec\r\n\r\nold\r\n";
    expect(section(source, "Sec", "new")).toBe("# T\r\n\r\n## Sec\r\nnew\r\n");
  });

  test("section splice tolerates a BOM before the first heading", () => {
    const source = "\uFEFF## Sec\n\nold\n";
    expect(section(source, "Sec", "new")).toBe("\uFEFF## Sec\nnew\n");
  });

  test("section splice keeps Obsidian block ids and setext headings outside the target", () => {
    const source = "Intro ^intro\n\nSec\n---\nold ^old\n\n## Tail\nkeep ^tail\n";
    expect(section(source, "Sec", "new")).toBe(
      "Intro ^intro\n\nSec\n---\nnew\n## Tail\nkeep ^tail\n",
    );
  });

  test("section splice adds a line break after a final heading without one", () => {
    expect(section("# A\n## B", "B", "new")).toBe("# A\n## B\nnew");
  });

  test("section splice matches the rendered heading text reported by note structure", () => {
    const source = "## **Bold** plan\nold\n";
    expect(inspectMarkdown(source).headings[0].text).toBe("Bold plan");
    expect(section(source, "Bold plan", "new")).toBe("## **Bold** plan\nnew\n");
    expect(() => section(source, "Bold plan", "new", 2)).toThrow(NoteApiError);
  });
});

describe("notes.update_frontmatter", () => {
  test("merges patch into existing frontmatter, preserving body", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", "---\ntitle: old\n---\nbody\n");
    const tool = makeUpdateFrontmatterTool(harness.context);
    const result = await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), patch: { title: "new", tag: "alpha" } },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    expect(harness.facade.files.get("n.md")).toBe("---\ntitle: new\ntag: alpha\n---\nbody\n");
    expect(harness.history[0].kind).toBe("notes.update_frontmatter");
  });

  test("creates frontmatter when absent", () => {
    const out = patchFrontmatter("body only", { foo: "bar" });
    expect(out).toBe("---\nfoo: bar\n---\nbody only");
  });

  test("block-form lists survive a frontmatter patch (regression: flat-YAML data loss)", async () => {
    const harness = newHarness("yolo");
    const before = [
      "---",
      "title: Real Note",
      "aliases:",
      "  - alpha",
      "  - beta",
      "tags:",
      "  - homelab",
      "---",
      "",
      "- [ ] buy milk",
      "",
      "> [!note] Hi",
      "",
      "Math $a_i$ and 5 * 3.",
      "",
    ].join("\n");
    harness.facade.files.set("n.md", before);
    const tool = makeUpdateFrontmatterTool(harness.context);
    const result = await tool.invoke(
      { notePath: "n.md", revision: rev(harness, "n.md"), patch: { status: "live" } },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(result.applied).toBe(true);
    const after = harness.facade.files.get("n.md") as string;
    expect(after).toContain("aliases:\n  - alpha\n  - beta\n");
    expect(after).toContain("tags:\n  - homelab\n");
    expect(after).toContain("status: live\n");
    expect(after.slice(after.indexOf("\n---\n") + 5)).toBe(
      before.slice(before.indexOf("\n---\n") + 5),
    );
  });

  test("merges one level into an existing notient mapping", () => {
    const before = '---\nnotient:\n  health: 0.5\n  contradicts:\n    - "[[A]]"\n---\nbody\n';
    const out = patchFrontmatter(before, {
      notient: { freshness: 0.9, contradicts: ["[[A]]", "[[B]]"] },
    });
    expect(out).toBe(
      '---\nnotient:\n  health: 0.5\n  contradicts:\n    - "[[A]]"\n    - "[[B]]"\n  freshness: 0.9\n---\nbody\n',
    );
  });

  test("unparseable frontmatter is refused instead of guessed", async () => {
    const harness = newHarness("yolo");
    harness.facade.files.set("n.md", "---\ntags: [unclosed\n---\nbody\n");
    await expect(
      makeUpdateFrontmatterTool(harness.context).invoke(
        { notePath: "n.md", revision: rev(harness, "n.md"), patch: { status: "x" } },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("not valid YAML"),
    });
    expect(harness.facade.writeCount).toBe(0);
  });

  test("BOM and CRLF notes keep their bytes; tags and aliases are replaced exactly as previewed", async () => {
    const harness = newHarness("safe");
    const source = "\uFEFF---\r\ntags:\r\n  - old\r\naliases: [A]\r\n---\r\nbody\r\n";
    harness.facade.files.set("n.md", source);
    const promise = makeUpdateFrontmatterTool(harness.context).invoke(
      {
        notePath: "n.md",
        revision: rev(harness, "n.md"),
        patch: { tags: ["new", "émoji-✨"], aliases: null },
      },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    const [pending] = await waitForPending(harness.approvalGate, 1);
    expect(pending.preview).toContain("--- before\ntags:\r\n  - old\r\naliases: [A]\r\n");
    const after = harness.facade.files.get("n.md") as string;
    expect(after).toBe(source);
    harness.approvalGate.resolve(pending.callId, { approved: true }, HUMAN);
    expect(await promise).toMatchObject({ applied: true });
    const written = harness.facade.files.get("n.md") as string;
    expect(written.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(written.endsWith("---\r\nbody\r\n")).toBe(true);
    expect(pending.preview).toContain(
      `+++ after\n${written.slice(6, written.indexOf("---\r\nbody"))}`,
    );
    expect(inspectMarkdown(written).frontmatter.properties).toEqual({ tags: ["new", "émoji-✨"] });
  });

  test("validate rejects non-object patches", () => {
    const harness = newHarness("yolo");
    const tool = makeUpdateFrontmatterTool(harness.context);
    expect(() =>
      tool.validate({ notePath: "x.md", revision: rev(harness, "x.md"), patch: "no" }),
    ).toThrow();
  });
});

describe("concurrent edits during the approval window", () => {
  /**
   * Starts a write tool in safe mode, lets it park on the approval gate,
   * applies the caller's concurrent edit to the file, then approves. This is
   * exactly what happens over RPC: notes.write returns immediately and the
   * invocation sits pending while the user keeps editing in their editor.
   * The approval covered the preview of the old bytes, so it must not
   * authorize a recomputed change against the new ones.
   */
  async function approveAfterEdit<T>(
    harness: Harness,
    promise: Promise<T>,
    edit: () => void,
  ): Promise<T> {
    const pending = await waitForPending(harness.approvalGate, 1);
    edit();
    harness.approvalGate.resolve(pending[0].callId, { approved: true }, HUMAN);
    return promise;
  }

  const refused = (path: string) => ({
    applied: false as const,
    reason: `note changed after the approved preview; nothing was written: ${path}`,
  });

  test("append refuses an edit made while approval was pending", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "original\n");
    const tool = makeAppendNoteTool(harness.context);
    const result = await approveAfterEdit(
      harness,
      tool.invoke(
        { notePath: "note.md", revision: rev(harness, "note.md"), text: "appended" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.set("note.md", "original\nuser typed this\n"),
    );
    expect(result).toEqual(refused("note.md"));
    expect(harness.facade.files.get("note.md")).toBe("original\nuser typed this\n");
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("replace_section refuses an edit elsewhere in the note while approval was pending", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "# Doc\n\n## Sec\n\nold\n");
    const tool = makeReplaceSectionTool(harness.context);
    const result = await approveAfterEdit(
      harness,
      tool.invoke(
        { notePath: "note.md", revision: rev(harness, "note.md"), heading: "Sec", body: "new" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.set("note.md", "# Doc\n\nuser typed this\n\n## Sec\n\nold\n"),
    );
    expect(result).toEqual(refused("note.md"));
    expect(harness.facade.files.get("note.md")).toBe("# Doc\n\nuser typed this\n\n## Sec\n\nold\n");
    expect(harness.history).toEqual([]);
  });

  test("replace_section refuses when the heading disappears during approval", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "# Doc\n\n## Sec\n\nold\n");
    const tool = makeReplaceSectionTool(harness.context);
    const result = await approveAfterEdit(
      harness,
      tool.invoke(
        { notePath: "note.md", revision: rev(harness, "note.md"), heading: "Sec", body: "new" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.set("note.md", "# Doc\n\nuser deleted the section\n"),
    );
    expect(result).toEqual(refused("note.md"));
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("update_frontmatter never overwrites a property changed during approval", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "---\nstatus: draft\n---\n\nbody\n");
    const tool = makeUpdateFrontmatterTool(harness.context);
    const edited = "---\nstatus: published\n---\n\nbody\n";
    const result = await approveAfterEdit(
      harness,
      tool.invoke(
        { notePath: "note.md", revision: rev(harness, "note.md"), patch: { status: "reviewed" } },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.set("note.md", edited),
    );
    expect(result).toEqual(refused("note.md"));
    expect(harness.facade.files.get("note.md")).toBe(edited);
    expect(harness.history).toEqual([]);
  });

  test("a note deleted during approval is refused", async () => {
    const harness = newHarness("safe");
    harness.facade.files.set("note.md", "body\n");
    const result = await approveAfterEdit(
      harness,
      makeAppendNoteTool(harness.context).invoke(
        { notePath: "note.md", revision: rev(harness, "note.md"), text: "x" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.delete("note.md"),
    );
    expect(result).toEqual(refused("note.md"));
    expect(harness.facade.files.has("note.md")).toBe(false);
  });

  test("create skips when the path appears during approval", async () => {
    const harness = newHarness("safe");
    const tool = makeCreateNoteTool(harness.context);
    const result = await approveAfterEdit(
      harness,
      tool.invoke(
        { notePath: "note.md", body: "agent body" },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
      () => harness.facade.files.set("note.md", "user body"),
    );
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toContain("already exists");
    expect(harness.facade.files.get("note.md")).toBe("user body");
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  test("create loses an exact publish race without overwriting or recording history", async () => {
    const harness = newHarness("yolo");
    harness.facade.beforeGuardedWrite = (path) => {
      harness.facade.files.set(path, "human-at-commit");
    };
    const result = await makeCreateNoteTool(harness.context).invoke(
      { notePath: "note.md", body: "agent" },
      new AbortController().signal,
      TEST_CONTEXT,
    );

    expect(result).toEqual({ applied: false, reason: "path already exists: note.md" });
    expect(harness.facade.files.get("note.md")).toBe("human-at-commit");
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  for (const operation of ["append", "replace_section", "update_frontmatter"] as const) {
    test(`${operation} loses an exact commit race without overwriting or recording history`, async () => {
      const harness = newHarness("yolo");
      const initial = operation === "replace_section" ? "# Doc\n\n## Sec\nold\n" : "body\n";
      harness.facade.files.set("note.md", initial);
      harness.facade.beforeGuardedWrite = (path) => {
        harness.facade.files.set(path, "human-at-commit\n");
      };
      const signal = new AbortController().signal;
      const revision = rev(harness, "note.md");
      const result =
        operation === "append"
          ? await makeAppendNoteTool(harness.context).invoke(
              { notePath: "note.md", revision, text: "agent" },
              signal,
              TEST_CONTEXT,
            )
          : operation === "replace_section"
            ? await makeReplaceSectionTool(harness.context).invoke(
                { notePath: "note.md", revision, heading: "Sec", body: "agent" },
                signal,
                TEST_CONTEXT,
              )
            : await makeUpdateFrontmatterTool(harness.context).invoke(
                { notePath: "note.md", revision, patch: { status: "agent" } },
                signal,
                TEST_CONTEXT,
              );

      expect(result).toEqual(refused("note.md"));
      expect(harness.facade.files.get("note.md")).toBe("human-at-commit\n");
      expect(harness.facade.writeCount).toBe(0);
      expect(harness.history).toEqual([]);
    });
  }
});

describe("notes write path boundary", () => {
  test.each([
    ["hidden", ".secret.md"],
    ["traversal", "../escape.md"],
    ["non-Markdown", "note.txt"],
    ["conversation artifact", "Notient/conversations/forged.md"],
    ["proposal artifact", "notient/PROPOSALS/forged.md"],
  ])("every notes.* validator rejects %s before facade access", (_label, notePath) => {
    const harness = newHarness("yolo");
    const tools = [
      [makeCreateNoteTool(harness.context), { notePath, body: "body" }],
      [makeAppendNoteTool(harness.context), { notePath, text: "text" }],
      [makeReplaceSectionTool(harness.context), { notePath, heading: "Heading", body: "body" }],
      [makeUpdateFrontmatterTool(harness.context), { notePath, patch: { status: "x" } }],
    ] as const;

    for (const [tool, args] of tools) {
      expect(() => tool.validate(args)).toThrow("outside Notient-owned artifact folders");
    }
    expect(harness.facade.writeCount).toBe(0);
    expect(harness.history).toEqual([]);
  });
});
