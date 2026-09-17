import { describe, expect, test } from "bun:test";
import type { ClientHandle } from "../../../../src/cli/client";
import { deriveTuiLayout } from "../../../../src/cli/tui/layout";
import {
  AppFrame,
  ChatStreamIntegrityError,
  approvalDecisionNotice,
  drainTurn,
  frameToErrorLine,
  handleStreamEvent,
  loadActiveView,
  refreshPendingState,
  refreshPendingTransitionOnce,
  resetInboxScroll,
  revealInboxSelection,
  runPendingDecisionTransition,
  runSingleFlight,
  runSlashCommand,
  runTrailingFlight,
  scrollBy,
} from "../../../../src/cli/tui/runtime";
import { type Action, initialState, reducer } from "../../../../src/cli/tui/store";
import { COLOR } from "../../../../src/cli/tui/views/theme";
import type { ProposalWire } from "../../../../src/daemon/wire";
import { conversationFixture } from "../../../conversationFixture";

describe("frameToErrorLine", () => {
  test("extracts message from rpc error frame", () => {
    const line = frameToErrorLine({
      type: "error",
      message: "stream closed",
    } as { type: "error"; message: string });
    expect(line).toEqual({ kind: "error", text: "rpc error: stream closed" });
  });

  test("rejects an absent or blank message instead of fabricating an error", () => {
    expect(() => frameToErrorLine({ type: "error" })).toThrow(ChatStreamIntegrityError);
    expect(() => frameToErrorLine({ type: "error", message: "" })).toThrow(
      /canonical nonblank string/,
    );
  });
});

interface TestStreamFrame {
  type: string;
  [key: string]: unknown;
}

function streamEvent(event: string, payload: Record<string, unknown>): TestStreamFrame {
  return { id: "req-1", type: "event", event, ...payload };
}

function actionCollector(): {
  actions: Action[];
  dispatch: (action: Action) => void;
} {
  const actions: Action[] = [];
  return { actions, dispatch: (action) => actions.push(action) };
}

describe("chat stream event integrity", () => {
  test("decodes rendered assistant, tool, and approval events without coercion", () => {
    const collector = actionCollector();
    expect(
      handleStreamEvent(
        streamEvent("loop:assistant_delta", { contentDelta: "The notes remember." }),
        collector.dispatch,
      ),
    ).toBe("The notes remember.");
    handleStreamEvent(
      streamEvent("loop:tool_call_started", {
        callId: "call-123456789",
        tool: "vault.search_notes",
        args: { query: "sentience" },
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:tool_call_result", {
        callId: "call-123456789",
        result: { hits: [] },
        durationMs: 12,
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:tool_call_result", {
        callId: "call-no-result",
        durationMs: 0,
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:tool_call_error", {
        callId: "call-error",
        error: "index unavailable",
        durationMs: 3,
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:approval_pending", {
        callId: "call-write",
        tool: "notes.write",
        args: { path: "Notes/A.md" },
        preview: "+ awakened text",
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:approval_resolved", { callId: "call-write", approved: true }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:approval_resolved", {
        callId: "call-denied",
        approved: false,
        reason: "operator denied",
      }),
      collector.dispatch,
    );

    expect(collector.actions).toEqual([
      { type: "ask/assistantDelta", text: "The notes remember." },
      { type: "ask/line", line: { kind: "tool", text: "vault.search_notes" } },
      { type: "ask/line", line: { kind: "tool", text: "done call-123" } },
      { type: "ask/line", line: { kind: "tool", text: "done call-no-" } },
      { type: "ask/line", line: { kind: "error", text: "tool error: index unavailable" } },
      { type: "ask/approvalPending", callId: "call-write", tool: "notes.write" },
      {
        type: "ask/line",
        line: {
          kind: "approval",
          text: "pending: notes.write (callId=call-write)",
          callId: "call-write",
        },
      },
      { type: "ask/approvalResolved", callId: "call-write" },
      { type: "ask/approvalResolved", callId: "call-denied" },
    ]);
  });

  test("decodes coherent context and tool-mode events before updating model state", () => {
    const collector = actionCollector();
    handleStreamEvent(
      streamEvent("loop:context_summarized", {
        conversationId: "conversation-1",
        model: "ornith1.5-35b-moe",
        originalTokens: 12_000,
        summarizedTokens: 4_000,
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:context_overflow_warning", {
        conversationId: "conversation-1",
        model: "ornith1.5-35b-moe",
        configuredTokens: 131_072,
        estimatedTokens: 140_000,
      }),
      collector.dispatch,
    );
    handleStreamEvent(
      streamEvent("loop:tool_mode_probed", {
        model: "ornith1.5-35b-moe",
        mode: "native",
        attempts: 2,
      }),
      collector.dispatch,
    );

    expect(collector.actions).toEqual([
      { type: "ask/model", model: "ornith1.5-35b-moe" },
      {
        type: "ask/line",
        line: { kind: "system", text: "context summarized (12000 → 4000 tokens)" },
      },
      { type: "ask/model", model: "ornith1.5-35b-moe" },
      {
        type: "ask/line",
        line: {
          kind: "system",
          text: "warning: configured modelContextTokens=131072 but turn estimates 140000 tokens.",
        },
      },
      { type: "ask/model", model: "ornith1.5-35b-moe" },
      {
        type: "ask/line",
        line: {
          kind: "system",
          text: "tool-mode for ornith1.5-35b-moe: native (attempts=2)",
        },
      },
    ]);
  });

  test("preserves legitimate non-rendered stream variants", () => {
    const collector = actionCollector();
    const variants = [
      streamEvent("turn:start", {
        conversationId: "conversation-1",
        userMessage: { id: "message-1", role: "user", content: "hi", createdAt: 1 },
      }),
      streamEvent("turn:complete", { conversation: conversationFixture() }),
      streamEvent("turn:aborted", { reason: "operator cancelled" }),
      streamEvent("loop:reasoning_delta", { reasoningDelta: "considering" }),
    ];
    for (const variant of variants) {
      expect(handleStreamEvent(variant, collector.dispatch)).toBe("");
    }
    expect(collector.actions).toEqual([{ type: "ask/sources", sources: [] }]);
  });

  test("renders the authoritative final answer exactly once, including non-streamed outcomes", async () => {
    for (const streamed of [false, true]) {
      let state = initialState("/vault");
      async function* frames(): AsyncGenerator<TestStreamFrame> {
        if (streamed) yield streamEvent("loop:assistant_delta", { contentDelta: "Partial answer" });
        yield streamEvent("loop:done", {
          finalMessage: {
            id: "final",
            role: "assistant",
            content: "Final answer [[Storage]]",
            reasoningContent: "private reasoning",
            createdAt: 1,
          },
          truncated: false,
        });
        yield { id: "req-1", type: "result", ok: true };
      }
      const answer = await drainTurn(
        frames(),
        (action) => {
          state = reducer(state, action);
        },
        () => {},
        async () => {},
      );
      expect(answer).toBe("Final answer [[Storage]]");
      expect(state.ask.lines).toEqual([{ kind: "assistant", text: "Final answer [[Storage]]" }]);
    }
  });

  test("shows round exhaustion after tools and exposes provider failures", () => {
    let state = initialState("/vault");
    const dispatch = (action: Action) => {
      state = reducer(state, action);
    };
    dispatch({ type: "ask/line", line: { kind: "tool", text: "vault.read_note" } });
    handleStreamEvent(
      streamEvent("loop:done", {
        finalMessage: {
          id: "final",
          role: "assistant",
          content: "I've used all available tool rounds.",
          createdAt: 1,
        },
        truncated: true,
      }),
      dispatch,
    );
    expect(state.ask.lines[1]).toEqual({
      kind: "assistant",
      text: "I've used all available tool rounds.",
    });
    expect(state.ask.lines[2]).toMatchObject({
      kind: "error",
      text: expect.stringContaining("tool-round limit"),
    });
    handleStreamEvent(
      streamEvent("loop:error", { message: "provider refused the turn" }),
      dispatch,
    );
    expect(state.ask.lines.at(-1)).toEqual({ kind: "error", text: "provider refused the turn" });
  });

  test("rejects malformed values, incoherent counters, aliases, and extra fields atomically", () => {
    const malformed = [
      { type: "event", event: "loop:assistant_delta", contentDelta: "hello" },
      streamEvent("loop:assistant_delta", { contentDelta: "" }),
      streamEvent("loop:tool_call_started", { callId: "", tool: "notes.read", args: {} }),
      streamEvent("loop:tool_call_started", {
        callId: "call-1",
        tool: "tool",
        args: {},
        legacyName: "notes.read",
      }),
      streamEvent("loop:tool_call_result", { callId: 7, durationMs: 1 }),
      streamEvent("loop:tool_call_result", { callId: "call-1", durationMs: -1 }),
      streamEvent("loop:tool_call_error", {
        callId: "call-1",
        error: "",
        durationMs: 1,
      }),
      streamEvent("loop:approval_pending", {
        callId: "call-1",
        tool: "",
        args: {},
        preview: "write",
      }),
      streamEvent("loop:approval_resolved", { callId: "call-1", approved: false }),
      streamEvent("loop:context_summarized", {
        conversationId: "conversation-1",
        model: "model",
        originalTokens: 100,
        summarizedTokens: 101,
      }),
      streamEvent("loop:context_overflow_warning", {
        conversationId: "conversation-1",
        model: "model",
        configuredTokens: 100,
        estimatedTokens: 100,
      }),
      streamEvent("loop:tool_mode_probed", { model: "", mode: "json", attempts: 0 }),
      streamEvent("loop:done", { finalMessage: {}, truncated: "false" }),
      streamEvent("loop:unknown", { callId: "fabricated" }),
      streamEvent("__proto__", {}),
    ];
    for (const detail of malformed) {
      const collector = actionCollector();
      expect(() => handleStreamEvent(detail, collector.dispatch)).toThrow(ChatStreamIntegrityError);
      expect(collector.actions).toEqual([]);
    }
  });

  test("drainTurn surfaces one integrity error and stops consuming the malformed stream", async () => {
    let reachedLaterFrame = false;
    async function* frames(): AsyncGenerator<TestStreamFrame> {
      yield { id: "req-1", type: "ack", method: "chat.send" };
      yield streamEvent("loop:approval_pending", {
        callId: null,
        tool: "notes.write",
        args: {},
        preview: "write",
      });
      reachedLaterFrame = true;
      yield streamEvent("loop:assistant_delta", { contentDelta: "must not render" });
    }
    const collector = actionCollector();
    const failures: unknown[] = [];
    const assistant = await drainTurn(
      frames(),
      collector.dispatch,
      (error) => {
        failures.push(error);
      },
      async () => {},
    );

    expect(assistant).toBe("");
    expect(reachedLaterFrame).toBe(false);
    expect(failures).toEqual([]);
    expect(collector.actions).toHaveLength(1);
    expect(collector.actions[0]).toMatchObject({
      type: "ask/line",
      line: {
        kind: "error",
      },
    });
    const errorAction = collector.actions[0] as Extract<Action, { type: "ask/line" }>;
    if (errorAction.line.kind !== "error") throw new Error("expected an error chat line");
    expect(errorAction.line.text).toContain("chat.send event integrity error");
    expect(errorAction.line.text).not.toContain("callId=null");
  });
});

describe("pending-count refresh transitions", () => {
  test("a validated approval_pending event refreshes vault.stats exactly once", async () => {
    async function* frames(): AsyncGenerator<TestStreamFrame> {
      yield { id: "req-1", type: "ack", method: "chat.send" };
      yield streamEvent("loop:approval_pending", {
        callId: "call-write",
        tool: "notes.write",
        args: { path: "Notes/A.md" },
        preview: "+ awakened text",
      });
      yield streamEvent("loop:assistant_delta", { contentDelta: "Waiting for approval." });
      yield { id: "req-1", type: "result", result: { ok: true } };
    }
    const collector = actionCollector();
    let statsRefreshes = 0;

    await drainTurn(
      frames(),
      collector.dispatch,
      () => {},
      async (_phase, _id) => {
        statsRefreshes += 1;
      },
    );

    expect(statsRefreshes).toBe(1);
    expect(collector.actions).toContainEqual({
      type: "ask/approvalPending",
      callId: "call-write",
      tool: "notes.write",
    });
  });

  test("a validated approval_resolved event refreshes vault.stats exactly once", async () => {
    async function* frames(): AsyncGenerator<TestStreamFrame> {
      yield { id: "req-1", type: "ack", method: "chat.send" };
      yield streamEvent("loop:approval_resolved", {
        callId: "call-write",
        approved: false,
        reason: "operator denied",
      });
      yield { id: "req-1", type: "result", result: { ok: true } };
    }
    const collector = actionCollector();
    const transitions: string[] = [];

    await drainTurn(
      frames(),
      collector.dispatch,
      () => {},
      async (phase, id) => {
        transitions.push(`${phase}:${id}`);
      },
    );

    expect(transitions).toEqual(["resolved:call-write"]);
    expect(collector.actions).toContainEqual({
      type: "ask/approvalResolved",
      callId: "call-write",
    });
  });

  test("coalesces overlapping observations of the same transition", async () => {
    const inFlight = new Map<string, Promise<void>>();
    let refreshes = 0;
    let release = (): void => {};
    const refresh = async (): Promise<void> => {
      refreshes += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const first = refreshPendingTransitionOnce(inFlight, "pending", "call-1", refresh);
    const overlapping = refreshPendingTransitionOnce(inFlight, "pending", "call-1", refresh);
    await Promise.resolve();
    expect(refreshes).toBe(1);
    expect(inFlight.size).toBe(1);
    release();
    await Promise.all([first, overlapping]);
    expect(inFlight.size).toBe(0);
  });

  test("refreshes again when a provider reuses an id after completion", async () => {
    const inFlight = new Map<string, Promise<void>>();
    let refreshes = 0;
    const refresh = async (): Promise<void> => {
      refreshes += 1;
    };

    await refreshPendingTransitionOnce(inFlight, "pending", "call-1", refresh);
    await refreshPendingTransitionOnce(inFlight, "pending", "call-1", refresh);

    expect(refreshes).toBe(2);
    expect(inFlight.size).toBe(0);
  });

  test("an Inbox decision refreshes its page and vault.stats exactly once each", async () => {
    const calls = { inbox: 0, stats: 0 };

    await refreshPendingState(
      async () => {
        calls.inbox += 1;
      },
      async () => {
        calls.stats += 1;
      },
    );

    expect(calls).toEqual({ inbox: 1, stats: 1 });
  });

  test("the production decision transition drops, decides, notices, and reconciles", async () => {
    const collector = actionCollector();
    const calls = { decide: 0, inbox: 0, stats: 0, failures: 0 };

    await runPendingDecisionTransition({
      id: "supports:aaaaaaaaaaaaaaaaaaaa",
      context: "links.approve",
      decide: async () => {
        calls.decide += 1;
        return "approved supports:aaaaaaaaaaaaaaaaaaaa";
      },
      dispatch: collector.dispatch,
      fail: () => {
        calls.failures += 1;
      },
      refreshInbox: async () => {
        calls.inbox += 1;
      },
      refreshStats: async () => {
        throw new Error("unused failure refresh");
      },
      refreshResolved: async () => {
        calls.stats += 1;
      },
    });

    expect(calls).toEqual({ decide: 1, inbox: 1, stats: 1, failures: 0 });
    expect(collector.actions).toEqual([
      { type: "inbox/drop", id: "supports:aaaaaaaaaaaaaaaaaaaa" },
      { type: "notice", text: "approved supports:aaaaaaaaaaaaaaaaaaaa" },
    ]);
  });

  test("a failed decision reports the failure and still reloads both authorities", async () => {
    const collector = actionCollector();
    const calls = { inbox: 0, stats: 0 };
    const failures: Array<{ message: string; context: string }> = [];

    await runPendingDecisionTransition({
      id: "call-1",
      context: "chat.approve",
      decide: async () => {
        throw new Error("ambiguous reply");
      },
      dispatch: collector.dispatch,
      fail: (error, context) => {
        failures.push({ message: (error as Error).message, context });
      },
      refreshInbox: async () => {
        calls.inbox += 1;
      },
      refreshStats: async () => {
        calls.stats += 1;
      },
      refreshResolved: async () => {
        throw new Error("must not mark a failed decision resolved");
      },
    });

    expect(calls).toEqual({ inbox: 1, stats: 1 });
    expect(failures).toEqual([{ message: "ambiguous reply", context: "chat.approve" }]);
    expect(collector.actions).toEqual([{ type: "inbox/drop", id: "call-1" }]);
  });

  test("the production slash path reloads Inbox and stats after a resolved edge decision", async () => {
    const collector = actionCollector();
    const calls = { inbox: 0, stats: 0, resolved: 0 };
    const id = "related_to:aaaaaaaaaaaaaaaaaaaa";
    const outcome = await runSlashCommand({
      line: `/approve-edge ${id}`,
      context: {
        client: {} as ClientHandle,
        vaultPath: "/tmp/vault",
        proposals: {
          list: async () => [],
          approve: async () => ({ message: `edge approved ${id}`, state: "resolved" }),
          reject: async () => ({ message: "unused", state: "uncertain" }),
        },
      },
      dispatch: collector.dispatch,
      onExit: () => {},
      refreshInbox: async () => {
        calls.inbox += 1;
      },
      refreshStats: async () => {
        calls.stats += 1;
      },
      refreshResolved: async (resolvedId) => {
        expect(resolvedId).toBe(id);
        calls.resolved += 1;
      },
    });

    expect(outcome.pendingTransition).toEqual({ id, state: "resolved" });
    expect(calls).toEqual({ inbox: 1, stats: 0, resolved: 1 });
    expect(collector.actions).toEqual([
      { type: "command/output", text: `edge approved ${id}` },
      { type: "ask/line", line: { kind: "system", text: `edge approved ${id}` } },
    ]);
  });

  test("the production slash path does not consume a resolved key after an uncertain decision", async () => {
    const collector = actionCollector();
    const calls = { inbox: 0, stats: 0 };
    const id = "related_to:bbbbbbbbbbbbbbbbbbbb";
    const outcome = await runSlashCommand({
      line: `/reject-edge ${id}`,
      context: {
        client: {} as ClientHandle,
        vaultPath: "/tmp/vault",
        proposals: {
          list: async () => [],
          approve: async () => ({ message: "unused", state: "uncertain" }),
          reject: async () => ({ message: "rejected error: disconnected", state: "uncertain" }),
        },
      },
      dispatch: collector.dispatch,
      onExit: () => {},
      refreshInbox: async () => {
        calls.inbox += 1;
      },
      refreshStats: async () => {
        calls.stats += 1;
      },
      refreshResolved: async () => {
        throw new Error("uncertain decision must not mark the transition resolved");
      },
    });

    expect(outcome.pendingTransition).toEqual({ id, state: "uncertain" });
    expect(calls).toEqual({ inbox: 1, stats: 1 });
  });
});

describe("AppFrame", () => {
  test("paints the root box with the palette background", () => {
    const layout = deriveTuiLayout(80, 24);
    const element = AppFrame({ state: initialState("/tmp/vault"), layout, children: null }) as {
      props: Record<string, unknown>;
    };
    expect(element.props.backgroundColor).toBe(COLOR.bg);
    expect(element.props.width).toBe(80);
    expect(element.props.height).toBe(24);
  });
});

describe("runSingleFlight", () => {
  test("coalesces overlapping event polls and permits the next poll after settlement", async () => {
    const inFlight = { current: null as Promise<void> | null };
    let calls = 0;
    let release = (): void => {};
    const task = async (): Promise<void> => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const first = runSingleFlight(inFlight, task);
    const overlapping = runSingleFlight(inFlight, task);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(inFlight.current).not.toBeNull();

    release();
    await Promise.all([first, overlapping]);
    await Promise.resolve();
    expect(inFlight.current).toBeNull();

    const next = runSingleFlight(inFlight, async () => {
      calls += 1;
    });
    await next;
    expect(calls).toBe(2);
  });

  test("queues a mutation reconciliation behind an older poll", async () => {
    const inFlight = { current: null as Promise<void> | null };
    const order: string[] = [];
    let release = (): void => {};
    const poll = runSingleFlight(inFlight, async () => {
      order.push("poll:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("poll:end");
    });
    await Promise.resolve();

    const trailing = runTrailingFlight(inFlight, async () => {
      order.push("refresh");
    });
    await Promise.resolve();
    expect(order).toEqual(["poll:start"]);

    release();
    await Promise.all([poll, trailing]);
    expect(order).toEqual(["poll:start", "poll:end", "refresh"]);
    expect(inFlight.current).toBeNull();
  });
});

describe("loadActiveView", () => {
  test("invokes exactly one loader for each data-backed view switch", async () => {
    const calls = { home: 0, inbox: 0, stream: 0 };
    const loaders = {
      home: async () => {
        calls.home += 1;
      },
      inbox: async () => {
        calls.inbox += 1;
      },
      stream: async () => {
        calls.stream += 1;
      },
    };

    await loadActiveView("home", loaders);
    expect(calls).toEqual({ home: 1, inbox: 0, stream: 0 });
    await loadActiveView("ask", loaders);
    expect(calls).toEqual({ home: 1, inbox: 0, stream: 0 });
    await loadActiveView("inbox", loaders);
    expect(calls).toEqual({ home: 1, inbox: 1, stream: 0 });
    await loadActiveView("stream", loaders);
    expect(calls).toEqual({ home: 1, inbox: 1, stream: 1 });
  });
});

describe("approvalDecisionNotice", () => {
  test("reports the daemon's exact approval decision within the deciding render", () => {
    expect(approvalDecisionNotice({ ok: true, callId: "call-1", approved: true })).toBe(
      "approved call-1",
    );
    expect(
      approvalDecisionNotice({
        ok: true,
        callId: "call-2",
        approved: false,
        reason: "wrong vault",
      }),
    ).toBe("rejected call-2: wrong vault");
  });
});

describe("scrollBy", () => {
  test("preserves row-scroll direction and magnitude", () => {
    const calls: Array<[{ x: number; y: number }, string | undefined]> = [];
    const ref = {
      current: {
        scrollBy: (delta: number | { x: number; y: number }, unit?: string): void => {
          if (typeof delta === "number") throw new Error("expected a two-axis delta");
          calls.push([delta, unit]);
        },
      },
    };

    scrollBy(ref, 1);
    scrollBy(ref, -1);
    scrollBy(ref, 10);
    scrollBy(ref, -10);

    expect(calls).toEqual([
      [{ x: 0, y: 1 }, "absolute"],
      [{ x: 0, y: -1 }, "absolute"],
      [{ x: 0, y: 10 }, "absolute"],
      [{ x: 0, y: -10 }, "absolute"],
    ]);
  });
});

describe("Inbox selection reveal", () => {
  function proposal(index: number, target = "target.md"): ProposalWire {
    return {
      id: `supports:${String(index).padStart(20, "0")}`,
      table: "supports",
      fromNotePath: `source-${index}.md`,
      toNotePath: target,
      confidence: 0.8,
      source: "linker",
      agent: "linker",
      createdAt: index,
      evidence: [],
    };
  }

  function scrollRecorder(
    scrollTop: number,
    viewportHeight: number,
  ): {
    ref: {
      current: {
        scrollTop: number;
        viewport: { height: number };
        scrollTo: (position: number | { x: number; y: number }) => void;
      };
    };
    positions: Array<number | { x: number; y: number }>;
  } {
    const positions: Array<number | { x: number; y: number }> = [];
    const result = {
      ref: {
        current: {
          scrollTop,
          viewport: { height: viewportHeight },
          scrollTo: (position: number | { x: number; y: number }): void => {
            positions.push(position);
            result.ref.current.scrollTop = typeof position === "number" ? position : position.y;
          },
        },
      },
      positions,
    };
    return result;
  }

  test("reveals downward and upward selections beyond the viewport", () => {
    const proposals = Array.from({ length: 30 }, (_, index) =>
      proposal(index, `group-${Math.floor(index / 5)}.md`),
    );
    let state = reducer(initialState("/v"), {
      type: "inbox/loaded",
      proposals,
      approvals: [],
    });
    const scroll = scrollRecorder(0, 5);

    state = reducer(state, { type: "inbox/move", delta: 24 });
    revealInboxSelection(scroll.ref, state.inbox, 5);
    state = reducer(state, { type: "inbox/move", delta: -20 });
    revealInboxSelection(scroll.ref, state.inbox, 5);

    expect(scroll.positions).toEqual([
      { x: 0, y: 25 },
      { x: 0, y: 5 },
    ]);
  });

  test("a filter reset returns to the top before revealing its first match", () => {
    const proposals = Array.from({ length: 30 }, (_, index) =>
      proposal(index, `group-${Math.floor(index / 5)}.md`),
    );
    let state = reducer(initialState("/v"), {
      type: "inbox/loaded",
      proposals,
      approvals: [],
    });
    state = reducer(state, { type: "inbox/move", delta: 24 });
    state = reducer(state, { type: "inbox/filter", filter: "group-2.md" });
    const scroll = scrollRecorder(25, 5);

    resetInboxScroll(scroll.ref);
    revealInboxSelection(scroll.ref, state.inbox, 5);

    expect(state.inbox.cursor).toBe(0);
    expect(scroll.positions).toEqual([{ x: 0, y: 0 }]);
  });

  test("re-reveals the same selection after a tall viewport shrinks", () => {
    const proposals = Array.from({ length: 30 }, (_, index) => proposal(index, "target.md"));
    let state = reducer(initialState("/v"), {
      type: "inbox/loaded",
      proposals,
      approvals: [],
    });
    state = reducer(state, { type: "inbox/move", delta: 24 });
    const scroll = scrollRecorder(11, 15);

    revealInboxSelection(scroll.ref, state.inbox, 15);
    revealInboxSelection(scroll.ref, state.inbox, 5);

    expect(scroll.positions).toEqual([{ x: 0, y: 21 }]);
  });

  test("uses the rendered viewport when transient chrome consumes layout rows", () => {
    const proposals = Array.from({ length: 30 }, (_, index) => proposal(index, "target.md"));
    let state = reducer(initialState("/v"), {
      type: "inbox/loaded",
      proposals,
      approvals: [],
    });
    state = reducer(state, { type: "inbox/move", delta: 24 });
    const scroll = scrollRecorder(0, 3);

    revealInboxSelection(scroll.ref, state.inbox, 8);

    expect(scroll.positions).toEqual([{ x: 0, y: 23 }]);
  });
});
