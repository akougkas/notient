import { afterAll, describe, expect, test } from "bun:test";
import { type CompletionMetadata, decodeUsage } from "../../../../src/core/llm/completion";
import { InferenceBudget } from "../../../../src/core/llm/executionBudget";
import { LMStudioProvider } from "../../../../src/core/llm/lmStudioProvider";

let frames: unknown[] = [];
let done = true;
let nonstream: unknown;
let requests = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    requests++;
    const body = (await request.json()) as { stream: boolean };
    return body.stream
      ? new Response(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
            (done ? "data: [DONE]\n\n" : ""),
        )
      : Response.json(nonstream);
  },
});
afterAll(() => server.stop(true));
const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
const usage = {
  prompt_tokens: 100,
  completion_tokens: 90,
  total_tokens: 190,
  completion_tokens_details: { reasoning_tokens: 80 },
};
const call = async (onCompletion?: (m: CompletionMetadata) => void) => {
  const handle = await provider.chatWithTools({
    model: "m",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(1000),
    onCompletion,
  });
  const visible: string[] = [];
  for await (const event of handle.events) if (event.contentDelta) visible.push(event.contentDelta);
  return { result: await handle.result(), visible };
};

describe("reasoning completion integrity", () => {
  test("usage-only frame preserves aggregate, reasoning and unknown visible accounting", async () => {
    done = true;
    frames = [
      { choices: [{ delta: { reasoning_content: "private deliberation" } }] },
      { choices: [{ delta: { content: "final answer" }, finish_reason: "stop" }] },
      { choices: [], usage },
    ];
    const { result, visible } = await call();
    expect(visible.join("")).toBe("final answer");
    expect(result.reasoningContent).toBe("private deliberation");
    expect(result.completion?.usage).toMatchObject({
      completionTokens: 90,
      reasoningTokens: 80,
      visibleAnswerTokens: null,
      nonReasoningCompletionTokens: 10,
      totalTokens: 190,
    });
    expect(decodeUsage(undefined).source).toBe("unavailable");
  });

  test("valid-looking truncated JSON is rejected and charged", async () => {
    nonstream = {
      choices: [
        { message: { content: '{"ok":true}', reasoning_content: "work" }, finish_reason: "length" },
      ],
      usage,
    };
    let metadata: CompletionMetadata | undefined;
    await expect(
      provider.chatJson(
        [],
        {
          model: "m",
          onCompletion: (m) => {
            metadata = m;
          },
        },
        { name: "x", schema: { type: "object" } },
      ),
    ).rejects.toThrow("truncated");
    expect(metadata?.usage.totalTokens).toBe(190);
    expect(metadata?.state).toBe("truncated");
  });

  test("truncated tool arguments are never executable even if they parse", async () => {
    frames = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "effect",
                  type: "function",
                  function: { name: "notes.create", arguments: "{}" },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage,
      },
    ];
    await expect(call()).rejects.toThrow("truncated");
  });

  test("missing finalization and reasoning-only responses are failures", async () => {
    frames = [{ choices: [{ delta: { content: "plausible but unfinished" } }] }];
    await expect(call()).rejects.toThrow("finish_reason=unavailable");
    frames = [
      {
        choices: [
          { delta: { reasoning_content: '{"tool":"notes.create"}' }, finish_reason: "stop" },
        ],
        usage,
      },
    ];
    await expect(call()).rejects.toThrow("incomplete");
  });

  test("disconnect retains the full reservation and prevents an unbudgeted retry", async () => {
    done = false;
    frames = [{ choices: [{ delta: { reasoning_content: "still working" } }] }];
    const budget = new InferenceBudget({ modelCalls: 1, tokens: 10000, durationMs: 5000 });
    const before = requests;
    await budget.run(async () => {
      await expect(call()).rejects.toThrow("before [DONE]");
      await expect(call()).rejects.toThrow("model-call budget exhausted");
    });
    expect(requests - before).toBe(1);
    expect(budget.attempts[0].accounting).toBe("reserved-estimate");
    expect(budget.attempts[0].completion?.state).toBe("incomplete");
    expect(budget.chargedTokens).toBeGreaterThan(8192);
    done = true;
  });

  test("failed durable reservation prevents dispatch", async () => {
    const before = requests;
    const budget = new InferenceBudget(
      { modelCalls: 2, tokens: 20000, durationMs: 5000 },
      [],
      async () => {
        throw new Error("checkpoint unavailable");
      },
    );
    await expect(budget.run(() => call())).rejects.toThrow("checkpoint unavailable");
    expect(requests).toBe(before);
    expect(budget.attempts[0].accounting).toBe("reserved-estimate");
    await expect(budget.flush()).rejects.toThrow("checkpoint unavailable");
  });

  test("fragmented names and parallel call indices assemble without synthetic IDs", async () => {
    frames = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "b",
                  type: "function",
                  function: { name: "read_", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  type: "function",
                  function: { name: "list", arguments: "{}" },
                },
                { index: 1, function: { name: "note", arguments: '"a.md"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { choices: [], usage },
    ];
    const { result } = await call();
    expect(result.toolCalls).toEqual([
      { id: "a", name: "list", args: {} },
      { id: "b", name: "read_note", args: { path: "a.md" } },
    ]);
  });
});
