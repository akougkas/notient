import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { NOTIENT_IDENTITY } from "../../../../src/agent/identity";
import type { RpcCaller, RpcOutcome } from "../../../../src/cli/mcp/rpcBridge";
import { MCP_SERVER_NAME, createNotientMcpServer } from "../../../../src/cli/mcp/server";
import { VERSION } from "../../../../src/version";
import { noteReadFixture } from "../../../noteReadFixture";

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function scriptedCaller(
  reply: (call: RecordedCall) => RpcOutcome,
): RpcCaller & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async call(method, params) {
      const recorded = { method, params };
      calls.push(recorded);
      return reply(recorded);
    },
    async close() {
      /* no-op */
    },
  };
}

async function connectPair(caller: RpcCaller): Promise<Client> {
  const server = createNotientMcpServer({ caller, vaultPath: "/tmp/vault" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function blockText(result: unknown, index: number): string {
  const content = (result as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  const block = blocks[index] as { text?: string } | undefined;
  return block?.text ?? "";
}

function firstText(result: unknown): string {
  return blockText(result, 0);
}

function jsonPayload(result: unknown): unknown {
  return JSON.parse(blockText(result, 1) || "null");
}

function resourceText(result: { contents: unknown[] }): string {
  return String((result.contents[0] as { text?: string }).text ?? "");
}

function resourceMime(result: { contents: unknown[] }): string {
  return String((result.contents[0] as { mimeType?: string }).mimeType ?? "");
}

describe("createNotientMcpServer over an in-memory transport", () => {
  test("advertises the notient server, the read tools, and the gated write tools", async () => {
    const client = await connectPair(scriptedCaller(() => ({ ok: true, result: {}, events: [] })));
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getServerVersion()?.version).toBe(VERSION);
    expect(client.getInstructions()).toContain(NOTIENT_IDENTITY);
    expect(client.getInstructions()).toContain("visiting MCP host");
    expect(client.getInstructions()).toContain("pending receipt returns a callId");
    expect(client.getInstructions()).toContain("already staged a pending typed edge");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "notient_active_context",
      "notient_append_note",
      "notient_ask",
      "notient_brief",
      "notient_compare_notes",
      "notient_control_job",
      "notient_correlate_note",
      "notient_create_note",
      "notient_events",
      "notient_find_path",
      "notient_get_change_preview",
      "notient_get_job",
      "notient_get_review",
      "notient_history",
      "notient_history_entry",
      "notient_host_status",
      "notient_list_jobs",
      "notient_list_notes",
      "notient_list_pipelines",
      "notient_list_reviews",
      "notient_neighbors",
      "notient_preview_changes",
      "notient_propose_link",
      "notient_propose_note",
      "notient_read_note",
      "notient_replace_section",
      "notient_run_pipeline",
      "notient_search",
      "notient_session_list",
      "notient_submit_change",
      "notient_update_frontmatter",
      "notient_vitals",
    ]);
    const writeTools = new Set([
      "notient_run_pipeline",
      "notient_control_job",
      "notient_preview_changes",
      "notient_submit_change",
      "notient_create_note",
      "notient_append_note",
      "notient_replace_section",
      "notient_update_frontmatter",
      "notient_propose_note",
      "notient_propose_link",
    ]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(!writeTools.has(tool.name));
    }
    expect(
      listed.tools.find((tool) => tool.name === "notient_replace_section")?.annotations
        ?.destructiveHint,
    ).toBe(true);
    await client.close();
  });

  test("frontmatter patch values advertise the complete ordinary JSON domain", async () => {
    const client = await connectPair(scriptedCaller(() => ({ ok: true, result: {}, events: [] })));
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === "notient_update_frontmatter");
    const inputSchema = tool?.inputSchema as
      | {
          properties?: {
            patch?: {
              additionalProperties?: { $ref?: string };
              description?: string;
            };
          };
          definitions?: Record<string, { anyOf?: Array<{ type?: string }> }>;
        }
      | undefined;
    const patchSchema = inputSchema?.properties?.patch;
    expect(patchSchema?.description).toContain('{"status":"reviewed"}');
    expect(patchSchema?.description).toContain("never wrap");
    const definitionRef = patchSchema?.additionalProperties?.$ref;
    expect(definitionRef).toMatch(/^#\/definitions\//);
    const definitionName = definitionRef?.replace("#/definitions/", "") ?? "";
    const advertisedTypes =
      inputSchema?.definitions?.[definitionName]?.anyOf
        ?.map((entry) => entry.type)
        .filter((type): type is string => type !== undefined)
        .sort() ?? [];
    expect(advertisedTypes).toEqual(["array", "boolean", "null", "number", "object", "string"]);
    await client.close();
  });

  test("a pending write comes back as a non-error result naming the callId", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: {
        ok: true,
        applied: false,
        pending: true,
        callId: "notes-write-x-0",
        preview: "append Notient/a.md",
        path: "Notient/a.md",
      },
      events: [],
    }));
    const client = await connectPair(caller);
    const result = await client.callTool({
      name: "notient_append_note",
      arguments: { path: "Notient/a.md", revision: "b".repeat(64), text: "more" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(
      JSON.parse((result.content as Array<{ text: string }>)[1].text),
    );
    expect(firstText(result)).toContain(
      "Pending note write (callId notes-write-x-0; note bytes unchanged)",
    );
    expect(caller.calls[0]).toEqual({
      method: "notes.write",
      params: { op: "append", path: "Notient/a.md", revision: "b".repeat(64), text: "more" },
    });
    await client.close();
  });

  test("note edits advertise a required revision and reject missing or unexpected arguments", async () => {
    const caller = scriptedCaller(() => ({ ok: true, result: {}, events: [] }));
    const client = await connectPair(caller);
    const { tools } = await client.listTools();
    for (const name of [
      "notient_append_note",
      "notient_replace_section",
      "notient_update_frontmatter",
    ]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(schema?.required, name).toContain("revision");
      expect(schema?.additionalProperties, name).toBe(false);
    }
    const missing = await client.callTool({
      name: "notient_append_note",
      arguments: { path: "Notient/a.md", text: "more" },
    });
    expect(missing.isError).toBe(true);
    expect(firstText(missing)).toContain("revision");
    const extra = await client.callTool({
      name: "notient_replace_section",
      arguments: {
        path: "Notient/a.md",
        revision: "b".repeat(64),
        heading: "H",
        body: "x",
        force: true,
      },
    });
    expect(extra.isError).toBe(true);
    expect(firstText(extra)).toContain("force");
    expect(caller.calls).toHaveLength(0);
    await client.close();
  });

  test("proposal notes use the dedicated server-authored RPC", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: {
        ok: true,
        applied: true,
        path: "Notient/proposals/2026-03-04-move-to-passkeys.md",
        sha: "a".repeat(64),
        historyId: 'history:u"018f05cd-3f7b-7000-8000-000000000002"',
      },
      events: [],
    }));
    const client = await connectPair(caller);
    await client.callTool({
      name: "notient_propose_note",
      arguments: { title: "Move to passkeys", body: "why" },
    });
    expect(caller.calls[0]).toEqual({
      method: "proposals.propose_note",
      params: { title: "Move to passkeys", body: "why" },
    });
    await client.close();
  });

  test("typed link proposals use their own daemon RPC and stay pending", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: {
        ok: true,
        proposalId: "supports:0123456789abcdefabcd",
        sourcePath: "a.md",
        targetPath: "b.md",
        relation: "supports",
        pending: true,
      },
      events: [],
    }));
    const client = await connectPair(caller);
    const result = await client.callTool({
      name: "notient_propose_link",
      arguments: {
        sourcePath: "a.md",
        targetPath: "b.md",
        relation: "supports",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain(
      "Typed edge staged (proposalId supports:0123456789abcdefabcd; pending human decision)",
    );
    expect(caller.calls).toEqual([
      {
        method: "proposals.propose_link",
        params: {
          sourcePath: "a.md",
          targetPath: "b.md",
          relation: "supports",
        },
      },
    ]);
    await client.close();
  });

  test("tools/call returns a summary block plus a JSON payload block", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: noteReadFixture("line one\nline two"),
      events: [],
    }));
    const client = await connectPair(caller);
    const result = await client.callTool({
      name: "notient_read_note",
      arguments: { path: "a.md" },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("a.md lines 1-2 of 2");
    expect(jsonPayload(result)).toMatchObject({
      path: "a.md",
      body: "line one\nline two",
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.read",
      params: { path: "a.md" },
    });
    await client.close();
  });

  test("a daemon error frame becomes isError with the daemon code", async () => {
    const client = await connectPair(
      scriptedCaller(() => ({
        ok: false,
        code: "INVALID_PARAMS",
        message: "note not indexed",
      })),
    );
    const result = await client.callTool({
      name: "notient_vitals",
      arguments: { path: "a.md" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("INVALID_PARAMS: note not indexed");
    expect(jsonPayload(result)).toEqual({
      ok: false,
      code: "INVALID_PARAMS",
      message: "note not indexed",
    });
    await client.close();
  });

  test("unsafe path shapes reach Notient and return content INVALID_PARAMS, not SDK -32602", async () => {
    const caller = scriptedCaller(() => ({
      ok: false,
      code: "INVALID_PARAMS",
      message: "path is outside the public vault boundary",
    }));
    const client = await connectPair(caller);
    const cases = [
      { name: "notient_read_note", arguments: { path: "../outside.md" } },
      { name: "notient_list_notes", arguments: { folder: "/etc" } },
      { name: "notient_neighbors", arguments: { path: "escape/secret.md" } },
      { name: "notient_vitals", arguments: { path: ".notient/private.md" } },
      {
        name: "notient_propose_link",
        arguments: {
          sourcePath: ".notient/.env",
          targetPath: "b.md",
          relation: "related_to",
        },
      },
    ] as const;
    for (const invocation of cases) {
      const result = await client.callTool(invocation);
      expect(result.isError, invocation.name).toBe(true);
      expect(firstText(result), invocation.name).toBe(
        "INVALID_PARAMS: path is outside the public vault boundary",
      );
      expect(jsonPayload(result), invocation.name).toEqual({
        ok: false,
        code: "INVALID_PARAMS",
        message: "path is outside the public vault boundary",
      });
    }
    expect(caller.calls).toHaveLength(cases.length);
    await client.close();
  });

  test("write path schemas also return Notient content errors for unsafe shapes", async () => {
    const caller = scriptedCaller(() => ({ ok: true, result: {}, events: [] }));
    const client = await connectPair(caller);
    const cases = [
      {
        name: "notient_create_note",
        arguments: { path: ".notient/.env", body: "x" },
      },
      {
        name: "notient_append_note",
        arguments: { path: "../outside.md", revision: "b".repeat(64), text: "x" },
      },
      {
        name: "notient_replace_section",
        arguments: { path: "/etc/passwd", revision: "b".repeat(64), heading: "x", body: "x" },
      },
      {
        name: "notient_update_frontmatter",
        arguments: { path: ".notient/private.md", revision: "b".repeat(64), patch: { x: true } },
      },
    ] as const;
    for (const invocation of cases) {
      const result = await client.callTool(invocation);
      expect(result.isError, invocation.name).toBe(true);
      expect(firstText(result), invocation.name).toStartWith("INVALID_PARAMS:");
      expect(firstText(result), invocation.name).not.toContain("-32602");
    }
    expect(caller.calls).toHaveLength(0);
    await client.close();
  });

  test("a thrown transport failure becomes isError instead of killing the session", async () => {
    let calls = 0;
    const caller: RpcCaller = {
      async call() {
        calls++;
        throw new Error("SOCKET_GONE: unix socket vanished");
      },
      async close() {
        /* no-op */
      },
    };
    const client = await connectPair(caller);
    const failed = await client.callTool({
      name: "notient_list_notes",
      arguments: {},
    });
    expect(failed.isError).toBe(true);
    expect(firstText(failed)).toBe("SOCKET_GONE: unix socket vanished");
    // The session survives: a second call still round-trips.
    const again = await client.callTool({
      name: "notient_list_notes",
      arguments: {},
    });
    expect(again.isError).toBe(true);
    expect(calls).toBe(2);
    await client.close();
  });

  test("exposes notient://status backed by daemon.status", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: { ok: true, pid: 99, vault: "/tmp/vault" },
      events: [],
    }));
    const client = await connectPair(caller);
    const read = await client.readResource({ uri: "notient://status" });
    expect(caller.calls[0].method).toBe("daemon.status");
    expect(JSON.parse(resourceText(read))).toMatchObject({ pid: 99 });
    await client.close();
  });

  test("exposes notient://vault/{+path} backed by notes.read, slashes intact", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: { ok: true, body: "# Auth" },
      events: [],
    }));
    const client = await connectPair(caller);
    const read = await client.readResource({
      uri: "notient://vault/Projects/auth.md",
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.read",
      params: { path: "Projects/auth.md" },
    });
    expect(resourceText(read)).toBe("# Auth");
    expect(resourceMime(read)).toBe("text/markdown");
    await client.close();
  });

  test("lists vault notes as resources, skipping folder entries", async () => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: { ok: true, paths: ["Projects/", "a.md", "b.md"] },
      events: [],
    }));
    const client = await connectPair(caller);
    const listed = await client.listResources();
    const uris = listed.resources.map((entry) => entry.uri);
    expect(uris).toContain("notient://status");
    expect(uris).toContain("notient://vault/a.md");
    expect(uris).toContain("notient://vault/b.md");
    expect(uris).not.toContain("notient://vault/Projects/");
    await client.close();
  });

  test("vault resources round-trip spaces, Unicode, and literal percent signs", async () => {
    const notes = [
      {
        path: "Projects/My Note.md",
        uri: "notient://vault/Projects/My%20Note.md",
      },
      { path: "résumé.md", uri: "notient://vault/r%C3%A9sum%C3%A9.md" },
      { path: "100% ready.md", uri: "notient://vault/100%25%20ready.md" },
    ] as const;
    const caller = scriptedCaller(({ method, params }) => {
      if (method === "vault.list") {
        return {
          ok: true,
          result: { ok: true, paths: notes.map((note) => note.path) },
          events: [],
        };
      }
      return {
        ok: true,
        result: { ok: true, body: `# ${String(params.path)}` },
        events: [],
      };
    });
    const client = await connectPair(caller);

    const listed = await client.listResources();
    for (const note of notes) {
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: note.uri,
          name: note.path,
          mimeType: "text/markdown",
        }),
      );
      const read = await client.readResource({ uri: note.uri });
      expect(resourceText(read)).toBe(`# ${note.path}`);
    }
    expect(caller.calls.filter((call) => call.method === "notes.read")).toEqual(
      notes.map((note) => ({
        method: "notes.read",
        params: { path: note.path },
      })),
    );
    await client.close();
  });

  test.each([
    "notient://vault/a%2.md",
    "notient://vault/folder%2Fnote.md",
    "notient://vault/.notient%2F.env",
  ])("rejects a noncanonical vault resource URI before notes.read: %s", async (uri) => {
    const caller = scriptedCaller(() => ({
      ok: true,
      result: { ok: true, body: "must not be returned" },
      events: [],
    }));
    const client = await connectPair(caller);
    await expect(client.readResource({ uri })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(caller.calls).toHaveLength(0);
    await client.close();
  });

  test("exposes the notient_recall prompt", async () => {
    const client = await connectPair(scriptedCaller(() => ({ ok: true, result: {}, events: [] })));
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(["notient_recall"]);
    const prompt = await client.getPrompt({ name: "notient_recall" });
    const text = String((prompt.messages[0].content as { text?: string }).text ?? "");
    expect(text).toContain(NOTIENT_IDENTITY);
    expect(text).toContain("visiting host");
    expect(text).not.toContain("Notient assistant");
    expect(text).toContain("notient_ask");
    expect(text).toContain("notient_brief");
    expect(text).toContain("pending note write has changed no note bytes");
    expect(text).toContain("report its callId");
    expect(text).toContain("already staged a pending typed edge");
    expect(text).toContain("Report its proposalId");
    expect(text).toContain("wikilink-only connectivity");
    expect(text).not.toContain("Every write is gated");
    await client.close();
  });

  test("SDK-level schema validation rejects a missing required argument", async () => {
    const caller = scriptedCaller(() => ({ ok: true, result: {}, events: [] }));
    const client = await connectPair(caller);
    const result = await client.callTool({
      name: "notient_ask",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(caller.calls).toHaveLength(0);
    await client.close();
  });
});
