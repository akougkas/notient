import { describe, expect, test } from "bun:test";
import { contentRevision } from "../../../../src/api/notes";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import {
  type NotesToolsContext,
  makeAppendNoteTool,
  makeCreateNoteTool,
  makeReplaceSectionTool,
  makeUpdateFrontmatterTool,
} from "../../../../src/core/chat/tools/notes";
import { ToolRegistry } from "../../../../src/core/chat/tools/registry";
import type { SessionGrant } from "../../../../src/core/services/sessionGrants";
import {
  type NotesWriteHandlerDeps,
  makeNotesWriteHandler,
} from "../../../../src/daemon/handlers/notesWrite";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

function rev(h: Harness, path: string): string {
  return contentRevision(h.files.get(path) ?? "missing");
}

function historyRecordId(value: number): string {
  return `history:u"00000000-0000-4000-8000-${value.toString().padStart(12, "0")}"`;
}

function makeGrant(): SessionGrant {
  return {
    id: 'agent_session:u"00000000-0000-4000-8000-000000000007"',
    client: "claude-code",
    grantedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    allowedFolders: ["Inbox/"],
    allowedTools: ["*"],
    maxWrites: null,
    usedWrites: 1,
    revokedAt: null,
  };
}

interface Harness {
  handler: ReturnType<typeof makeNotesWriteHandler>;
  gate: ApprovalGate;
  files: Map<string, string>;
  history: { kind: string; target: string; clientIdentity?: string }[];
}

function build(options: {
  grant?: SessionGrant | null;
  approvalMode?: "safe" | "yolo";
  files?: Record<string, string>;
}): Harness {
  const files = new Map(Object.entries(options.files ?? {}));
  const history: { kind: string; target: string; clientIdentity?: string }[] = [];
  const gate = new ApprovalGate({
    recordHistoryAutoApprove: async () => {},
    perToolPolicy: () => ({}),
    sessionGrants: {
      claim: async () => options.grant ?? null,
    },
  });
  let callCounter = 0;
  const toolRegistry = new ToolRegistry();
  const notesContext: NotesToolsContext = {
    facade: {
      readNote: async (path: string) => {
        const body = files.get(path);
        if (body === undefined) throw new Error(`NOT_FOUND: ${path}`);
        return body;
      },
      exists: async (path: string) => files.has(path),
    },
    approvalGate: gate,
    approvalMode: () => options.approvalMode ?? "safe",
    applyWrite: async (record) => {
      if (record.target.startsWith("/") || record.target.includes("..")) {
        throw new Error("INVALID_PARAMS: path escapes vault");
      }
      const applied =
        record.before === null
          ? !files.has(record.target)
          : files.get(record.target) === record.before;
      if (!applied) return { applied: false, reason: "conflict" } as const;
      files.set(record.target, record.after);
      history.push({
        kind: record.kind,
        target: record.target,
        clientIdentity: record.clientIdentity,
      });
      return { applied: true, historyId: historyRecordId(history.length) } as const;
    },
    hash: async (content) => `sha-${content.length}`,
    generateCallId: () => `test-note-call-${callCounter++}`,
  };
  toolRegistry.register(makeCreateNoteTool(notesContext));
  toolRegistry.register(makeAppendNoteTool(notesContext));
  toolRegistry.register(makeReplaceSectionTool(notesContext));
  toolRegistry.register(makeUpdateFrontmatterTool(notesContext));
  const deps: NotesWriteHandlerDeps = { toolRegistry, approvalGate: gate };
  return { handler: makeNotesWriteHandler(deps), gate, files, history };
}

describe("notes.write", () => {
  test("a session grant auto-approves and the write applies immediately", async () => {
    const h = build({ grant: makeGrant() });
    const result = await h.handler(
      rpcRequest(
        { op: "create", path: "Inbox/new.md", body: "# hi\n" },
        { principal: agentPrincipal() },
      ),
    );
    expect(result.applied).toBe(true);
    expect(result.path).toBe("Inbox/new.md");
    expect(result.historyId).toBe(historyRecordId(1));
    expect(h.files.get("Inbox/new.md")).toBe("# hi\n");
    expect(h.history[0]).toEqual({
      kind: "notes.create",
      target: "Inbox/new.md",
      clientIdentity: "claude-code",
    });
    expect(h.gate.hasPending()).toBe(false);
  });

  test("yolo mode auto-approves through the per-mode policy", async () => {
    const h = build({ approvalMode: "yolo", files: { "Inbox/a.md": "one\n" } });
    const result = await h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "two\n" },
        { principal: agentPrincipal() },
      ),
    );
    expect(result.applied).toBe(true);
    expect(h.files.get("Inbox/a.md")).toBe("one\ntwo\n");
  });

  test("safe mode returns pending with a callId and does not write yet", async () => {
    const h = build({ approvalMode: "safe", files: { "Inbox/a.md": "one\n" } });
    const result = await h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "two\n" },
        { principal: agentPrincipal() },
      ),
    );
    expect(result).toMatchObject({ ok: true, applied: false, pending: true });
    expect(typeof result.callId).toBe("string");
    expect(String(result.preview)).toContain("Append to Inbox/a.md");
    expect(h.files.get("Inbox/a.md")).toBe("one\n");
    expect(h.gate.hasPending()).toBe(true);
  });

  test("a later approval of that callId performs the write", async () => {
    const h = build({ approvalMode: "safe", files: { "Inbox/a.md": "one\n" } });
    const result = await h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "two\n" },
        { principal: agentPrincipal() },
      ),
    );
    const callId = String(result.callId);
    expect(
      h.gate.resolve(
        callId,
        { approved: true },
        { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      ),
    ).toBe(true);
    // The tool finishes on its own microtask chain once the gate resolves.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.files.get("Inbox/a.md")).toBe("one\ntwo\n");
    expect(h.history[0]).toEqual({
      kind: "notes.append",
      target: "Inbox/a.md",
      clientIdentity: "claude-code",
    });
  });

  test("a rejected decision leaves the note untouched", async () => {
    const h = build({ approvalMode: "safe", files: { "Inbox/a.md": "one\n" } });
    const result = await h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "two\n" },
        { principal: agentPrincipal() },
      ),
    );
    h.gate.resolve(String(result.callId), { approved: false, reason: "no" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.files.get("Inbox/a.md")).toBe("one\n");
    expect(h.history).toHaveLength(0);
  });

  test("replace_section and update_frontmatter route through the same gate", async () => {
    const h = build({
      grant: makeGrant(),
      files: { "Inbox/a.md": "# Title\n\n## Notes\nold\n" },
    });
    const replaced = await h.handler(
      rpcRequest(
        {
          op: "replace_section",
          path: "Inbox/a.md",
          revision: rev(h, "Inbox/a.md"),
          heading: "Notes",
          body: "new",
        },
        { principal: agentPrincipal() },
      ),
    );
    expect(replaced.applied).toBe(true);
    expect(h.files.get("Inbox/a.md")).toContain("new");

    const patched = await h.handler(
      rpcRequest(
        {
          op: "update_frontmatter",
          path: "Inbox/a.md",
          revision: rev(h, "Inbox/a.md"),
          patch: { status: "draft" },
        },
        { requestId: "req-2", principal: agentPrincipal() },
      ),
    );
    expect(patched.applied).toBe(true);
    expect(h.files.get("Inbox/a.md")).toContain("status: draft");
  });

  test("an agent principal is refused before gating on any non-writable path", async () => {
    const h = build({ grant: makeGrant() });
    for (const path of [
      "../outside.md",
      "/etc/passwd",
      "Inbox/../../escape.md",
      ".hidden.md",
      "Inbox/note.txt",
      "Notient/conversations/forged.md",
      "notient/PROPOSALS/forged.md",
    ]) {
      await expect(
        h.handler(rpcRequest({ op: "create", path, body: "x" }, { principal: agentPrincipal() })),
      ).rejects.toThrow("exact writable public vault-relative Markdown note path");
    }
    // Nothing was gated on the way to the rejection.
    expect(h.gate.hasPending()).toBe(false);
    expect(h.history).toEqual([]);
  });

  test("rejects an unknown op and malformed args", async () => {
    const h = build({ grant: makeGrant() });
    expect(
      h.handler(rpcRequest({ op: "delete", path: "a.md" }, { principal: agentPrincipal() })),
    ).rejects.toThrow(/op must be one of/);
    expect(
      h.handler(rpcRequest({ op: "create" }, { principal: agentPrincipal() })),
    ).rejects.toThrow(/path is required/);
    expect(
      h.handler(rpcRequest({ op: "create", path: "a.md" }, { principal: agentPrincipal() })),
    ).rejects.toThrow(/body: Invalid input/);
    expect(
      h.handler(
        rpcRequest(
          { op: "update_frontmatter", path: "a.md", revision: contentRevision(""), patch: "nope" },
          { principal: agentPrincipal() },
        ),
      ),
    ).rejects.toThrow(/patch: Invalid input/);
  });

  test("existing-note writes require a revision and reject unknown or renamed fields", async () => {
    const h = build({ grant: makeGrant(), files: { "Inbox/a.md": "one\n" } });
    const principal = agentPrincipal();
    await expect(
      h.handler(rpcRequest({ op: "append", path: "Inbox/a.md", text: "x" }, { principal })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("revision"),
    });
    await expect(
      h.handler(
        rpcRequest(
          {
            op: "append",
            path: "Inbox/a.md",
            revision: rev(h, "Inbox/a.md"),
            text: "x",
            heading: "H",
          },
          { principal },
        ),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining('"heading"'),
    });
    await expect(
      h.handler(
        rpcRequest(
          { op: "create", path: "Inbox/b.md", notePath: "Inbox/c.md", body: "x" },
          { principal },
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(h.gate.hasPending()).toBe(false);
    expect(h.history).toEqual([]);
  });

  test("a stale revision is a CONFLICT before any approval is requested", async () => {
    const h = build({ approvalMode: "safe", files: { "Inbox/a.md": "one\n" } });
    const stale = rev(h, "Inbox/a.md");
    h.files.set("Inbox/a.md", "one\nhuman\n");
    await expect(
      h.handler(
        rpcRequest(
          { op: "append", path: "Inbox/a.md", revision: stale, text: "agent" },
          { principal: agentPrincipal() },
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.gate.hasPending()).toBe(false);
    expect(h.files.get("Inbox/a.md")).toBe("one\nhuman\n");
  });

  test("an edit made while the pending approval waits is refused, not recomputed", async () => {
    const h = build({ approvalMode: "safe", files: { "Inbox/a.md": "one\n" } });
    const result = await h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "agent\n" },
        { principal: agentPrincipal() },
      ),
    );
    expect(result).toMatchObject({ pending: true });
    h.files.set("Inbox/a.md", "one\nhuman\n");
    h.gate.resolve(
      String(result.callId),
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.files.get("Inbox/a.md")).toBe("one\nhuman\n");
    expect(h.history).toEqual([]);
  });

  test("two overlapping gated writes keep their own call ids", async () => {
    const h = build({
      approvalMode: "safe",
      files: { "Inbox/a.md": "a\n", "Inbox/b.md": "b\n" },
    });
    const first = h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/a.md", revision: rev(h, "Inbox/a.md"), text: "one\n" },
        { principal: agentPrincipal() },
      ),
    );
    const second = h.handler(
      rpcRequest(
        { op: "append", path: "Inbox/b.md", revision: rev(h, "Inbox/b.md"), text: "two\n" },
        { requestId: "req-2", principal: agentPrincipal() },
      ),
    );

    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(settled).not.toBeNull();
    const [resultA, resultB] = settled as Record<string, unknown>[];

    expect(h.gate.pendingCount()).toBe(2);
    const byPath = new Map(h.gate.listPending().map((entry) => [entry.path, entry.callId]));
    expect(resultA?.callId).toBe(byPath.get("Inbox/a.md"));
    expect(resultB?.callId).toBe(byPath.get("Inbox/b.md"));
    expect(String(resultA?.preview)).toContain("Append to Inbox/a.md");
    expect(String(resultB?.preview)).toContain("Append to Inbox/b.md");
  });

  test("a tool-level refusal before approval is a typed conflict", async () => {
    const h = build({ grant: makeGrant(), files: { "Inbox/a.md": "one\n" } });
    await expect(
      h.handler(
        rpcRequest(
          { op: "create", path: "Inbox/a.md", body: "x" },
          { principal: agentPrincipal() },
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "path already exists: Inbox/a.md" });
    expect(h.gate.hasPending()).toBe(false);
  });
});
