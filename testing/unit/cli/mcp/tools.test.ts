import { describe, expect, test } from "bun:test";
import type { RpcCaller, RpcOutcome } from "../../../../src/cli/mcp/rpcBridge";
import type { ToolResult } from "../../../../src/cli/mcp/tools";
import { NOTIENT_MCP_TOOLS, findTool, isFailure } from "../../../../src/cli/mcp/tools";
import { proposalSlug } from "../../../../src/core/approvals/proposalNote";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { graphConnection, graphNeighborsFixture } from "../../../graphFixture";
import { currentCoverageFixture } from "../../../indexingFixture";
import { noteReadFixture } from "../../../noteReadFixture";
import { pipelineJobFixture } from "../../../pipelineJobFixture";

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeCaller extends RpcCaller {
  calls: RecordedCall[];
}

function fakeCaller(reply: RpcOutcome | ((call: RecordedCall) => RpcOutcome)): FakeCaller {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async call(method, params) {
      const recorded = { method, params };
      calls.push(recorded);
      return typeof reply === "function" ? reply(recorded) : reply;
    },
    async close() {
      /* no-op */
    },
  };
}

function ok(result: Record<string, unknown>): RpcOutcome {
  return { ok: true, result, events: [] };
}

function eventId(value: number): string {
  return createUuidRecordId(
    "agent_event",
    `018f05cd-3f7b-7000-8000-${value.toString().padStart(12, "0")}`,
  ).toString();
}

const SESSION_ID = createUuidRecordId(
  "agent_session",
  "018f05cd-3f7b-7000-8000-000000000001",
).toString();
const HISTORY_ID = createUuidRecordId("history", "018f05cd-3f7b-7000-8000-000000000002").toString();
const CHUNK_ID = createUuidRecordId("chunk", "018f05cd-3f7b-7000-8000-000000000003").toString();
const CONTENT_SHA = "a".repeat(64);
const CLAIM_SHA = "b".repeat(64);
const QUESTION_SHA = "c".repeat(64);

function askResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    answer: "You chose passkeys.",
    citations: [
      {
        path: "auth.md",
        score: 0.8,
        quote: "passkeys",
        revision: "a".repeat(64),
        range: { start: 0, end: 8, startLine: 1, endLine: 1 },
      },
    ],
    openQuestions: ["recovery flow?"],
    confidence: 0.7,
    toolCalls: [
      {
        name: "vault.search_notes",
        args: { query: "auth" },
        durationMs: 12,
      },
    ],
    durationMs: 30,
    attempts: [],
    coverage: currentCoverageFixture(),
    ...overrides,
  };
}

function briefResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    topic: "auth",
    summary: {
      text: "Passkeys are preferred.",
      evidence: [
        {
          path: "auth.md",
          revision: CONTENT_SHA,
          quote: "passkeys",
          range: { start: 0, end: 8, startLine: 1, endLine: 1 },
        },
      ],
    },
    findings: [],
    sources: [{ path: "auth.md", revision: CONTENT_SHA }],
    abstained: false,
    reason: null,
    coverage: currentCoverageFixture(),
    limitations: [],
    attempts: [],
    durationMs: 45,
    ...overrides,
  };
}

function searchResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    result: {
      query: "auth",
      mode: "balanced",
      coverage: currentCoverageFixture(),
      hits: [
        {
          notePath: "a.md",
          chunkId: CHUNK_ID,
          snippet: "passkeys",
          score: 0.9,
          matchedText: "auth",
        },
      ],
      durationMs: 15,
    },
    ...overrides,
  };
}

const VITALS_SNAPSHOT = {
  notePath: "a.md",
  freshness: 0.8,
  health: 0.7,
  connectivityCount: 3,
  connectivityTier: "connected",
  maturity: "mature",
  wordCount: 120,
  computedAt: 1_700_000_000_000,
} as const;

function agentEvent(value: number): Record<string, unknown> {
  return {
    id: eventId(value),
    ts: 1_700_000_000_000 + value,
    type: "swarm:link_proposed",
    payload: { notePath: "a.md" },
  };
}

const SESSION = {
  sessionId: SESSION_ID,
  client: "mcp-client",
  expiresAt: 1_700_000_000_000,
  allowedFolders: ["Notient/"],
  allowedTools: ["notes.create"],
  maxWrites: 10,
  usedWrites: 1,
  revokedAt: null,
} as const;

async function runTool(
  name: string,
  caller: RpcCaller,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return await tool.run(caller, args);
}

interface RuntimeInputSchema {
  safeParse(value: unknown): { success: boolean };
  description?: string;
}

function inputSchema(toolName: string, field: string): RuntimeInputSchema {
  const tool = findTool(toolName);
  if (tool === undefined) throw new Error(`no such tool: ${toolName}`);
  const schema = tool.inputShape[field];
  if (schema === undefined) throw new Error(`${toolName} has no ${field} input`);
  return schema as unknown as RuntimeInputSchema;
}

function inputAccepts(toolName: string, field: string, value: unknown): boolean {
  return inputSchema(toolName, field).safeParse(value).success;
}

describe("notient MCP tool catalogue", () => {
  test("comparison success must belong to the exact requested revisions and correlation anchor", async () => {
    const a = { path: "a.md", revision: CONTENT_SHA };
    const b = { path: "b.md", revision: CONTENT_SHA };
    const c = { path: "c.md", revision: CONTENT_SHA };
    const result = {
      ok: true,
      sources: [a, b],
      comparisons: [],
      abstained: true,
      reason: "Insufficient evidence.",
      coverage: null,
      limitations: [],
      attempts: [],
      durationMs: 1,
    };
    expect(
      isFailure(
        await runTool("notient_compare_notes", fakeCaller(ok(result)), { sources: [a, b] }),
      ),
    ).toBe(false);
    expect(
      await runTool("notient_compare_notes", fakeCaller(ok(result)), { sources: [a, c] }),
    ).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(
      await runTool("notient_compare_notes", fakeCaller(ok(result)), {
        sources: [{ ...a, revision: "b".repeat(64) }, b],
      }),
    ).toMatchObject({ ok: false, code: "INTERNAL" });
    const unrelatedPair = {
      ...result,
      sources: [a, b, c],
      comparisons: [
        {
          source: b,
          target: c,
          judgment: "insufficient",
          assessment: 0,
          explanation: "No useful evidence.",
          evidence: [],
        },
      ],
    };
    expect(
      await runTool("notient_correlate_note", fakeCaller(ok(unrelatedPair)), {
        source: a,
        scope: {},
        limit: 6,
      }),
    ).toMatchObject({ ok: false, code: "INTERNAL" });
  });
  test("every tool has a unique notient_-prefixed name and a description", () => {
    const names = NOTIENT_MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of NOTIENT_MCP_TOOLS) {
      expect(tool.name.startsWith("notient_")).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });

  test("catalogue includes bounded host reads and the existing domain tools", () => {
    expect(NOTIENT_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "notient_compare_notes",
      "notient_correlate_note",
      "notient_history",
      "notient_history_entry",
      "notient_find_path",
      "notient_list_reviews",
      "notient_get_review",
      "notient_get_change_preview",
      "notient_host_status",
      "notient_active_context",
      "notient_list_pipelines",
      "notient_run_pipeline",
      "notient_list_jobs",
      "notient_get_job",
      "notient_control_job",
      "notient_preview_changes",
      "notient_submit_change",
      "notient_ask",
      "notient_brief",
      "notient_search",
      "notient_read_note",
      "notient_list_notes",
      "notient_neighbors",
      "notient_vitals",
      "notient_events",
      "notient_session_list",
      "notient_create_note",
      "notient_append_note",
      "notient_replace_section",
      "notient_update_frontmatter",
      "notient_propose_note",
      "notient_propose_link",
    ]);
  });

  test("write tools are the only ones not annotated read-only", () => {
    const writeNames = NOTIENT_MCP_TOOLS.filter((tool) => !tool.annotations.readOnlyHint).map(
      (tool) => tool.name,
    );
    expect(writeNames).toEqual([
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
  });

  test("replace_section is the only destructive tool", () => {
    const destructive = NOTIENT_MCP_TOOLS.filter(
      (tool) => tool.annotations.destructiveHint === true,
    ).map((tool) => tool.name);
    expect(destructive).toEqual(["notient_replace_section"]);
  });

  test("descriptions distinguish live graph reads, wikilink vitals, and staged proposals", () => {
    const neighbors = findTool("notient_neighbors")?.description ?? "";
    const vitals = findTool("notient_vitals")?.description ?? "";
    const proposeLink = findTool("notient_propose_link")?.description ?? "";
    expect(neighbors).toContain("bounded connections with revisions");
    expect(neighbors).toContain("authored links, reviewed relationships");
    expect(vitals).toContain("public, contained, live indexed Markdown note");
    expect(vitals).toContain("wikilink-only connectivity");
    expect(proposeLink).toContain("exact replay returns the same pending proposal");
    expect(proposeLink).toContain("terminally rejected");
  });

  test("every note-write description promises callId receipts without claiming typed edges are unchanged", () => {
    for (const name of [
      "notient_create_note",
      "notient_append_note",
      "notient_replace_section",
      "notient_update_frontmatter",
      "notient_propose_note",
    ]) {
      const description = findTool(name)?.description ?? "";
      expect(description).toContain("applied: false");
      expect(description).toContain("callId");
      expect(description).toContain("no note bytes change");
    }
    const proposeLink = findTool("notient_propose_link")?.description ?? "";
    expect(proposeLink).not.toContain("callId");
    expect(proposeLink).not.toContain("no note bytes change");
  });

  test("numeric schemas expose the daemon's actual hard caps", () => {
    expect(inputAccepts("notient_ask", "maxRounds", 8)).toBe(true);
    expect(inputAccepts("notient_ask", "maxRounds", 9)).toBe(false);
    expect(inputAccepts("notient_search", "limit", 50)).toBe(true);
    expect(inputAccepts("notient_search", "limit", 51)).toBe(false);
    expect(inputAccepts("notient_brief", "limit", 8)).toBe(true);
    expect(inputAccepts("notient_brief", "limit", 9)).toBe(false);
    expect(inputAccepts("notient_list_notes", "limit", 200)).toBe(true);
    expect(inputAccepts("notient_list_notes", "limit", 201)).toBe(false);
    expect(inputAccepts("notient_events", "limit", 1000)).toBe(true);
    expect(inputAccepts("notient_events", "limit", 1001)).toBe(false);
  });

  test("path inputs stay plain strings so Notient owns containment errors", () => {
    expect(inputAccepts("notient_read_note", "path", "Projects/auth.md")).toBe(true);
    for (const path of [".notient/.env", "../auth.md", "/tmp/auth.md", "escape/auth.md"]) {
      expect(inputAccepts("notient_read_note", "path", path)).toBe(true);
      expect(inputAccepts("notient_list_notes", "folder", path)).toBe(true);
      expect(inputAccepts("notient_neighbors", "path", path)).toBe(path === "escape/auth.md");
      expect(inputAccepts("notient_vitals", "path", path)).toBe(true);
      expect(inputAccepts("notient_create_note", "path", path)).toBe(true);
      expect(inputAccepts("notient_propose_link", "sourcePath", path)).toBe(true);
    }
  });
});

describe("notient_ask", () => {
  test("maps question/maxRounds onto ask.run intent/maxRoundsPerTurn", async () => {
    const caller = fakeCaller(ok(askResult()));
    const result = await runTool("notient_ask", caller, {
      question: "auth?",
      maxRounds: 3,
    });
    expect(caller.calls[0]).toEqual({
      method: "ask.run",
      params: { query: "auth?", scope: {}, maxRoundsPerTurn: 3 },
    });
    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;
    expect(result.summary).toContain("You chose passkeys.");
    expect(result.payload).toEqual({
      answer: "You chose passkeys.",
      citations: [
        {
          path: "auth.md",
          score: 0.8,
          quote: "passkeys",
          revision: "a".repeat(64),
          range: { start: 0, end: 8, startLine: 1, endLine: 1 },
        },
      ],
      openQuestions: ["recovery flow?"],
      confidence: 0.7,
      attempts: [],
      coverage: currentCoverageFixture(),
    });
  });

  test("omits maxRoundsPerTurn when maxRounds is absent", async () => {
    const caller = fakeCaller(
      ok(
        askResult({
          answer: "",
          citations: [],
          openQuestions: [],
          confidence: 0,
          toolCalls: [],
        }),
      ),
    );
    await runTool("notient_ask", caller, { question: "auth?" });
    expect(caller.calls[0].params).toEqual({ query: "auth?", scope: {} });
  });

  test("converts a daemon error frame into a failure outcome", async () => {
    const caller = fakeCaller({
      ok: false,
      code: "MODEL_UNAVAILABLE",
      message: "no model",
    });
    const result = await runTool("notient_ask", caller, { question: "auth?" });
    expect(result).toEqual({
      ok: false,
      code: "MODEL_UNAVAILABLE",
      message: "no model",
    });
  });

  test.each([
    askResult({ answer: undefined }),
    askResult({ citations: null }),
    askResult({ openQuestions: [null] }),
    askResult({ confidence: 2 }),
    askResult({ toolCalls: [{ name: "vault.search_notes", durationMs: 1 }] }),
    askResult({ durationMs: -1 }),
  ])("rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_ask", fakeCaller(ok(malformed)), {
      question: "auth?",
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    if (!isFailure(result)) return;
    expect(result.message).toContain("ask.run result integrity failure");
  });
});

describe("notient_brief", () => {
  test("uses the canonical input and preserves exact evidence, coverage and accounting", async () => {
    const expected = briefResult();
    const caller = fakeCaller(ok(expected));
    const result = await runTool("notient_brief", caller, { query: "auth", scope: {}, limit: 4 });
    expect(caller.calls[0]).toMatchObject({
      method: "brief.run",
      params: { query: "auth", limit: 4 },
    });
    if (isFailure(result)) throw new Error(result.message);
    expect(result.payload).toEqual(expected);
  });
  test("binds a file brief to its requested saved revision", async () => {
    const source = { path: "auth.md", revision: CONTENT_SHA };
    expect(
      isFailure(
        await runTool("notient_brief", fakeCaller(ok(briefResult())), { source, scope: {} }),
      ),
    ).toBe(false);
    expect(
      isFailure(
        await runTool("notient_brief", fakeCaller(ok(briefResult())), {
          source: { ...source, revision: "d".repeat(64) },
          scope: {},
        }),
      ),
    ).toBe(true);
  });
  test.each([
    {},
    { query: "auth", source: { path: "auth.md", revision: CONTENT_SHA }, scope: {} },
    { query: "auth", scope: {}, admin: true },
    { source: { path: ".notient/.env", revision: CONTENT_SHA }, scope: {} },
  ])("rejects invalid or overreaching inputs before calling the daemon %#", async (args) => {
    const caller = fakeCaller(ok({}));
    expect(isFailure(await runTool("notient_brief", caller, args))).toBe(true);
    expect(caller.calls).toHaveLength(0);
  });
  test.each([
    briefResult({ summary: "" }),
    briefResult({ sources: [] }),
    briefResult({ findings: [null] }),
    briefResult({ abstained: true }),
    briefResult({ durationMs: undefined }),
    briefResult({ topic: "another request" }),
  ])("rejects malformed or mismatched outcomes %#", async (malformed) => {
    expect(
      await runTool("notient_brief", fakeCaller(ok(malformed)), { query: "auth", scope: {} }),
    ).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("notient_search", () => {
  test("defaults mode to balanced and unwraps the nested result hits", async () => {
    const caller = fakeCaller(ok(searchResult()));
    const result = await runTool("notient_search", caller, { query: "auth" });
    expect(caller.calls[0]).toEqual({
      method: "search.run",
      params: { query: "auth", mode: "balanced" },
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({
      query: "auth",
      mode: "balanced",
      coverage: currentCoverageFixture(),
      hits: [
        {
          notePath: "a.md",
          chunkId: CHUNK_ID,
          snippet: "passkeys",
          score: 0.9,
          matchedText: "auth",
        },
      ],
    });
    expect(result.summary).toContain("1 hit(s)");
  });

  test("passes mode and limit through", async () => {
    const caller = fakeCaller(
      ok(
        searchResult({
          result: {
            query: "auth",
            mode: "deep",
            coverage: currentCoverageFixture(),
            hits: [],
            durationMs: 10,
            synthesis: null,
          },
        }),
      ),
    );
    await runTool("notient_search", caller, {
      query: "auth",
      mode: "deep",
      limit: 5,
    });
    expect(caller.calls[0].params).toEqual({
      query: "auth",
      mode: "deep",
      limit: 5,
    });
  });

  test("preserves valid deep synthesis and graph-expanded hit provenance", async () => {
    const expandedHit = {
      notePath: "related.md",
      chunkId: null,
      snippet: "related evidence",
      score: 0.6,
      matchedText: "",
      viaPath: "a.md",
      edgeType: "related_to",
      confidence: 0.75,
    };
    const synthesis = {
      bullets: [{ text: "Passkeys are preferred [[auth]]", citations: ["[[auth]]"] }],
      rawText: "- Passkeys are preferred [[auth]]",
    };
    const caller = fakeCaller(
      ok(
        searchResult({
          result: {
            query: "auth",
            mode: "deep",
            coverage: currentCoverageFixture(),
            hits: [expandedHit],
            durationMs: 20,
            synthesis,
          },
        }),
      ),
    );
    const result = await runTool("notient_search", caller, {
      query: "auth",
      mode: "deep",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({
      query: "auth",
      mode: "deep",
      coverage: currentCoverageFixture(),
      hits: [expandedHit],
      synthesis,
    });
  });

  test("rejects a null terminal result instead of fabricating zero hits", async () => {
    const caller = fakeCaller(ok({ result: null }));
    const result = await runTool("notient_search", caller, { query: "auth" });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test.each([
    searchResult({
      result: { query: "auth", mode: "balanced", durationMs: 1 },
    }),
    searchResult({
      result: { query: "other", mode: "balanced", hits: [], durationMs: 1 },
    }),
    searchResult({
      result: { query: "auth", mode: "quick", hits: [], durationMs: 1 },
    }),
    searchResult({
      result: {
        query: "auth",
        mode: "balanced",
        hits: [{ notePath: "a.md", score: 0.8 }],
        durationMs: 1,
      },
    }),
    searchResult({
      result: { query: "auth", mode: "balanced", hits: [], durationMs: -1 },
    }),
  ])("rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_search", fakeCaller(ok(malformed)), {
      query: "auth",
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("notient_read_note", () => {
  const body = "one\ntwo\nthree\nfour";

  test("returns the whole body when no range is given", async () => {
    const caller = fakeCaller(ok(noteReadFixture(body)));
    const result = await runTool("notient_read_note", caller, { path: "a.md" });
    expect(caller.calls[0]).toEqual({
      method: "notes.read",
      params: { path: "a.md" },
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({
      path: "a.md",
      startLine: 1,
      endLine: 4,
      totalLines: 4,
      body,
      note: noteReadFixture(body).note,
      freshness: noteReadFixture(body).freshness,
    });
  });

  test("preserves line slicing over a canonical revision-bound read", async () => {
    const caller = fakeCaller(ok(noteReadFixture(body)));
    const result = await runTool("notient_read_note", caller, {
      path: "a.md",
      startLine: 2,
      endLine: 3,
    });
    expect(caller.calls[0].params).toEqual({ path: "a.md" });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toMatchObject({
      body: "two\nthree",
      startLine: 2,
      endLine: 3,
    });
  });

  test("rejects a range past the end of the note instead of clamping it", async () => {
    const caller = fakeCaller(ok(noteReadFixture(body)));
    const result = await runTool("notient_read_note", caller, {
      path: "a.md",
      endLine: 99,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  test("surfaces a missing-note error as a failure", async () => {
    const caller = fakeCaller({
      ok: false,
      code: "INVALID_PARAMS",
      message: "no such note",
    });
    const result = await runTool("notient_read_note", caller, {
      path: "missing.md",
    });
    expect(result).toEqual({
      ok: false,
      code: "INVALID_PARAMS",
      message: "no such note",
    });
  });

  test("rejects an inverted line range", async () => {
    const result = await runTool("notient_read_note", fakeCaller(ok(noteReadFixture(body))), {
      path: "a.md",
      startLine: 3,
      endLine: 2,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  test.each([{ ok: true }, { ok: true, body: null }, { ok: true, body, extra: "legacy" }])(
    "rejects a malformed successful daemon result %#",
    async (malformed) => {
      const result = await runTool("notient_read_note", fakeCaller(ok(malformed)), {
        path: "a.md",
      });
      expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    },
  );
});

describe("notient_list_notes", () => {
  test("maps folder/filter/limit onto vault.list", async () => {
    const caller = fakeCaller(ok({ ok: true, paths: ["Sub/", "a.md"] }));
    const result = await runTool("notient_list_notes", caller, {
      folder: "Projects",
      filter: "a",
      limit: 10,
    });
    expect(caller.calls[0]).toEqual({
      method: "vault.list",
      params: { folder: "Projects", filter: "a", limit: 10 },
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({
      folder: "Projects",
      paths: ["Sub/", "a.md"],
    });
  });

  test("sends an empty params object at the vault root", async () => {
    const caller = fakeCaller(ok({ ok: true, paths: [] }));
    await runTool("notient_list_notes", caller, {});
    expect(caller.calls[0].params).toEqual({});
  });

  test.each([{ ok: true }, { ok: true, paths: null }, { ok: true, paths: ["a.md", 7] }])(
    "rejects a malformed successful daemon result %#",
    async (malformed) => {
      const result = await runTool("notient_list_notes", fakeCaller(ok(malformed)), {});
      expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    },
  );
});

describe("notient_neighbors and notient_vitals", () => {
  test("neighbors uses canonical revision-checked connections", async () => {
    const payload = graphNeighborsFixture("a.md", [graphConnection("b.md")]);
    const caller = fakeCaller(ok(payload));
    const result = await runTool("notient_neighbors", caller, { path: "a.md" });
    expect(caller.calls[0]).toEqual({
      method: "graph.neighbors",
      params: { path: "a.md", includeProposed: false, limit: 50 },
    });
    expect(result).toMatchObject({ payload });
  });

  test("vitals maps path onto vitals.get and returns the snapshot", async () => {
    const caller = fakeCaller(ok({ ok: true, snapshot: VITALS_SNAPSHOT }));
    const result = await runTool("notient_vitals", caller, { path: "a.md" });
    expect(caller.calls[0]).toEqual({
      method: "vitals.get",
      params: { path: "a.md" },
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({ path: "a.md", snapshot: VITALS_SNAPSHOT });
  });

  test.each([
    { ok: true, notePath: "a.md", neighbors: null },
    { ok: true, notePath: "other.md", neighbors: [] },
    {
      ok: true,
      notePath: "a.md",
      neighbors: [
        {
          notePath: "b.md",
          table: "legacy_relation",
          direction: "outgoing",
          agent: "linker",
          confidence: 0.8,
          proposed: false,
        },
      ],
    },
  ])("neighbors rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_neighbors", fakeCaller(ok(malformed)), {
      path: "a.md",
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test.each([
    { ok: true, snapshot: null },
    { ok: true, snapshot: { ...VITALS_SNAPSHOT, notePath: "other.md" } },
    { ok: true, snapshot: { ...VITALS_SNAPSHOT, health: Number.NaN } },
    { ok: true, snapshot: { ...VITALS_SNAPSHOT, maturity: "seed" } },
  ])("vitals rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_vitals", fakeCaller(ok(malformed)), { path: "a.md" });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("notient_events", () => {
  test("always pins longPollMs to 0 so the tool call cannot park", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        events: [agentEvent(4)],
        cursor: eventId(4),
        longPollExpired: false,
      }),
    );
    const result = await runTool("notient_events", caller, {
      since: eventId(2),
      limit: 50,
    });
    expect(caller.calls[0]).toEqual({
      method: "agent.events",
      params: { since: eventId(2), longPollMs: 0, limit: 50 },
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({
      events: [agentEvent(4)],
      cursor: eventId(4),
    });
  });

  test("rejects an omitted cursor instead of reusing the requested cursor", async () => {
    const caller = fakeCaller(ok({ ok: true, events: [], longPollExpired: false }));
    const result = await runTool("notient_events", caller, {
      since: eventId(7),
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test("preserves the explicit null beginning cursor on an empty first drain", async () => {
    const caller = fakeCaller(ok({ ok: true, events: [], cursor: null, longPollExpired: false }));
    const result = await runTool("notient_events", caller, {});
    if (isFailure(result)) throw new Error("expected success");
    expect(caller.calls[0]?.params).toEqual({ since: null, longPollMs: 0 });
    expect(result.payload).toEqual({ events: [], cursor: null });
  });

  test.each([
    {
      ok: true,
      events: [agentEvent(4)],
      cursor: eventId(3),
      longPollExpired: false,
    },
    {
      ok: true,
      events: [{ ...agentEvent(4), id: "agent_event:legacy" }],
      cursor: eventId(4),
      longPollExpired: false,
    },
    {
      ok: true,
      events: [{ ...agentEvent(4), type: "swarm:unknown" }],
      cursor: eventId(4),
      longPollExpired: false,
    },
    {
      ok: true,
      events: [agentEvent(8), agentEvent(8)],
      cursor: eventId(8),
      longPollExpired: false,
    },
    { ok: true, events: [], cursor: eventId(7), longPollExpired: true },
  ])("rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_events", fakeCaller(ok(malformed)), {
      since: eventId(7),
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("notient_session_list", () => {
  test("calls session.list with no params", async () => {
    const caller = fakeCaller(ok({ ok: true, sessions: [SESSION] }));
    const result = await runTool("notient_session_list", caller, {});
    expect(caller.calls[0]).toEqual({ method: "session.list", params: {} });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.payload).toEqual({ sessions: [SESSION] });
  });

  test.each([
    { ok: true },
    { ok: true, sessions: [{ ...SESSION, sessionId: "agent_session:legacy" }] },
    { ok: true, sessions: [{ ...SESSION, maxWrites: null, usedWrites: -1 }] },
    { ok: true, sessions: [{ ...SESSION, maxWrites: 1, usedWrites: 2 }] },
    { ok: true, sessions: [{ ...SESSION, allowedFolders: ["Notient"] }] },
    {
      ok: true,
      sessions: [{ ...SESSION, allowedTools: ["*", "notes.create"] }],
    },
  ])("rejects a malformed successful daemon result %#", async (malformed) => {
    const result = await runTool("notient_session_list", fakeCaller(ok(malformed)), {});
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("error conversion across the whole catalogue", () => {
  test("every tool folds a daemon error frame into an RpcFailure", async () => {
    const args: Record<string, Record<string, unknown>> = {
      notient_list_jobs: {},
      notient_list_reviews: {},
      notient_get_review: { id: "a".repeat(64) },
      notient_compare_notes: {
        sources: [
          { path: "a.md", revision: CONTENT_SHA },
          { path: "b.md", revision: CONTENT_SHA },
        ],
      },
      notient_correlate_note: {
        source: { path: "a.md", revision: CONTENT_SHA },
        scope: {},
        limit: 6,
      },
      notient_history: {},
      notient_history_entry: { id: HISTORY_ID },
      notient_find_path: { from: "a.md", to: "b.md" },
      notient_get_change_preview: { previewId: "a".repeat(64) },
      notient_host_status: {},
      notient_active_context: {},
      notient_list_pipelines: {},
      notient_run_pipeline: {
        pipeline: "enrich",
        sources: [{ path: "Note.md", revision: "a".repeat(64) }],
        idempotencyKey: "run",
      },
      notient_get_job: { id: "018f05cd-3f7b-7000-8000-000000000001" },
      notient_control_job: {
        id: "018f05cd-3f7b-7000-8000-000000000001",
        action: "pause",
        revision: "a".repeat(64),
        idempotencyKey: "control",
      },
      notient_preview_changes: {
        idempotencyKey: "preview",
        changes: [{ kind: "append", source: { path: "a.md", revision: CONTENT_SHA }, text: "t" }],
      },
      notient_submit_change: {
        previewId: "a".repeat(64),
        previewRevision: "b".repeat(64),
        rationale: "Because the source says so.",
        idempotencyKey: "submit",
      },
      notient_ask: { question: "q" },
      notient_brief: { query: "t", scope: {} },
      notient_search: { query: "q" },
      notient_read_note: { path: "a.md" },
      notient_list_notes: {},
      notient_neighbors: { path: "a.md" },
      notient_vitals: { path: "a.md" },
      notient_events: {},
      notient_session_list: {},
      notient_create_note: { path: "a.md", body: "b" },
      notient_append_note: { path: "a.md", text: "t" },
      notient_replace_section: { path: "a.md", heading: "H", body: "b" },
      notient_update_frontmatter: { path: "a.md", patch: { tags: ["x"] } },
      notient_propose_note: { title: "T", body: "b" },
      notient_propose_link: {
        sourcePath: "a.md",
        targetPath: "b.md",
        relation: "related_to",
      },
    };
    for (const tool of NOTIENT_MCP_TOOLS) {
      const caller = fakeCaller({
        ok: false,
        code: "DAEMON_DISCONNECTED",
        message: "gone",
      });
      const result = await tool.run(caller, args[tool.name]);
      expect(result).toEqual({
        ok: false,
        code: "DAEMON_DISCONNECTED",
        message: "gone",
      });
    }
  });

  test("every tool rejects an empty successful daemon payload as an integrity failure", async () => {
    const args: Record<string, Record<string, unknown>> = {
      notient_list_jobs: {},
      notient_list_reviews: {},
      notient_get_review: { id: "a".repeat(64) },
      notient_compare_notes: {
        sources: [
          { path: "a.md", revision: CONTENT_SHA },
          { path: "b.md", revision: CONTENT_SHA },
        ],
      },
      notient_correlate_note: {
        source: { path: "a.md", revision: CONTENT_SHA },
        scope: {},
        limit: 6,
      },
      notient_history: {},
      notient_history_entry: { id: HISTORY_ID },
      notient_find_path: { from: "a.md", to: "b.md" },
      notient_get_change_preview: { previewId: "a".repeat(64) },
      notient_host_status: {},
      notient_active_context: {},
      notient_list_pipelines: {},
      notient_run_pipeline: {
        pipeline: "enrich",
        sources: [{ path: "Note.md", revision: "a".repeat(64) }],
        idempotencyKey: "run",
      },
      notient_get_job: { id: "018f05cd-3f7b-7000-8000-000000000001" },
      notient_control_job: {
        id: "018f05cd-3f7b-7000-8000-000000000001",
        action: "pause",
        revision: "a".repeat(64),
        idempotencyKey: "control",
      },
      notient_preview_changes: {
        idempotencyKey: "preview",
        changes: [{ kind: "append", source: { path: "a.md", revision: CONTENT_SHA }, text: "t" }],
      },
      notient_submit_change: {
        previewId: "a".repeat(64),
        previewRevision: "b".repeat(64),
        rationale: "Because the source says so.",
        idempotencyKey: "submit",
      },
      notient_ask: { question: "q" },
      notient_brief: { query: "t", scope: {} },
      notient_search: { query: "q" },
      notient_read_note: { path: "a.md" },
      notient_list_notes: {},
      notient_neighbors: { path: "a.md" },
      notient_vitals: { path: "a.md" },
      notient_events: {},
      notient_session_list: {},
      notient_create_note: { path: "a.md", body: "b" },
      notient_append_note: { path: "a.md", text: "t" },
      notient_replace_section: { path: "a.md", heading: "H", body: "b" },
      notient_update_frontmatter: { path: "a.md", patch: { tags: ["x"] } },
      notient_propose_note: { title: "T", body: "b" },
      notient_propose_link: {
        sourcePath: "a.md",
        targetPath: "b.md",
        relation: "related_to",
      },
    };
    for (const tool of NOTIENT_MCP_TOOLS) {
      const result = await tool.run(fakeCaller(ok({})), args[tool.name]);
      expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
      if (!isFailure(result)) continue;
      expect(result.message).toContain("result integrity failure");
    }
  });
});

describe("gated write tools", () => {
  const applied = ok({
    ok: true,
    applied: true,
    path: "Notient/a.md",
    sha: CONTENT_SHA,
    historyId: HISTORY_ID,
  });
  const pending = ok({
    ok: true,
    applied: false,
    pending: true,
    callId: "notes-write-abc-0",
    preview: "create Notient/a.md (+3 lines)",
    path: "Notient/a.md",
  });

  test("notient_create_note maps onto notes.write op create", async () => {
    const caller = fakeCaller(applied);
    await runTool("notient_create_note", caller, {
      path: "Notient/a.md",
      body: "hello",
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.write",
      params: { op: "create", path: "Notient/a.md", body: "hello" },
    });
  });

  test("notient_append_note maps onto notes.write op append", async () => {
    const caller = fakeCaller(applied);
    await runTool("notient_append_note", caller, {
      path: "Notient/a.md",
      text: "more",
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.write",
      params: { op: "append", path: "Notient/a.md", text: "more" },
    });
  });

  test("notient_replace_section maps onto notes.write op replace_section", async () => {
    const caller = fakeCaller(applied);
    await runTool("notient_replace_section", caller, {
      path: "Notient/a.md",
      heading: "Decisions",
      body: "new body",
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.write",
      params: {
        op: "replace_section",
        path: "Notient/a.md",
        heading: "Decisions",
        body: "new body",
      },
    });
  });

  test("notient_update_frontmatter maps onto notes.write op update_frontmatter", async () => {
    const caller = fakeCaller(applied);
    await runTool("notient_update_frontmatter", caller, {
      path: "Notient/a.md",
      patch: { status: "active" },
    });
    expect(caller.calls[0]).toEqual({
      method: "notes.write",
      params: {
        op: "update_frontmatter",
        path: "Notient/a.md",
        patch: { status: "active" },
      },
    });
  });

  test("an applied write renders a one-line Applied summary and the raw result", async () => {
    const caller = fakeCaller(applied);
    const result = await runTool("notient_create_note", caller, {
      path: "Notient/a.md",
      body: "hello",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toBe("Applied: create Notient/a.md");
    expect(result.payload).toMatchObject({
      applied: true,
      sha: CONTENT_SHA,
      historyId: HISTORY_ID,
    });
  });

  test("a pending write names the callId and echoes the preview", async () => {
    const caller = fakeCaller(pending);
    const result = await runTool("notient_append_note", caller, {
      path: "Notient/a.md",
      text: "more",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toBe(
      "Pending note write (callId notes-write-abc-0; note bytes unchanged): append Notient/a.md\ncreate Notient/a.md (+3 lines)",
    );
    expect(result.payload).toMatchObject({ applied: false, pending: true });
  });

  test("a pending preview preserves markdown whitespace verbatim", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        applied: false,
        pending: true,
        callId: "notes-write-abc-2",
        preview: "Create Notient/a.md\n---\nbody\n",
        path: "Notient/a.md",
      }),
    );
    const result = await runTool("notient_create_note", caller, {
      path: "Notient/a.md",
      body: "body\n",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toEndWith("Create Notient/a.md\n---\nbody\n");
  });

  test.each([undefined, null, 7, "", " ", " call-1"])(
    "a pending write rejects malformed callId %p",
    async (callId) => {
      const caller = fakeCaller(
        ok({
          ok: true,
          applied: false,
          pending: true,
          callId,
          preview: "preview",
          path: "Notient/a.md",
        }),
      );
      const result = await runTool("notient_create_note", caller, {
        path: "Notient/a.md",
        body: "hello",
      });
      expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
      if (!isFailure(result)) return;
      expect(result.message).toContain("notes.write result integrity failure");
    },
  );

  test.each([
    {
      ok: true,
      applied: true,
      path: "Notient/a.md",
      sha: "not-a-sha",
      historyId: HISTORY_ID,
    },
    {
      ok: true,
      applied: true,
      path: "Notient/a.md",
      sha: CONTENT_SHA,
      historyId: "history:legacy",
    },
    {
      ok: true,
      applied: true,
      path: "other.md",
      sha: CONTENT_SHA,
      historyId: HISTORY_ID,
    },
    {
      ok: true,
      applied: false,
      pending: false,
      reason: "",
      path: "Notient/a.md",
    },
    {
      ok: true,
      applied: false,
      path: "Notient/a.md",
    },
  ])("rejects a malformed successful write result %#", async (malformed) => {
    const result = await runTool("notient_create_note", fakeCaller(ok(malformed)), {
      path: "Notient/a.md",
      body: "hello",
    });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test("a denied write is neither applied nor pending", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        applied: false,
        pending: false,
        reason: "denied by human",
        path: "Notient/a.md",
      }),
    );
    const result = await runTool("notient_create_note", caller, {
      path: "Notient/a.md",
      body: "x",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toBe("Not applied: create Notient/a.md (denied by human)");
  });

  test("a daemon error frame on a write becomes a failure", async () => {
    const caller = fakeCaller({
      ok: false,
      code: "FORBIDDEN",
      message: "notes.create not in scope",
    });
    const result = await runTool("notient_append_note", caller, {
      path: "a.md",
      text: "t",
    });
    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "notes.create not in scope",
    });
  });

  test.each([
    ["/etc/passwd"],
    ["C:\\Users\\me\\note.md"],
    ["../outside.md"],
    ["Notient/../../outside.md"],
    ["Notient//a.md"],
    ["Notient/./a.md"],
    [""],
  ])("rejects %p client-side without touching the daemon", async (path) => {
    const caller = fakeCaller(applied);
    const result = await runTool("notient_create_note", caller, {
      path,
      body: "x",
    });
    if (!isFailure(result)) throw new Error("expected failure");
    expect(result.code).toBe("INVALID_PARAMS");
    expect(caller.calls).toEqual([]);
  });
});

describe("notient_propose_note", () => {
  test("sends proposal fields to the dedicated server authority", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        applied: true,
        path: "Notient/proposals/2026-03-04-auth-passkeys-not-totp.md",
        sha: CONTENT_SHA,
        historyId: HISTORY_ID,
      }),
    );
    await runTool("notient_propose_note", caller, {
      title: "Auth: passkeys, not TOTP!",
      body: "because recovery",
    });
    expect(caller.calls).toEqual([
      {
        method: "proposals.propose_note",
        params: {
          title: "Auth: passkeys, not TOTP!",
          body: "because recovery",
        },
      },
    ]);
  });

  test("passes an explicit proposal kind without client-authored identity metadata", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        applied: true,
        path: "Notient/proposals/2026-01-01-x.md",
        sha: CONTENT_SHA,
        historyId: HISTORY_ID,
      }),
    );
    await runTool("notient_propose_note", caller, {
      title: "X",
      body: "b",
      kind: "decision",
    });
    expect(caller.calls).toEqual([
      {
        method: "proposals.propose_note",
        params: { title: "X", body: "b", kind: "decision" },
      },
    ]);
  });

  test("slug is lowercased, collapsed, trimmed, and capped at 60 chars", () => {
    expect(proposalSlug("  Hello, World!  ")).toBe("hello-world");
    expect(proposalSlug("###")).toBe("untitled");
    const long = proposalSlug("a".repeat(80));
    expect(long.length).toBe(60);
    expect(proposalSlug(`${"b".repeat(59)} tail`)).toBe("b".repeat(59));
  });

  test("a pending proposal renders the pending summary", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        applied: false,
        pending: true,
        callId: "proposal-note-abc-1",
        preview: "prev",
        path: "Notient/proposals/2026-03-04-x.md",
      }),
    );
    const result = await runTool("notient_propose_note", caller, {
      title: "X",
      body: "b",
    });
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toBe(
      "Pending proposal note (callId proposal-note-abc-1; note bytes unchanged): Notient/proposals/2026-03-04-x.md\nprev",
    );
  });

  test("rejects a proposal receipt for a different generated path", async () => {
    const result = await runTool(
      "notient_propose_note",
      fakeCaller(
        ok({
          ok: true,
          applied: true,
          path: "Notient/proposals/other.md",
          sha: CONTENT_SHA,
          historyId: HISTORY_ID,
        }),
      ),
      { title: "X", body: "b" },
    );
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test("rejects an empty title before calling the daemon", async () => {
    const caller = fakeCaller(ok({ ok: true, applied: true }));
    const result = await runTool("notient_propose_note", caller, {
      title: "",
      body: "b",
    });
    if (!isFailure(result)) throw new Error("expected failure");
    expect(result.code).toBe("INVALID_PARAMS");
    expect(caller.calls).toEqual([]);
  });
});

describe("notient_propose_link", () => {
  const proposalId = "related_to:0123456789abcdefabcd";

  test("maps directly to proposals.propose_link and renders a pending edge receipt", async () => {
    const caller = fakeCaller(
      ok({
        ok: true,
        proposalId,
        sourcePath: "source.md",
        targetPath: "target.md",
        relation: "related_to",
        pending: true,
      }),
    );
    const result = await runTool("notient_propose_link", caller, {
      sourcePath: "source.md",
      targetPath: "target.md",
      relation: "related_to",
    });
    expect(caller.calls).toEqual([
      {
        method: "proposals.propose_link",
        params: {
          sourcePath: "source.md",
          targetPath: "target.md",
          relation: "related_to",
        },
      },
    ]);
    if (isFailure(result)) throw new Error("expected success");
    expect(result.summary).toBe(
      `Typed edge staged (proposalId ${proposalId}; pending human decision): related_to source.md -> target.md`,
    );
    expect(result.payload).toEqual({
      ok: true,
      proposalId,
      sourcePath: "source.md",
      targetPath: "target.md",
      relation: "related_to",
      pending: true,
    });
  });

  test.each([
    { proposalId: "supports:0123456789abcdefabcd" },
    { proposalId: "related_to:legacy" },
    { sourcePath: "other.md" },
    { targetPath: "other.md" },
    { relation: "supports" },
    { pending: false },
    { extra: true },
  ])("rejects a malformed or mismatched daemon receipt %#", async (override) => {
    const result = await runTool(
      "notient_propose_link",
      fakeCaller(
        ok({
          ok: true,
          proposalId,
          sourcePath: "source.md",
          targetPath: "target.md",
          relation: "related_to",
          pending: true,
          ...override,
        }),
      ),
      {
        sourcePath: "source.md",
        targetPath: "target.md",
        relation: "related_to",
      },
    );
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  test("passes a daemon containment error through unchanged", async () => {
    const caller = fakeCaller({
      ok: false,
      code: "INVALID_PARAMS",
      message: "sourcePath must be an exact public vault-relative Markdown note path",
    });
    const result = await runTool("notient_propose_link", caller, {
      sourcePath: ".notient/.env",
      targetPath: "target.md",
      relation: "related_to",
    });
    expect(result).toEqual({
      ok: false,
      code: "INVALID_PARAMS",
      message: "sourcePath must be an exact public vault-relative Markdown note path",
    });
    expect(caller.calls).toHaveLength(1);
  });
});

describe("durable job inspection", () => {
  test("returns the stored failure and rejects a different job identity", async () => {
    const job = pipelineJobFixture();
    const caller = fakeCaller(ok({ ok: true, job }));
    const result = await runTool("notient_get_job", caller, { id: job.id });
    if (isFailure(result)) throw new Error("expected a persisted job");
    expect(result.summary).toContain("INFERENCE_UNAVAILABLE");
    expect(result.payload).toEqual({ ok: true, job });
    const mismatch = await runTool("notient_get_job", caller, {
      id: "018f05cd-3f7b-7000-8000-000000000099",
    });
    expect(mismatch).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});
