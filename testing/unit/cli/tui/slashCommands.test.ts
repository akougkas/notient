import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCoverage } from "../../../../src/api/indexing";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import {
  buildHelpTable,
  dispatchSlashCommand,
  isSlashCommand,
  parseSlashCommand,
  renderNoteBody,
} from "../../../../src/cli/tui/slashCommands";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";
import { graphConnection, graphNeighborsFixture, graphPathFixture } from "../../../graphFixture";
import {
  historyDetailFixture,
  historyEntryFixture,
  historyListFixture,
  historyUndoFixture,
} from "../../../historyFixture";
import { currentCoverageFixture, currentIndexingFixture } from "../../../indexingFixture";
import { noteReadFixture } from "../../../noteReadFixture";

const HISTORY_ID = createUuidRecordId("history", "018f05cd-3f7b-7000-8000-000000000001").toString();

function searchResult(
  query: string,
  hits: Array<{ notePath: string; score: number }>,
): Record<string, unknown> {
  return {
    query,
    mode: "balanced",
    durationMs: 1,
    coverage: currentCoverageFixture(),
    hits: hits.map((hit, index) => ({
      ...hit,
      chunkId: `chunk:a${(index + 1).toString(36).padStart(19, "0")}`,
      snippet: `match in ${hit.notePath}`,
      matchedText: query,
    })),
  };
}

function daemonStatus(): Record<string, unknown> {
  return {
    vault: "/tmp/vault",
    indexing: currentIndexingFixture(),
    httpEndpoint: "http://127.0.0.1:12345",
    vaultId: "0123456789abcdef",
    pid: 1234,
    socketPath: "/tmp/notient.sock",
    startedAt: Date.UTC(2026, 0, 2),
    version: "0.1.0",
    sealed: true,
    visionReady: false,
    probe: {
      endpoint: "http://127.0.0.1:8080/v1",
      configuredModel: "notient-chat",
      loadedModel: "notient-chat",
      configuredContextTokens: 32_768,
      parallelSlots: 4,
      requestedTotalContextTokens: 131_072,
      loadedContextLength: 131_072,
      status: "ok",
      message: "configured model is loaded",
    },
  };
}

function vitalsSnapshot(notePath: string): Record<string, unknown> {
  return {
    notePath,
    freshness: 0.8,
    health: 0.75,
    connectivityCount: 4,
    connectivityTier: "connected",
    maturity: "mature",
    wordCount: 640,
    computedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  };
}

const idleSwarm = ["linker", "synthesizer", "contradictionHunter", "maturityAdvancer"].map(
  (agent) => ({ agent, state: "idle", proposals: 0, finishedAt: null }),
);

describe("isSlashCommand", () => {
  test("matches lines beginning with /", () => {
    expect(isSlashCommand("/quit")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand(" /quit")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("splits verb and rest", () => {
    expect(parseSlashCommand("/search foo bar")).toEqual({
      verb: "search",
      rest: "foo bar",
    });
    expect(parseSlashCommand("/quit")).toEqual({ verb: "quit", rest: "" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/help   ")).toEqual({ verb: "help", rest: "" });
  });
});

describe("buildHelpTable", () => {
  test("renders a top border, rows, and bottom border", () => {
    const table = buildHelpTable();
    const lines = table.split("\n");
    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines.at(-1)?.startsWith("└")).toBe(true);
    expect(lines.length).toBeGreaterThan(5);
  });

  test("aligns the verb column so every row has identical width", () => {
    const lines = buildHelpTable().split("\n");
    const widths = new Set(lines.filter((l) => l.startsWith("│")).map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  test("includes the /quit verb with its description", () => {
    const table = buildHelpTable();
    expect(table).toContain("/quit");
    expect(table).toContain("exit the TUI");
  });

  test("documents exact-row undo", () => {
    expect(buildHelpTable()).toContain("/undo [historyId]");
  });
});

interface CapturedCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeClient extends ClientHandle {
  calls: CapturedCall[];
}

interface FakeSpec {
  method: string;
  result: Record<string, unknown>;
}

function makeFakeClient(specs: FakeSpec[]): FakeClient {
  const calls: CapturedCall[] = [];
  const handle: FakeClient = {
    calls,
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params): AsyncIterable<RpcResponseFrame> {
      calls.push({ method, params });
      const spec = specs.find((entry) => entry.method === method);
      return (async function* () {
        if (!spec) {
          yield {
            id: "fake",
            type: "error",
            message: `no fake for ${method}`,
          } as RpcResponseFrame;
          return;
        }
        const terminal =
          spec.result.type === "error"
            ? { detail: {}, ...spec.result }
            : { ok: true, ...spec.result };
        yield {
          id: "fake",
          type: "result",
          ...terminal,
        } as RpcResponseFrame;
      })();
    },
    close: async () => {},
  };
  return handle;
}

describe("dispatchSlashCommand", () => {
  test("/approve <callId> calls chat.approve with approved:true and no reason", async () => {
    const client = makeFakeClient([
      {
        method: "chat.approve",
        result: { ok: true, callId: "abc123", approved: true },
      },
    ]);
    const outcome = await dispatchSlashCommand("/approve abc123", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe("chat.approve");
    expect(client.calls[0]?.params).toEqual({ callId: "abc123", approved: true });
    expect(outcome.message).toBe("approved abc123");
    expect(outcome.pendingTransition).toEqual({ id: "abc123", state: "resolved" });
  });

  test("/approve refuses a reason that has no durable consumer", async () => {
    const client = makeFakeClient([{ method: "chat.approve", result: { ok: true } }]);
    const outcome = await dispatchSlashCommand("/approve abc123 please", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls).toHaveLength(0);
    expect(outcome.message).toBe("/approve accepts only <callId>");
  });

  test("/deny <callId> calls chat.approve with approved:false", async () => {
    const client = makeFakeClient([
      {
        method: "chat.approve",
        result: { ok: true, callId: "abc123", approved: false, reason: "rejected by user" },
      },
    ]);
    const outcome = await dispatchSlashCommand("/deny abc123", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("chat.approve");
    expect(client.calls[0]?.params).toEqual({ callId: "abc123", approved: false });
    expect(outcome.pendingTransition).toEqual({ id: "abc123", state: "resolved" });
    expect(outcome.message).toBe("denied abc123: rejected by user");
  });

  test("/deny forwards and surfaces its durable rejection reason", async () => {
    const client = makeFakeClient([
      {
        method: "chat.approve",
        result: { ok: true, callId: "abc123", approved: false, reason: "wrong vault" },
      },
    ]);
    const outcome = await dispatchSlashCommand("/deny abc123 wrong vault", {
      client,
      vaultPath: "/tmp/vault",
    });

    expect(client.calls[0]?.params).toEqual({
      callId: "abc123",
      approved: false,
      reason: "wrong vault",
    });
    expect(outcome.message).toBe("denied abc123: wrong vault");
  });

  test("/approve surfaces unknown call id errors from chat.approve", async () => {
    const client = makeFakeClient([
      {
        method: "chat.approve",
        result: { type: "error", code: "INVALID_PARAMS", message: "unknown call id" },
      },
    ]);
    const outcome = await dispatchSlashCommand("/approve missing", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("approve error: INVALID_PARAMS: unknown call id");
    expect(outcome.pendingTransition).toEqual({ id: "missing", state: "uncertain" });
  });

  test("/proposals renders pending edge rows and returns visible items", async () => {
    const item = {
      id: "related_to:aaaaaaaaaaaaaaaaaaaa",
      table: "related_to",
      source: "a.md",
      target: "b.md",
      agent: "linker",
      confidence: 0.85,
    };
    const outcome = await dispatchSlashCommand("/proposals", {
      client: makeFakeClient([]),
      vaultPath: "/tmp/vault",
      proposals: {
        list: async () => [item],
        approve: async () => ({ message: "unused", state: "uncertain" }),
        reject: async () => ({ message: "unused", state: "uncertain" }),
      },
    });
    expect(outcome.message).toContain("proposals page 1/1");
    expect(outcome.message).toContain("related_to:aaaaaaaaaaaaaaaaaaaa related_to a.md -> b.md");
    expect(outcome.message).toContain("actions: /approve-edge <id>, /reject-edge <id> [reason]");
    expect(outcome.message).not.toContain("keys: a approve");
    expect(outcome.proposalItems).toEqual([item]);
  });

  test("rejects the removed /exit alias", async () => {
    const outcome = await dispatchSlashCommand("/exit", {
      client: makeFakeClient([]),
      vaultPath: "/tmp/vault",
    });
    expect(outcome).toEqual({ message: "unknown command: /exit (try /help)" });
  });

  test("/approve-edge and /reject-edge use the proposal actions", async () => {
    const calls: string[] = [];
    const proposals = {
      list: async () => [],
      approve: async (id: string) => {
        calls.push(`approve:${id}`);
        return { message: `edge approved ${id}`, state: "resolved" as const };
      },
      reject: async (id: string, reason?: string) => {
        calls.push(`reject:${id}:${reason ?? ""}`);
        return { message: `edge rejected ${id}`, state: "resolved" as const };
      },
    };
    const approve = await dispatchSlashCommand("/approve-edge related_to:abc", {
      client: makeFakeClient([]),
      vaultPath: "/tmp/vault",
      proposals,
    });
    const reject = await dispatchSlashCommand("/reject-edge related_to:def weak", {
      client: makeFakeClient([]),
      vaultPath: "/tmp/vault",
      proposals,
    });

    expect(approve.message).toBe("edge approved related_to:abc");
    expect(approve.pendingTransition).toEqual({ id: "related_to:abc", state: "resolved" });
    expect(reject.message).toBe("edge rejected related_to:def");
    expect(reject.pendingTransition).toEqual({ id: "related_to:def", state: "resolved" });
    expect(calls).toEqual(["approve:related_to:abc", "reject:related_to:def:weak"]);
  });

  test("/undo selects the latest reversible entry and submits its exact revision", async () => {
    const entry = historyEntryFixture({ kind: "notes.create", target: "x.md" });
    const detail = historyDetailFixture(entry);
    const client = makeFakeClient([
      { method: "history.list", result: historyListFixture([entry]) },
      { method: "history.get", result: detail },
      { method: "history.undo", result: historyUndoFixture(entry) },
    ]);
    const outcome = await dispatchSlashCommand("/undo", { client, vaultPath: "/tmp/vault" });
    expect(client.calls.at(-1)).toEqual({
      method: "history.undo",
      params: { id: HISTORY_ID, sources: detail.sources, idempotencyKey: `undo:${HISTORY_ID}` },
    });
    expect(outcome.message).toContain("Restored: x.md");
  });
  test("/undo preserves a source conflict and does not retry", async () => {
    const client = makeFakeClient([
      { method: "history.get", result: historyDetailFixture() },
      {
        method: "history.undo",
        result: { type: "error", code: "CONFLICT", message: "note changed" },
      },
    ]);
    const outcome = await dispatchSlashCommand(`/undo ${HISTORY_ID}`, {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("undo error: CONFLICT: note changed");
    expect(client.calls.filter((call) => call.method === "history.undo")).toHaveLength(1);
  });

  test("/history prints one line per entry", async () => {
    const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const client = makeFakeClient([
      {
        method: "history.list",
        result: historyListFixture([
          historyEntryFixture({ kind: "notes.create", target: "alpha.md", createdAt }),
        ]),
      },
    ]);
    const outcome = await dispatchSlashCommand("/history", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("history.list");
    expect(client.calls[0]?.params).toEqual({ limit: 10 });
    expect(outcome.message).toBe(
      `${HISTORY_ID}  notes.create  alpha.md  ${new Date(createdAt).toISOString()}`,
    );
  });

  test("/history reports empty list", async () => {
    const client = makeFakeClient([{ method: "history.list", result: historyListFixture([]) }]);
    const outcome = await dispatchSlashCommand("/history", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("history: (empty)");
  });

  test("/history exposes an incomplete persisted row as an integrity error", async () => {
    const row: Record<string, unknown> = historyEntryFixture({
      kind: "notes.create",
      target: "alpha.md",
    });
    row.clientIdentity = undefined;
    const client = makeFakeClient([
      { method: "history.list", result: { ...historyListFixture(), entries: [row] } },
    ]);
    const outcome = await dispatchSlashCommand("/history", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("history error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("entries.0.clientIdentity");
  });

  test("/read <path> renders body in fenced markdown block", async () => {
    const client = makeFakeClient([
      { method: "notes.read", result: noteReadFixture("hello world") },
    ]);
    const outcome = await dispatchSlashCommand("/read inbox/foo.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("notes.read");
    expect(client.calls[0]?.params).toEqual({ path: "inbox/foo.md" });
    expect(outcome.message).toBe("```md\nhello world\n```");
  });

  test("/read surfaces a malformed success frame instead of rendering an empty note", async () => {
    const client = makeFakeClient([{ method: "notes.read", result: {} }]);
    const outcome = await dispatchSlashCommand("/read inbox/foo.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("read error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("notes.read wire integrity error at body");
    expect(outcome.message).not.toBe("```md\n\n```");
  });

  test("/search renders hits with their notePath (not undefined)", async () => {
    const client = makeFakeClient([
      {
        method: "search.run",
        result: {
          result: searchResult("topic", [
            { notePath: "alpha/note.md", score: 0.81 },
            { notePath: "beta.md", score: 0.66 },
          ]),
        },
      },
    ]);
    const outcome = await dispatchSlashCommand("/search topic", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.method).toBe("search.run");
    expect(outcome.message).toBe("alpha/note.md (0.81)\nbeta.md (0.66)");
    expect(outcome.message).not.toContain("undefined");
  });

  test("/search reports no hits when the result is empty", async () => {
    const client = makeFakeClient([
      { method: "search.run", result: { result: searchResult("nothing", []) } },
    ]);
    const outcome = await dispatchSlashCommand("/search nothing", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toBe("no hits.");
  });

  test("/search distinguishes incomplete indexing from a current empty search", async () => {
    const indexing = currentIndexingFixture({
      state: "indexing",
      total: 2,
      current: 1,
      pending: 1,
    });
    const result = { ...searchResult("nothing", []), coverage: searchCoverage(indexing, indexing) };
    const client = makeFakeClient([{ method: "search.run", result: { result } }]);
    const outcome = await dispatchSlashCommand("/search nothing", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("No hits yet.");
    expect(outcome.message).toContain("1/2 notes current");
    expect(outcome.message).toContain("Results may omit matching notes");
  });

  test("/search surfaces malformed hits instead of coercing them to no hits", async () => {
    const malformed = searchResult("topic", [{ notePath: "alpha.md", score: 0.8 }]);
    const hits = malformed.hits as Array<Record<string, unknown>>;
    hits[0].score = null;
    const client = makeFakeClient([{ method: "search.run", result: { result: malformed } }]);
    const outcome = await dispatchSlashCommand("/search topic", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("search error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("result.hits.0.score");
    expect(outcome.message).not.toBe("no hits.");
  });

  test("/awaken uses the canonical request and exact foreground result", async () => {
    const client = makeFakeClient([
      {
        method: "awaken.run",
        result: {
          queued: 2,
          tier: [1, 2, 3],
          runId: 'awaken_run:u"018f05cd-3f7b-7000-8000-000000000002"',
          status: "completed",
          processed: 2,
          failed: 0,
        },
      },
    ]);
    const outcome = await dispatchSlashCommand("/awaken", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(client.calls[0]?.params).toEqual({});
    expect(outcome.message).toContain("awaken indexing started (runId: awaken_run:");
  });

  test("/vitals renders only canonical snapshot fields", async () => {
    const client = makeFakeClient([
      { method: "vitals.get", result: { snapshot: vitalsSnapshot("alpha.md") } },
    ]);
    const outcome = await dispatchSlashCommand("/vitals alpha.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("- wordCount:       640");
    expect(outcome.message).toContain("- approvedEdges:   4");
    expect(outcome.message).toContain("- maturity:        mature");
    expect(outcome.message).not.toContain("chunkCount");
    expect(outcome.message).not.toContain("?");
  });

  test("/vitals reports null numeric fields as wire corruption", async () => {
    const snapshot = vitalsSnapshot("alpha.md");
    snapshot.health = null;
    const client = makeFakeClient([{ method: "vitals.get", result: { snapshot } }]);
    const outcome = await dispatchSlashCommand("/vitals alpha.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("vitals error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("snapshot.health");
  });

  test("/pulse refuses a malformed neighbor result instead of reporting zero connectivity", async () => {
    const client = makeFakeClient([
      { method: "vitals.get", result: { snapshot: vitalsSnapshot("alpha.md") } },
      {
        method: "graph.neighbors",
        result: { ...graphNeighborsFixture("alpha.md"), connections: null },
      },
    ]);
    const outcome = await dispatchSlashCommand("/pulse alpha.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("pulse error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("graph.neighbors wire integrity error at connections");
    expect(outcome.message).not.toContain("(0 approved neighbors)");
  });

  test("/health refuses to fabricate daemon fields from a partial status", async () => {
    const status = daemonStatus();
    status.version = undefined;
    const client = makeFakeClient([
      { method: "health.probe", result: { endpoints: [] } },
      { method: "daemon.status", result: status },
    ]);
    const outcome = await dispatchSlashCommand("/health", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("health error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("daemon.status wire integrity error at version");
    expect(outcome.message).not.toContain("(?)");
  });

  test("/sentient renders explicit no-active-note state and the complete swarm", async () => {
    const client = makeFakeClient([
      { method: "health.probe", result: { endpoints: [{ label: "chat", ok: true }] } },
      { method: "daemon.status", result: daemonStatus() },
      {
        method: "vault.active_note",
        result: { notePath: null, neighbors: [], swarm: idleSwarm },
      },
    ]);
    const outcome = await dispatchSlashCommand("/sentient", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("active note: (none edited yet)");
    expect(outcome.message).toContain("contradictionHunter  idle (0 proposals)");
    expect(outcome.message).not.toContain("unavailable");
  });

  test("/model renders the daemon's complete resolved deployment snapshot", async () => {
    const settings = resolveSettings(DEFAULT_NOTIENT_CONFIG, {
      NOTIENT_LLM_BASE_URL: "http://127.0.0.1:8080/v1",
      NOTIENT_LLM_MODEL: "notient-chat",
      NOTIENT_EMBED_MODEL: "notient-embed",
      NOTIENT_CONTEXT_TOKENS: "65536",
      NOTIENT_REASONING_SLOTS: "2",
    });
    const client = makeFakeClient([{ method: "daemon.config_get", result: { config: settings } }]);
    const outcome = await dispatchSlashCommand("/model", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("model:    notient-chat");
    expect(outcome.message).toContain("embed:    notient-embed");
    expect(outcome.message).toContain("context:  65,536 tok");
    expect(outcome.message).toContain("slots:    2 (131,072 tok total)");
  });

  test("/model rejects a partial daemon config instead of inventing deployment values", async () => {
    const settings = resolveSettings(DEFAULT_NOTIENT_CONFIG, {
      NOTIENT_LLM_BASE_URL: "http://127.0.0.1:8080/v1",
      NOTIENT_LLM_MODEL: "notient-chat",
      NOTIENT_EMBED_MODEL: "notient-embed",
    }) as unknown as Record<string, unknown>;
    settings.primary = undefined;
    const client = makeFakeClient([{ method: "daemon.config_get", result: { config: settings } }]);
    const outcome = await dispatchSlashCommand("/model", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("/model error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("daemon.config_get wire integrity error at config.primary");
  });

  test("/model list uses the daemon's authenticated catalog boundary", async () => {
    const client = makeFakeClient([
      {
        method: "daemon.model_catalog",
        result: {
          source: "openai-compatible",
          models: ["notient-chat", "notient-embed"].map((id) => ({
            id,
            type: "unknown",
            state: "unknown",
            loadedContextLength: null,
          })),
        },
      },
    ]);
    const outcome = await dispatchSlashCommand("/model list", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message).toContain("notient-chat");
    expect(outcome.message).toContain("notient-embed");
    expect(outcome.message).toContain("unknown");
    expect(outcome.message).not.toContain("catalog failure");
  });

  test("/read truncates a 6000-char body with elision marker", async () => {
    const body = "a".repeat(6000);
    const client = makeFakeClient([{ method: "notes.read", result: noteReadFixture(body) }]);
    const outcome = await dispatchSlashCommand("/read big.md", {
      client,
      vaultPath: "/tmp/vault",
    });
    expect(outcome.message.startsWith("```md\n")).toBe(true);
    expect(outcome.message.endsWith("\n```")).toBe(true);
    expect(outcome.message).toContain("[…1000 characters elided…]");
    // head ~= 3500 chars, tail ~= 1500 chars; total elision = 1000
    const stripped = outcome.message.slice("```md\n".length, -"\n```".length);
    const [head, tail] = stripped.split(/\n\[…\d+ characters elided…\]\n/);
    expect(head?.length).toBe(3500);
    expect(tail?.length).toBe(1500);
  });
});

describe("/copy verb", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notient-copy-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a friendly hint when no notes reply is available yet", async () => {
    const client = makeFakeClient([]);
    const outcome = await dispatchSlashCommand("/copy", {
      client,
      vaultPath: dir,
      getLastAssistant: () => null,
    });
    expect(outcome.message).toBe("/copy: no reply from your notes yet to copy.");
    expect(existsSync(join(dir, ".notient", "last.txt"))).toBe(false);
  });

  test("reports the same hint when the last notes reply is empty", async () => {
    const client = makeFakeClient([]);
    const outcome = await dispatchSlashCommand("/copy", {
      client,
      vaultPath: dir,
      getLastAssistant: () => "",
    });
    expect(outcome.message).toBe("/copy: no reply from your notes yet to copy.");
  });

  test("writes the last notes reply to <vault>/.notient/last.txt", async () => {
    const client = makeFakeClient([]);
    const reply = "Sure, here is the answer to your question.";
    const outcome = await dispatchSlashCommand("/copy", {
      client,
      vaultPath: dir,
      getLastAssistant: () => reply,
    });
    const target = join(dir, ".notient", "last.txt");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(reply);
    expect(outcome.message).toContain(`Copied ${reply.length} chars`);
    expect(outcome.message).toContain(target);
  });

  test("creates .notient/ when it does not yet exist", async () => {
    const client = makeFakeClient([]);
    expect(existsSync(join(dir, ".notient"))).toBe(false);
    await dispatchSlashCommand("/copy", {
      client,
      vaultPath: dir,
      getLastAssistant: () => "hi",
    });
    expect(existsSync(join(dir, ".notient", "last.txt"))).toBe(true);
  });
});

describe("renderNoteBody frontmatter handling", () => {
  test("preserves yaml frontmatter intact when body exceeds the limit", () => {
    const frontmatter = "---\ntitle: example\ntags: [a, b, c]\nstatus: draft\n---\n";
    const body = `${frontmatter}${"x".repeat(8000)}`;
    const rendered = renderNoteBody("/example.md", body);
    expect(rendered.startsWith("```md\n")).toBe(true);
    expect(rendered).toContain(frontmatter);
    // Truncation marker fires for the body portion past the limit.
    expect(rendered).toMatch(/\[…\d+ characters elided…\]/);
    // Frontmatter is NOT split: no `[...elided...]` marker before the closing ---.
    const beforeFrontmatterClose = rendered.slice(0, rendered.indexOf("\n---\n") + 5);
    expect(beforeFrontmatterClose).not.toContain("characters elided");
  });

  test("falls through to plain truncation when body has no frontmatter", () => {
    const body = "x".repeat(6000);
    const rendered = renderNoteBody("/no-fm.md", body);
    expect(rendered.startsWith("```md\n")).toBe(true);
    expect(rendered).toContain("[…1000 characters elided…]");
    // No frontmatter signal in the output.
    expect(rendered.startsWith("```md\n---")).toBe(false);
  });

  test("returns the body verbatim when under the limit", () => {
    const frontmatter = "---\ntitle: short\n---\n";
    const body = `${frontmatter}tiny body`;
    const rendered = renderNoteBody("/short.md", body);
    expect(rendered).toBe(`\`\`\`md\n${body}\n\`\`\``);
  });

  test("falls through to plain truncation when frontmatter is missing the closing fence", () => {
    const body = `---\ntitle: never-closed\n${"y".repeat(8000)}`;
    const rendered = renderNoteBody("/broken.md", body);
    expect(rendered).toContain("[…");
    expect(rendered).toContain("characters elided");
  });
});

describe("/graph slash command", () => {
  test("quoted paths preserve spaces and literal shell syntax without expansion", async () => {
    const from = "Notes/Alice's $(draft).md";
    const to = "Ideas/Next steps.md";
    const client = makeFakeClient([{ method: "graph.path", result: graphPathFixture([from, to]) }]);
    const outcome = await dispatchSlashCommand(`/graph "${from}" '${to}'`, {
      client,
      vaultPath: "/tmp",
    });
    expect(client.calls[0]?.params).toEqual({ from, to });
    expect(outcome.message).toContain(`${from} → ${to}`);
  });
  test("an unfinished quote reports how to enter paths and sends no request", async () => {
    const client = makeFakeClient([]);
    const outcome = await dispatchSlashCommand('/graph "Unfinished path.md', {
      client,
      vaultPath: "/tmp",
    });
    expect(outcome.message).toContain("Quote each path completely");
    expect(client.calls).toHaveLength(0);
  });
  test("dispatches canonical neighbors when only source is provided", async () => {
    const client = makeFakeClient([
      {
        method: "graph.neighbors",
        result: graphNeighborsFixture("a.md", [graphConnection("b.md")]),
      },
    ]);
    const outcome = await dispatchSlashCommand("/graph a.md", { client, vaultPath: "/tmp" });
    expect(client.calls[0]?.method).toBe("graph.neighbors");
    expect(client.calls[0]?.params).toEqual({ path: "a.md", includeProposed: false });
    expect(outcome.message).toContain("b.md");
  });
  test("dispatches canonical path with revision-bound steps", async () => {
    const client = makeFakeClient([{ method: "graph.path", result: graphPathFixture() }]);
    const outcome = await dispatchSlashCommand("/graph a.md c.md", { client, vaultPath: "/tmp" });
    expect(client.calls[0]?.params).toEqual({ from: "a.md", to: "c.md" });
    expect(outcome.message).toContain("a.md → b.md → c.md");
  });
  test("rejects extra path arguments instead of silently ignoring them", async () => {
    const client = makeFakeClient([]);
    const outcome = await dispatchSlashCommand("/graph a.md b.md c.md", {
      client,
      vaultPath: "/tmp",
    });
    expect(outcome.message).toBe("/graph accepts only <fromPath> [toPath]");
    expect(client.calls).toHaveLength(0);
  });

  test("surfaces incomplete neighbor rows instead of rendering plausible graph state", async () => {
    const client = makeFakeClient([
      {
        method: "graph.neighbors",
        result: {
          ...graphNeighborsFixture("a.md"),
          connections: [{ ...graphConnection(), assessment: 2 }],
        },
      },
    ]);
    const outcome = await dispatchSlashCommand("/graph a.md", { client, vaultPath: "/tmp" });
    expect(outcome.message).toContain("graph error: WIRE_INTEGRITY");
    expect(outcome.message).toContain("connections.0.assessment");
  });
});
