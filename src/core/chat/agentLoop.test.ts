import { describe, expect, test } from "bun:test";
import type {
  ChatOptions,
  ChatWithToolsEvent,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  ChatWithToolsResult,
  ChatWithToolsToolCall,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../llm/provider";
import { type AgentLoopEvent, runAgentTurn } from "./agentLoop";
import { ApprovalGate } from "./approvalGate";
import { type ToolDefinition, type ToolJsonSchema, ToolRegistry } from "./tools/registry";
import type { Conversation, ToolCall } from "./types";

interface ScriptedTurn {
  contentChunks?: string[];
  reasoningChunks?: string[];
  toolCalls?: ChatWithToolsToolCall[];
  finalContent?: string;
  finalReasoning?: string;
  throwOnEvents?: () => Error;
}

class ScriptedProvider implements LLMProvider {
  public readonly requests: ChatWithToolsRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(): Promise<string> {
    return "";
  }
  async *chatStream(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
  ): AsyncIterable<string> {
    yield "";
  }
  async chatJson<T>(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    return {} as T;
  }
  async embed(_input: string[], _options: EmbedOptions): Promise<number[][]> {
    return [];
  }

  async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    this.requests.push(request);
    const turn = this.script[this.requests.length - 1];
    if (!turn) throw new Error(`unexpected provider call #${this.requests.length}`);
    const events = turn.throwOnEvents ? throwingEvents(turn.throwOnEvents()) : scriptedEvents(turn);
    const result: ChatWithToolsResult = {
      content: turn.finalContent ?? (turn.contentChunks ?? []).join(""),
      reasoningContent: turn.finalReasoning ?? (turn.reasoningChunks ?? []).join(""),
      toolCalls: turn.toolCalls ?? [],
    };
    return {
      events,
      result: async () => result,
    };
  }
}

async function* scriptedEvents(turn: ScriptedTurn): AsyncIterable<ChatWithToolsEvent> {
  for (const chunk of turn.contentChunks ?? []) {
    yield { type: "delta", contentDelta: chunk };
  }
  for (const chunk of turn.reasoningChunks ?? []) {
    yield { type: "delta", reasoningDelta: chunk };
  }
}

async function* throwingEvents(error: Error): AsyncIterable<ChatWithToolsEvent> {
  yield { type: "delta", contentDelta: "" };
  throw error;
}

function makeRegistry(definitions: ToolDefinition<unknown, unknown>[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

function readTool(
  invoke: (args: unknown, signal: AbortSignal) => Promise<unknown>,
): ToolDefinition<unknown, unknown> {
  const schema: ToolJsonSchema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
  return {
    name: "vault.read",
    description: "Read a note.",
    schema,
    validate: (args) => args,
    invoke,
    writeGated: false,
  };
}

function writeTool(
  invoke: (args: unknown, signal: AbortSignal) => Promise<unknown>,
): ToolDefinition<unknown, unknown> {
  const schema: ToolJsonSchema = {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  };
  return {
    name: "notes.create",
    description: "Create a note.",
    schema,
    validate: (args) => args,
    invoke,
    writeGated: true,
  };
}

function makeApprovalGate(): {
  approvalGate: ApprovalGate;
  pending: ToolCall[];
} {
  const pending: ToolCall[] = [];
  const approvalGate = new ApprovalGate({
    events: {
      onPending: (entry) =>
        pending.push({ id: entry.callId, name: entry.toolName, args: entry.args }),
      onResolved: () => {
        // unused in tests
      },
    },
    recordHistoryAutoApprove: async () => {
      // unused in tests
    },
  });
  return { approvalGate, pending };
}

function makeConversation(approvalMode: Conversation["approvalMode"] = "yolo"): Conversation {
  return {
    id: "conv-1",
    notePath: "Notient/conversations/2026-04-25 t.md",
    model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    pinnedContext: [],
    approvalMode,
    topic: "T",
    summary: "",
    summaryEmbeddingB64: null,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

async function collect(generator: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("runAgentTurn", () => {
  test("terminates on a text-only assistant response", async () => {
    const provider = new ScriptedProvider([
      { contentChunks: ["Hello", " world"], finalContent: "Hello world" },
    ]);
    const registry = makeRegistry([readTool(async () => ({ ok: true }))]);
    const { approvalGate } = makeApprovalGate();
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          approvalGate,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          generateId: () => "message-1",
          now: () => 1,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "hi" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    const tokens = events.filter((event) => event.type === "loop:assistant-token");
    expect(tokens.map((event) => (event as { delta: string }).delta)).toEqual(["Hello", " world"]);
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    expect(done && done.type === "loop:done" ? done.finalMessage.content : "").toBe("Hello world");
    expect(provider.requests.length).toBe(1);
  });

  test("executes a read-only tool call and resumes the loop", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "call-1", name: "vault.read", args: { path: "Notes/A.md" } }],
        finalContent: "",
      },
      { contentChunks: ["Done."], finalContent: "Done." },
    ]);
    const invoked: unknown[] = [];
    const registry = makeRegistry([
      readTool(async (args) => {
        invoked.push(args);
        return { content: "body" };
      }),
    ]);
    const { approvalGate } = makeApprovalGate();
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          approvalGate,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 10,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "read Notes/A" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    expect(invoked).toEqual([{ path: "Notes/A.md" }]);
    const calls = events.filter((event) => event.type === "loop:tool-call");
    const results = events.filter((event) => event.type === "loop:tool-result");
    expect(calls.length).toBe(1);
    expect(results.length).toBe(1);
    expect(provider.requests.length).toBe(2);
    const done = events.find((event) => event.type === "loop:done");
    expect(done && done.type === "loop:done" ? done.finalMessage.content : "").toBe("Done.");
  });

  test("hits the round cap and emits the apology message", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const { approvalGate } = makeApprovalGate();
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          approvalGate,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "loop" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    if (done && done.type === "loop:done") {
      expect(done.finalMessage.content).toContain("all available tool rounds");
    }
    expect(provider.requests.length).toBe(2);
  });

  test("abort during a tool call propagates to the loop", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
    ]);
    const registry = makeRegistry([
      readTool(async (_args, signal) => {
        controller.abort();
        if (signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        return {};
      }),
    ]);
    const { approvalGate } = makeApprovalGate();
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          approvalGate,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "abort" }],
          model: "model",
          signal: controller.signal,
        },
      ),
    );
    const errorEvent = events.find((event) => event.type === "loop:error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "loop:error") {
      expect(errorEvent.message).toBe("aborted");
    }
  });

  test("hits round cap and emits truncated:true flag with marker in final message", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
      { toolCalls: [{ id: "c3", name: "vault.read", args: { path: "C" } }] },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const { approvalGate } = makeApprovalGate();
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          approvalGate,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "loop" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    // Loop must NOT throw; it must emit a clean truncated done event.
    const errorEvent = events.find((event) => event.type === "loop:error");
    expect(errorEvent).toBeUndefined();
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    if (done && done.type === "loop:done") {
      expect(done.truncated).toBe(true);
      expect(done.finalMessage.content.toLowerCase()).toContain("truncated");
    }
    // Provider was called exactly maxRoundsPerTurn times.
    expect(provider.requests.length).toBe(2);
  });

  test("write-gated tools are invoked once and own their approval preview", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "c1",
            name: "notes.create",
            args: { path: "Notes/New.md", content: "body" },
          },
        ],
      },
      { contentChunks: ["Created."], finalContent: "Created." },
    ]);
    let invocations = 0;
    const registry = makeRegistry([
      writeTool(async () => {
        invocations += 1;
        return { created: true };
      }),
    ]);
    const { approvalGate, pending } = makeApprovalGate();
    const generator = runAgentTurn(
      {
        provider,
        toolRegistry: registry,
        approvalGate,
        maxRoundsPerTurn: 4,
        toolMode: () => "native",
        generateId: () => "id",
        now: () => 0,
      },
      {
        conversation: makeConversation("safe"),
        systemAndHistory: [{ role: "user", content: "create note" }],
        model: "model",
        signal: new AbortController().signal,
      },
    );
    const events: AgentLoopEvent[] = [];
    for await (const event of generator) {
      events.push(event);
    }
    expect(invocations).toBe(1);
    expect(pending.length).toBe(0);
    expect(events.some((event) => event.type === "loop:approval-pending")).toBe(false);
    const done = events.find((event) => event.type === "loop:done");
    expect(done && done.type === "loop:done" ? done.finalMessage.content : "").toBe("Created.");
  });

  test("dispatches multiple tool calls in parallel within one round", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "vault.read", args: { path: "A" } },
          { id: "c2", name: "vault.read", args: { path: "B" } },
          { id: "c3", name: "vault.read", args: { path: "C" } },
        ],
      },
      { contentChunks: ["Done."], finalContent: "Done." },
    ]);

    // Three deferred promises so we can verify all three invokes are
    // in-flight before any of them resolves. If the loop were serial we'd
    // observe inflightAtPeak === 1.
    const inflight = { count: 0, peak: 0 };
    const resolvers: Array<(value: { ok: true }) => void> = [];
    const registry = makeRegistry([
      readTool(
        (_args) =>
          new Promise<{ ok: true }>((resolve) => {
            inflight.count += 1;
            inflight.peak = Math.max(inflight.peak, inflight.count);
            resolvers.push((value) => {
              inflight.count -= 1;
              resolve(value);
            });
          }),
      ),
    ]);
    const { approvalGate } = makeApprovalGate();
    const generator = runAgentTurn(
      {
        provider,
        toolRegistry: registry,
        approvalGate,
        maxRoundsPerTurn: 4,
        toolMode: () => "native",
        generateId: () => "id",
        now: () => 0,
      },
      {
        conversation: makeConversation(),
        systemAndHistory: [{ role: "user", content: "fan out" }],
        model: "model",
        signal: new AbortController().signal,
      },
    );

    // Drive the loop: pull events until we've seen all three tool-call
    // events, by which point all three invokes should be in-flight.
    const events: AgentLoopEvent[] = [];
    const observed = (async () => {
      for await (const event of generator) events.push(event);
    })();

    // Spin briefly so the loop kicks all three invokes.
    await new Promise((r) => setTimeout(r, 5));
    while (resolvers.length < 3) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(inflight.peak).toBe(3);

    // Now resolve in reverse order to prove result emission stays
    // in original tool-call order regardless of completion order.
    resolvers[2]?.({ ok: true });
    resolvers[1]?.({ ok: true });
    resolvers[0]?.({ ok: true });
    await observed;

    const resultEvents = events.filter((e) => e.type === "loop:tool-result");
    expect(resultEvents.map((e) => (e as { result: { callId: string } }).result.callId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });
});
