import { describe, expect, test } from "bun:test";
import { type AgentLoopEvent, runAgentTurn } from "../../../../src/core/chat/agentLoop";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import {
  type ToolDefinition,
  type ToolJsonSchema,
  ToolRegistry,
} from "../../../../src/core/chat/tools/registry";
import type { Conversation, ToolCall } from "../../../../src/core/chat/types";
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
} from "../../../../src/core/llm/provider";

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
    // Snapshot the message array: the loop keeps appending to (and rewriting
    // slots of) the same array across rounds, so holding the live reference
    // would make every recorded request look like the last one.
    this.requests.push({ ...request, messages: [...request.messages] });
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
    sessionGrants: { claim: async () => null },
    perToolPolicy: () => ({}),
    recordHistoryAutoApprove: async () => {
      // unused in tests
    },
  });
  approvalGate.subscribe({
    onPending: (entry) =>
      pending.push({ id: entry.callId, name: entry.toolName, args: entry.args }),
    onResolved: () => {
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
    clientIdentity: "human",
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
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
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

  test("unexecuted Qwen tool markup is an invalid answer and never an effect", async () => {
    const provider = new ScriptedProvider([
      {
        finalContent:
          "<tool_call><function=vault.read><parameter=path>A</parameter></function></tool_call>",
      },
    ]);
    let effects = 0;
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: makeRegistry([
            readTool(async () => {
              effects++;
              return {};
            }),
          ]),
          maxRoundsPerTurn: 1,
          toolMode: () => "native",
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "answer" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    expect(events.some((event) => event.type === "loop:done")).toBe(false);
    expect(events.some((event) => event.type === "loop:assistant-token")).toBe(false);
    expect(events.find((event) => event.type === "loop:error")).toMatchObject({
      kind: "invalid-model-output",
    });
    expect(effects).toBe(0);
  });

  test("never sends responseSchema on a tool round; finalizes with tools disabled", async () => {
    const provider = new ScriptedProvider([
      { finalContent: "The answer is four." },
      { finalContent: '{"answer":"four"}' },
    ]);
    const registry = makeRegistry([readTool(async () => ({ ok: true }))]);
    const responseSchema: JsonSchema = {
      name: "answer_shape",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    };

    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          responseSchema,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "hi" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );

    expect(provider.requests.length).toBe(2);
    expect(provider.requests[0]?.responseSchema).toBeUndefined();
    expect(provider.requests[0]?.tools.length).toBeGreaterThan(0);
    expect(provider.requests[1]?.responseSchema).toEqual(responseSchema);
    expect(provider.requests[1]?.tools).toEqual([]);
    expect(provider.requests[1]?.toolChoice).toBe("none");
    const draft = provider.requests[1]?.messages.at(-2);
    expect(draft).toEqual({ role: "assistant", content: "The answer is four." });
    const done = events.find((event) => event.type === "loop:done");
    expect(done && done.type === "loop:done" ? done.finalMessage.content : "").toBe(
      '{"answer":"four"}',
    );
  });

  test("skips the finalize pass when the draft already parses as a JSON object", async () => {
    const provider = new ScriptedProvider([{ finalContent: '{"answer":"four"}' }]);
    const registry = makeRegistry([readTool(async () => ({ ok: true }))]);
    const responseSchema: JsonSchema = {
      name: "answer_shape",
      schema: { type: "object", properties: { answer: { type: "string" } } },
    };
    await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 1,
          toolMode: () => "native",
          responseSchema,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "hi" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    expect(provider.requests.length).toBe(1);
  });

  test("finalizes when the draft is JSON but lacks a required key", async () => {
    const provider = new ScriptedProvider([
      { finalContent: '{"answer":"four"}' },
      { finalContent: '{"answer":"four","citations":[]}' },
    ]);
    const registry = makeRegistry([readTool(async () => ({ ok: true }))]);
    const responseSchema: JsonSchema = {
      name: "answer_shape",
      schema: {
        type: "object",
        properties: { answer: { type: "string" }, citations: { type: "array" } },
        required: ["answer", "citations"],
      },
    };
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          responseSchema,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "hi" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    expect(provider.requests.length).toBe(2);
    const done = events.find((event) => event.type === "loop:done");
    expect(done && done.type === "loop:done" ? done.finalMessage.content : "").toBe(
      '{"answer":"four","citations":[]}',
    );
  });

  test("after-tool-call mode does not finalize when no tool ran", async () => {
    const provider = new ScriptedProvider([{ finalContent: "plain prose" }]);
    const registry = makeRegistry([readTool(async () => ({ ok: true }))]);
    const responseSchema: JsonSchema = { name: "s", schema: { type: "object" } };
    await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 1,
          toolMode: () => "native",
          responseSchema,
          responseSchemaMode: "after-tool-call",
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "hi" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
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
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
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

  test("turns a blank thrown diagnostic into a canonical tool error", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "call-blank", name: "vault.read", args: { path: "Notes/A.md" } }],
      },
      { finalContent: "Done." },
    ]);
    const registry = makeRegistry([
      readTool(async () => {
        throw new Error("   ");
      }),
    ]);
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "read Notes/A" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    const result = events.find((event) => event.type === "loop:tool-result");
    expect(result).toEqual({
      type: "loop:tool-result",
      result: {
        callId: "call-blank",
        status: "error",
        error: "tool failed without a diagnostic",
        durationMs: 0,
      },
    });
  });

  test("reserves the last generation for an answer within the configured budget", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { finalContent: "Source A supports the answer." },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [
            { role: "system", content: "Original authority." },
            { role: "user", content: "loop" },
          ],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    if (done && done.type === "loop:done") {
      expect(done.finalMessage.content).toBe("Source A supports the answer.");
      expect(done.truncated).toBeUndefined();
    }
    expect(provider.requests.length).toBe(2);
    expect(provider.requests[1].tools).toEqual([]);
    expect(provider.requests[1].toolChoice).toBe("none");
    expect(provider.requests[1].messages[0].content).toContain("Original authority.");
    expect(provider.requests[1].messages[0].content).toContain("final generation");
    expect(
      provider.requests[1].messages.slice(1).some((message) => message.role === "system"),
    ).toBe(false);
    expect(provider.requests[0].messages[0].content).toBe("Original authority.");
  });

  test("structured finalization also fits inside the total generation budget", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
      { finalContent: '{"answer":"forced answer","citations":[]}' },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const schema: JsonSchema = {
      name: "forced",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    };
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 3,
          toolMode: () => "native",
          responseSchema: schema,
          responseSchemaMode: "after-tool-call",
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
    expect(provider.requests.length).toBe(3);
    const forcedRequest = provider.requests[2];
    expect(forcedRequest?.tools).toEqual([]);
    expect(forcedRequest?.toolChoice).toBe("none");
    expect(forcedRequest?.responseSchema).toBe(schema);
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    if (done && done.type === "loop:done") {
      expect(done.truncated).toBeUndefined();
      expect(done.finalMessage.content).toBe('{"answer":"forced answer","citations":[]}');
    }
  });

  test("an empty final generation is a failure, never a fabricated completed answer", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
      { finalContent: "" },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 3,
          toolMode: () => "native",
          responseSchema: {
            name: "forced",
            schema: { type: "object", properties: {}, required: [], additionalProperties: false },
          },
          responseSchemaMode: "after-tool-call",
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
    expect(provider.requests).toHaveLength(3);
    expect(events.some((event) => event.type === "loop:done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "loop:error",
      message: expect.stringContaining("no visible answer"),
    });
  });

  test("think tags leaked into the content channel are stripped from the final message", async () => {
    const provider = new ScriptedProvider([
      {
        contentChunks: ["<think>plan", " some more</think>", "Answer"],
        finalContent: "Answer",
      },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 2,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "think" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );
    const done = events.find((event) => event.type === "loop:done");
    expect(done).toBeDefined();
    if (done && done.type === "loop:done") {
      expect(done.finalMessage.content).toBe("Answer");
    }
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
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
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

  test("refuses provider tool calls in the reserved answer round", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
      { toolCalls: [{ id: "c3", name: "vault.read", args: { path: "C" } }] },
    ]);
    const registry = makeRegistry([readTool(async () => ({}))]);
    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
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
    expect(events.filter((event) => event.type === "loop:tool-call")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "loop:error",
      message: expect.stringContaining("No additional calls were executed"),
    });
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
    const { pending } = makeApprovalGate();
    const generator = runAgentTurn(
      {
        provider,
        toolRegistry: registry,
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
    const generator = runAgentTurn(
      {
        provider,
        toolRegistry: registry,
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

  test("rejects a duplicate provider tool-call id before events or invocations", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "duplicate", name: "vault.read", args: { path: "A" } },
          { id: "duplicate", name: "vault.read", args: { path: "B" } },
        ],
      },
    ]);
    let invocations = 0;
    const registry = makeRegistry([
      readTool(async () => {
        invocations += 1;
        return { ok: true };
      }),
    ]);

    const events = await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "read both" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );

    expect(invocations).toBe(0);
    expect(events.some((event) => event.type === "loop:tool-call")).toBe(false);
    expect(events).toEqual([
      {
        type: "loop:error",
        kind: "invalid-model-output",
        message: "duplicate tool call id in one assistant batch",
      },
    ]);
  });

  test("sends the OpenAI tool-call protocol across a two-round tool turn", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "call-1", name: "vault.read", args: { path: "A.md" } },
          { id: "call-2", name: "vault.read", args: { path: "B.md" } },
        ],
        contentChunks: ["looking"],
        finalContent: "looking",
      },
      { contentChunks: ["Done."], finalContent: "Done." },
    ]);
    const registry = makeRegistry([readTool(async (args) => args)]);

    await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [
            { role: "system", content: "sys" },
            { role: "user", content: "read both" },
          ],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );

    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "read both" },
    ]);
    // Round two replays the assistant turn with its tool_calls intact and one
    // role:"tool" message per result, keyed by tool_call_id.
    expect(provider.requests[1]?.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: "looking",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "vault.read", arguments: '{"path":"A.md"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "vault.read", arguments: '{"path":"B.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"path":"A.md"}' },
      { role: "tool", tool_call_id: "call-2", content: '{"path":"B.md"}' },
    ]);
  });

  test("truncates the oldest tool results when the buffer exceeds contextBudgetTokens", async () => {
    const bulk = "x".repeat(4000);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "vault.read", args: { path: "A" } }] },
      { toolCalls: [{ id: "c2", name: "vault.read", args: { path: "B" } }] },
      { contentChunks: ["Done."], finalContent: "Done." },
    ]);
    const registry = makeRegistry([readTool(async () => bulk)]);

    await collect(
      runAgentTurn(
        {
          provider,
          toolRegistry: registry,
          maxRoundsPerTurn: 4,
          toolMode: () => "native",
          contextBudgetTokens: 1200,
          generateId: () => "id",
          now: () => 0,
        },
        {
          conversation: makeConversation(),
          systemAndHistory: [{ role: "user", content: "read" }],
          model: "model",
          signal: new AbortController().signal,
        },
      ),
    );

    const third = provider.requests[2]?.messages ?? [];
    const toolMessages = third.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toBe(`[truncated ${JSON.stringify(bulk).length} chars]`);
    // The newest result survives; only the oldest was blanked.
    expect(toolMessages[1]?.content).toBe(JSON.stringify(bulk));
  });
});
