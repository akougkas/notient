import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentRevision } from "../../../src/api/notes";
import { inferenceAttemptSchema } from "../../../src/api/pipelines";
import { DEFAULT_NOTIENT_CONFIG } from "../../../src/core/settings/types";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] real chat transport budgets probe, tool analysis and memory; persists accounting and blocks effects after overrun",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-chat-budget-"));
    const body = "# Storage\n\nDurable writes require three replicas.";
    const source = { path: "Storage.md", revision: contentRevision(body) };
    const requests: Array<{ stream?: boolean; max_tokens: number }> = [];
    let overrun = false;
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 100,
      total_tokens: 110,
      completion_tokens_details: { reasoning_tokens: 60 },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "budget-test", state: "loaded" }] });
        const input = (await request.json()) as {
          stream?: boolean;
          max_tokens: number;
          messages: Array<{ role: string; content: string }>;
        };
        requests.push(input);
        if (!input.stream)
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: {
                      text: "The storage policy requires durable replicas.",
                      evidence: [{ note: 0, quote: "Durable writes require three replicas." }],
                    },
                    findings: [],
                    abstention: null,
                  }),
                  reasoning_content: "Never surface private reasoning as an answer.",
                },
                finish_reason: "stop",
              },
            ],
            usage,
          });
        const probe = input.messages.some(
          (message) => message.content === "Call the echo tool with value=ping.",
        );
        const first = !input.messages.some((message) => message.role === "tool");
        const name = probe ? "echo" : overrun ? "notes.create" : "brief.run";
        const args = probe
          ? { value: "ping" }
          : overrun
            ? { notePath: "Must not exist.md", body: "A forbidden over-budget write." }
            : { source, scope: {}, limit: 1 };
        const delta = first
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: probe ? "probe" : "call-domain",
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : {
              content: "Storage requires three durable replicas, as the saved source establishes.",
            };
        const frames = [
          { choices: [{ index: 0, delta }] },
          { choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
          { choices: [], usage: overrun ? { ...usage, total_tokens: 200000 } : usage },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await mkdir(join(root, ".notient"));
      await Bun.write(join(root, source.path), body);
      await Bun.write(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=budget-test\nNOTIENT_CONTEXT_TOKENS=32768\n`,
      );
      const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
      config.chat.budget = {
        modelCalls: 4,
        tokens: 120000,
        durationMs: 10000,
        generationTokens: 1024,
      };
      await Bun.write(join(root, ".notient/config.json"), JSON.stringify(config));
      daemon = await startTestDaemon(root);
      const started = await daemonResult(daemon.client, "chat.start", {
        topic: "Storage briefing",
      });
      const conversationId = (started.conversation as { id: string }).id;
      const frames = [];
      for await (const frame of daemon.client.call("chat.send", {
        conversationId,
        userMessage: "Brief me on Storage",
      }))
        frames.push(frame);
      expect(frames.find((frame) => frame.type === "error")).toBeUndefined();
      expect(frames.at(-1)?.ok).toBe(true);
      const usageFrame = frames.find((frame) => frame.event === "turn:usage");
      expect(usageFrame).toBeDefined();
      const attempts = (usageFrame?.attempts as unknown[]).map((attempt) =>
        inferenceAttemptSchema.parse(attempt),
      );
      expect(attempts).toHaveLength(4);
      expect(attempts.map((attempt) => attempt.chargedTokens)).toEqual([110, 110, 110, 110]);
      expect(attempts.every((attempt) => attempt.generationCeiling === 1024)).toBe(true);
      expect(JSON.stringify(frames)).not.toContain("Never surface private reasoning");
      let memory: Record<string, unknown> | undefined;
      for (let i = 0; i < 100; i++) {
        const page = await daemonResult(daemon.client, "events.subscribe", {});
        memory = (page.events as Array<{ type: string; payload: Record<string, unknown> }>).find(
          (event) => event.type === "chat:usage" && event.payload.phase === "memory",
        )?.payload;
        if (memory) break;
        await Bun.sleep(20);
      }
      expect(memory).toMatchObject({ state: "incomplete", attempts });
      expect(requests).toHaveLength(4); // No post-turn allowance reset.
      overrun = true;
      const failed = [];
      for await (const frame of daemon.client.call("chat.send", {
        conversationId,
        userMessage: "Create a note",
      }))
        failed.push(frame);
      expect(failed.some((frame) => frame.type === "error")).toBe(true);
      expect(
        failed.some(
          (frame) =>
            frame.event === "turn:aborted" && String(frame.reason).includes("token budget"),
        ),
      ).toBe(true);
      expect(await Bun.file(join(root, "Must not exist.md")).exists()).toBe(false);
      expect((await daemonResult(daemon.client, "history.list", {})).entries).toEqual([]);
      expect(await Bun.file(join(root, source.path)).text()).toBe(body);
      await daemon.stop();
      daemon = await startTestDaemon(root);
      const resumed = await daemonResult(daemon.client, "events.subscribe", {});
      expect(
        (resumed.events as Array<{ type: string; payload: unknown }>).some(
          (event) =>
            event.type === "chat:usage" && JSON.stringify(event.payload) === JSON.stringify(memory),
        ),
      ).toBe(true);
    } finally {
      await daemon?.stop();
      server.stop(true);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
