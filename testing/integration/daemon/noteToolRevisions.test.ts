import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { contentRevision } from "../../../src/api/notes";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type Frame = Record<string, unknown>;
type ToolText = { content: Array<{ text: string }>; isError?: boolean };

const bytes = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer());
const utf8 = (text: string) => new TextEncoder().encode(text);

/** One scripted OpenAI-compatible streaming response: a tool call or a final answer. */
function streamed(call: { name: string; args: Record<string, unknown> } | null, id?: string) {
  const delta = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: id ?? `call-${crypto.randomUUID()}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { content: "Done." };
  const frames = [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    // Atomic replacement can briefly hide the path from a concurrent reader.
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] MCP and chat note edits are bound to the read revision and the exact approved preview",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-note-revisions-"));
    const notePath = join(root, "Plan.md");
    const original = "﻿# Plan\r\n\r\n## Notes\r\nfirst\r\n\r\n## Notes\r\nsecond\r\n";
    let nextCall: { name: string; args: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "revision-test", state: "loaded" }] });
        const input = (await request.json()) as {
          stream?: boolean;
          messages: Array<{ role: string; content: unknown }>;
        };
        if (!input.stream)
          return Response.json({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        const probe = input.messages.some(
          (message) => message.content === "Call the echo tool with value=ping.",
        );
        if (probe) return streamed({ name: "echo", args: { value: "ping" } }, "probe");
        return streamed(input.messages.at(-1)?.role === "user" ? nextCall : null);
      },
    });
    const mcp = new Client({ name: "revision-check", version: "1.0.0" });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await mkdir(join(root, ".notient"));
      await Bun.write(notePath, utf8(original));
      await Bun.write(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=revision-test\nNOTIENT_CONTEXT_TOKENS=32768\n`,
      );
      daemon = await startTestDaemon(root);
      const client = daemon.client;
      const historyCount = async () =>
        ((await daemonResult(client, "history.list", { limit: 20 })).entries as unknown[]).length;
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "revision-agent"],
          env: daemon.env,
        }),
      );
      const call = async (name: string, args: Record<string, unknown>) =>
        (await mcp.callTool({ name, arguments: args })) as ToolText;
      const readRevision = async () => {
        const read = await call("notient_read_note", { path: "Plan.md" });
        expect(read.isError).not.toBe(true);
        return (JSON.parse(read.content[1].text) as { note: { revision: string } }).note.revision;
      };

      // The MCP read reports the revision of the exact saved bytes, BOM included.
      const planned = await readRevision();
      expect(planned).toBe(contentRevision(original));

      // Missing revisions and unexpected fields fail before any approval exists.
      const missing = await call("notient_append_note", { path: "Plan.md", text: "x" });
      expect(missing.isError).toBe(true);
      const unexpected = await call("notient_append_note", {
        path: "Plan.md",
        revision: planned,
        text: "x",
        heading: "Notes",
      });
      expect(unexpected.isError).toBe(true);

      // A human edit after the agent's read makes that revision stale.
      const edited = `${original}human line\r\n`;
      await Bun.write(notePath, utf8(edited));
      const stale = await call("notient_append_note", {
        path: "Plan.md",
        revision: planned,
        text: "agent line\r\n",
      });
      expect(stale.isError).toBe(true);
      expect(stale.content[0].text).toStartWith("CONFLICT:");
      expect((await daemonResult(client, "approvals.pending", {})).approvals).toEqual([]);

      // Repeated headings are never guessed.
      const current = await readRevision();
      const ambiguous = await call("notient_replace_section", {
        path: "Plan.md",
        revision: current,
        heading: "Notes",
        body: "agent",
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content[0].text).toContain("occurs 2 times");

      // Edit during approval: the approved preview no longer describes the file.
      const parked = await call("notient_replace_section", {
        path: "Plan.md",
        revision: current,
        heading: "Notes",
        occurrence: 2,
        body: "agent replacement",
      });
      expect(parked.isError).not.toBe(true);
      const receipt = JSON.parse(parked.content[1].text) as { callId: string; preview: string };
      expect(receipt.preview).toContain("--- removed (20 chars)\nsecond\r\nhuman line\r\n");
      expect(receipt.preview).toContain("+++ inserted (19 chars)\nagent replacement\r\n");
      const concurrent = `${edited}second human line\r\n`;
      await Bun.write(notePath, utf8(concurrent));
      await daemonResult(client, "chat.approve", { callId: receipt.callId, approved: true });
      await waitFor(async () => {
        const pending = (await daemonResult(client, "approvals.pending", {}))
          .approvals as unknown[];
        return pending.length === 0 ? true : undefined;
      }, "parked approval to settle");
      await Bun.sleep(100);
      expect(await bytes(notePath)).toEqual(utf8(concurrent));
      expect(await historyCount()).toBe(0);

      // The same bounded change on a fresh read applies exactly and undoes exactly.
      const fresh = await readRevision();
      const approved = await call("notient_replace_section", {
        path: "Plan.md",
        revision: fresh,
        heading: "Notes",
        occurrence: 2,
        body: "agent replacement",
      });
      const approvedReceipt = JSON.parse(approved.content[1].text) as { callId: string };
      await daemonResult(client, "chat.approve", {
        callId: approvedReceipt.callId,
        approved: true,
      });
      const expected = "﻿# Plan\r\n\r\n## Notes\r\nfirst\r\n\r\n## Notes\r\nagent replacement\r\n";
      await waitFor(
        async () =>
          Buffer.from(await bytes(notePath)).equals(Buffer.from(utf8(expected))) ? true : undefined,
        "approved section replacement",
      );
      // The bytes land before the write's history entry is finalized.
      const entry = await waitFor(async () => {
        const listed = await daemonResult(client, "history.list", { limit: 20 });
        return (listed.entries as Array<{ id: string; clientIdentity: string }>)[0];
      }, "history entry for the approved replacement");
      expect(entry.clientIdentity).toBe("revision-agent");
      const detail = await daemonResult(client, "history.get", { id: entry.id });
      await daemonResult(client, "history.undo", {
        id: entry.id,
        sources: detail.sources,
        idempotencyKey: "undo-revision-replacement",
      });
      expect(await bytes(notePath)).toEqual(utf8(concurrent));

      // Chat turns use the same tools: a stale revision is a tool error, and an
      // edit during the blocking approval is refused rather than recomputed.
      const started = await daemonResult(client, "chat.start", { topic: "Revision checks" });
      const conversationId = (started.conversation as { id: string }).id;
      const turn = async (message: string, onPending?: (frame: Frame) => Promise<void>) => {
        const frames: Frame[] = [];
        for await (const frame of client.call("chat.send", {
          conversationId,
          userMessage: message,
        })) {
          frames.push(frame);
          if (frame.event === "loop:approval_pending" && onPending) await onPending(frame);
        }
        return frames;
      };
      nextCall = {
        name: "notes.append",
        args: { notePath: "Plan.md", revision: planned, text: "chat line\r\n" },
      };
      const staleTurn = await turn("Append a chat line");
      const staleError = staleTurn.find((frame) => frame.event === "loop:tool_call_error");
      expect(String(staleError?.error)).toContain("note revision changed");
      expect(staleTurn.some((frame) => frame.event === "loop:approval_pending")).toBe(false);

      nextCall = {
        name: "notes.append",
        args: { notePath: "Plan.md", revision: contentRevision(concurrent), text: "chat line\r\n" },
      };
      const afterChatEdit = `${concurrent}typed during chat approval\r\n`;
      const racedTurn = await turn("Append a chat line", async (frame) => {
        expect(String(frame.preview)).toContain("chat line");
        await Bun.write(notePath, utf8(afterChatEdit));
        void daemonResult(client, "chat.approve", { callId: frame.callId, approved: true });
      });
      const raced = racedTurn.find((frame) => frame.event === "loop:tool_call_result");
      expect(raced?.result).toEqual({
        applied: false,
        reason: "note changed after the approved preview; nothing was written: Plan.md",
      });
      expect(await bytes(notePath)).toEqual(utf8(afterChatEdit));

      nextCall = {
        name: "notes.append",
        args: {
          notePath: "Plan.md",
          revision: contentRevision(afterChatEdit),
          text: "chat line\r\n",
        },
      };
      const appliedTurn = await turn("Append a chat line", async (frame) => {
        void daemonResult(client, "chat.approve", { callId: frame.callId, approved: true });
      });
      expect(
        appliedTurn.find((frame) => frame.event === "loop:tool_call_result")?.result,
      ).toMatchObject({
        applied: true,
        path: "Plan.md",
        sha: contentRevision(`${afterChatEdit}chat line\r\n`),
      });
      expect(await bytes(notePath)).toEqual(utf8(`${afterChatEdit}chat line\r\n`));
    } finally {
      await mcp.close().catch(() => {});
      await daemon?.stop();
      server.stop(true);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
