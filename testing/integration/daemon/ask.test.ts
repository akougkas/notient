import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNGROUNDED_ANSWER, askResultSchema } from "../../../src/api/ask";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] scoped answers share HTTP and socket evidence, streamed tool calls and provider accounting",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-ask-api-"));
    const body = "# Storage\r\n\r\nDurability uses a write-ahead log.\r\n";
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    type Message = { role: string; content: string; tool_call_id?: string };
    type ModelRequest = {
      messages: Message[];
      tools?: Array<{ function: { name: string } }>;
      stream?: boolean;
    };
    const requests: ModelRequest[] = [];
    let cancellationStarted = false;
    let providerCancelled = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "answer-test", state: "loaded" }] });
        const input = (await request.json()) as ModelRequest;
        requests.push(input);
        if (
          input.messages.some(
            (message) => message.role === "user" && message.content === "Wait for cancellation",
          )
        ) {
          cancellationStarted = true;
          request.signal.addEventListener(
            "abort",
            () => {
              providerCancelled = true;
            },
            { once: true },
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"pending"},"finish_reason":null}]}\n\n',
                  ),
                );
              },
              cancel() {
                providerCancelled = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        const messages = input.messages as Message[];
        const toolMessages = messages.filter((message) => message.role === "tool");
        let call: { id: string; name: string; arguments: string } | undefined;
        let answer = "";
        if (input.tools?.[0]?.function.name === "echo")
          call = { id: "probe-1", name: "echo", arguments: '{"value":"ping"}' };
        else if (!toolMessages.length)
          call = {
            id: "search-1",
            name: "vault.search_notes",
            arguments: '{"query":"Durability","mode":"lexical"}',
          };
        else {
          const evidence = JSON.parse(toolMessages[0].content);
          answer = JSON.stringify(
            evidence.hits?.length
              ? {
                  answer: "**Durability** uses a write-ahead log.",
                  citations: ["Work/Storage.md"],
                  confidence: 0.9,
                  openQuestions: [],
                }
              : { answer: UNGROUNDED_ANSWER, citations: [], confidence: 0, openQuestions: [] },
          );
        }
        const usage = {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
          completion_tokens_details: { reasoning_tokens: 70 },
        };
        if (!input.stream)
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: answer,
                  reasoning_content: "Synthetic private reasoning.",
                },
                finish_reason: "stop",
              },
            ],
            usage,
          });
        const chunks = call
          ? [
              {
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: "Synthetic private reasoning." },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: call.id,
                          type: "function",
                          function: { name: call.name, arguments: call.arguments.slice(0, 8) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: call.arguments.slice(8) } }],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
            ]
          : [
              {
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: "Synthetic private reasoning.", content: answer },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
            ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      await mkdir(join(root, ".notient"));
      await mkdir(join(root, "Work"));
      await writeFile(join(root, "Work/Storage.md"), body);
      await writeFile(join(root, "Private.md"), "Durability secret outside the requested folder.");
      await writeFile(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=answer-test\n`,
      );
      daemon = await startTestDaemon(root);
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await daemonResult(daemon.client, "search.run", {
          query: "Durability",
          mode: "lexical",
          limit: 10,
          scope: { folders: ["Work"] },
        });
        if ((result.hits as unknown[]).length) break;
        if (attempt === 99) throw new Error("structural index did not become ready");
        await Bun.sleep(50);
      }
      const pending = await daemonResult(daemon.client, "pairing.create", {
        label: "answer client",
        kind: "agent",
        scopes: ["read"],
      });
      const credential = await NotientClient.pair(
        String(pending.endpoint),
        String(pending.code),
        String(pending.vaultId),
      );
      const external = new NotientClient({
        endpoint: String(pending.endpoint),
        token: credential.token,
        vaultId: credential.vaultId,
      });
      expect((await external.connect()).operations).toContain("ask.run");
      const input = { query: "What gives storage durability?", scope: { folders: ["Work"] } };
      const http = await external.call("ask.run", input);
      const {
        id: _id,
        type: _type,
        ...socketPayload
      } = await daemonResult(daemon.client, "ask.run", input);
      const socket = askResultSchema.parse(socketPayload);
      expect(http.citations).toEqual(socket.citations);
      expect(http.citations[0].revision).toBe(contentRevision(body));
      expect(http.citations[0].quote).toBe(
        body.slice(http.citations[0].range.start, http.citations[0].range.end),
      );
      expect(http.attempts.length).toBeGreaterThanOrEqual(3);
      expect(http.attempts.every((attempt) => attempt.accounting === "provider-total")).toBe(true);
      expect(http.attempts[0].completion?.usage).toMatchObject({
        reasoningTokens: 70,
        completionTokens: 100,
        visibleAnswerTokens: null,
        nonReasoningCompletionTokens: 30,
        totalTokens: 300,
      });
      expect(JSON.stringify(http)).not.toContain("Synthetic private reasoning");
      const toolRequest = requests.find((input) =>
        input.messages.some((message) => message.role === "tool"),
      );
      expect(toolRequest?.messages.find((message) => message.role === "tool")?.tool_call_id).toBe(
        "search-1",
      );
      expect(JSON.stringify(toolRequest)).not.toContain("secret outside");
      const abstained = await external.call("ask.run", {
        ...input,
        scope: { folders: ["Missing"] },
      });
      expect(abstained.answer).toBe(UNGROUNDED_ANSWER);
      expect(abstained.citations).toEqual([]);
      const controller = new AbortController();
      const cancelled = external
        .call("ask.run", { query: "Wait for cancellation", scope: {} }, controller.signal)
        .catch((error) => error);
      for (let i = 0; i < 100 && !cancellationStarted; i++) await Bun.sleep(20);
      expect(cancellationStarted).toBe(true);
      controller.abort();
      expect((await cancelled).code).toBe("REQUEST_INTERRUPTED");
      for (let i = 0; i < 100 && !providerCancelled; i++) await Bun.sleep(20);
      expect(providerCancelled).toBe(true);
      expect((await external.call("notes.read", { path: "Work/Storage.md" })).body).toBe(body);
      expect(await readFile(join(root, "Work/Storage.md"), "utf8")).toBe(body);
    } finally {
      await daemon?.stop();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  45000,
);
