import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { NotientClient } from "../../../src/api/client";
import { createRpc } from "../../../src/cli/tui/rpc";
import { SettingsView } from "../../../src/cli/tui/views/SettingsView";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type Screen = Awaited<ReturnType<typeof testRender>>;
async function frame(screen: Screen, text: string) {
  let rendered = "";
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await Bun.sleep(25);
    });
    await screen.renderOnce();
    rendered = screen.captureCharFrame();
    if (rendered.includes(text)) return rendered;
  }
  throw new Error(`Missing ${text}:\n${rendered}`);
}

const usage = { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 };
function stream(delta: Record<string, unknown>, finish: string) {
  const frames = [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage },
  ];
  return new Response(
    `${frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] chat resource limits are saved by a human administrator and govern the next turn without restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-chat-settings-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "chat-settings-model", state: "loaded" }] });
        requests++;
        const input = (await request.json()) as {
          stream?: boolean;
          messages: Array<{ role: string; content: unknown }>;
        };
        if (!input.stream)
          return Response.json({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            usage,
          });
        const probe = input.messages.some(
          (message) => message.content === "Call the echo tool with value=ping.",
        );
        return probe
          ? stream(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "probe",
                    type: "function",
                    function: { name: "echo", arguments: '{"value":"ping"}' },
                  },
                ],
              },
              "tool_calls",
            )
          : stream({ content: "Notes stay yours." }, "stop");
      },
    });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    try {
      await mkdir(join(root, ".notient"));
      await Bun.write(join(root, "Note.md"), "# Notes stay yours\n");
      await Bun.write(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=chat-settings-model\nNOTIENT_CONTEXT_TOKENS=32768\n`,
      );
      daemon = await startTestDaemon(root);
      const operator = daemon.client;
      const pair = async (kind: "human" | "agent", scopes: string[]) => {
        const code = await daemonResult(operator, "pairing.create", {
          label: `Chat ${kind}`,
          kind,
          scopes,
        });
        const credential = await NotientClient.pair(
          String(code.endpoint),
          String(code.code),
          String(code.vaultId),
        );
        return new NotientClient({
          endpoint: String(code.endpoint),
          token: credential.token,
          vaultId: credential.vaultId,
        });
      };
      const admin = await pair("human", ["read", "write", "admin"]);
      const agent = await pair("agent", ["read", "write"]);
      const conversationId = (
        (await daemonResult(operator, "chat.start", { topic: "Limits" })).conversation as {
          id: string;
        }
      ).id;
      const turn = async () => {
        const frames: Array<Record<string, unknown>> = [];
        for await (const frame of operator.call("chat.send", {
          conversationId,
          userMessage: "Say something short",
        }))
          frames.push(frame);
        return frames;
      };
      expect((await turn()).some((frame) => frame.event === "turn:aborted")).toBe(false);

      const current = await agent.call("chat.settings", {});
      const tighter = { ...current.budget, tokens: 1024 };
      const request = { budget: tighter, revision: current.revision, idempotencyKey: "tighten" };
      await expect(agent.call("chat.configure", request)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const saved = await admin.call("chat.configure", request);
      expect(saved).toMatchObject({ budget: { tokens: 1024 }, replayed: false });
      expect((await admin.call("chat.configure", request)).replayed).toBe(true);
      await expect(
        admin.call("chat.configure", { ...request, idempotencyKey: "stale" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        JSON.parse(await readFile(join(root, ".notient/config.json"), "utf8")).chat.budget.tokens,
      ).toBe(1024);

      // No restart: the next turn is bounded by the saved limit.
      const bounded = await turn();
      expect(
        bounded.some(
          (frame) => frame.event === "turn:aborted" && /budget/i.test(String(frame.reason)),
        ),
      ).toBe(true);

      // The terminal Preferences screen edits the same authority.
      const rpc = createRpc(operator);
      await act(async () => {
        screen = await testRender(
          <SettingsView
            rpc={() => rpc}
            width={90}
            height={30}
            onClose={() => {}}
            onExit={() => {}}
          />,
          { width: 90, height: 30 },
        );
      });
      if (!screen) throw new Error("Preferences did not mount");
      const mounted = screen;
      await frame(mounted, "12 calls · 1024 tokens");
      for (let i = 0; i < 7; i++)
        await act(async () => {
          mounted.mockInput.pressArrow("down");
        });
      await act(async () => {
        mounted.mockInput.pressEnter();
      });
      await frame(mounted, "Tokens per turn");
      await act(async () => {
        mounted.mockInput.pressArrow("down");
      });
      await act(async () => {
        mounted.mockInput.pressEnter();
      });
      await frame(mounted, "Ctrl+S keep value");
      await act(async () => {
        mounted.mockInput.pressKey("a", { ctrl: true });
        await mounted.mockInput.typeText("160000");
      });
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(mounted, "Unsaved change");
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(mounted, "Tokens per turn: 1024 → 160000 tokens");
      expect((await rpc.chatSettings()).budget.tokens).toBe(1024);
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(mounted, "The next chat turn uses these limits");
      expect((await rpc.chatSettings()).budget.tokens).toBe(160000);
      expect((await turn()).some((frame) => frame.event === "turn:aborted")).toBe(false);
      expect(requests).toBeGreaterThan(0);
    } finally {
      if (screen) {
        const closing = screen;
        await act(async () => {
          closing.renderer.destroy();
        });
      }
      await daemon?.stop();
      server.stop(true);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
