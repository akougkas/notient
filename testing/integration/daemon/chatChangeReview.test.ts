import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentRevision } from "../../../src/api/notes";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type Frame = Record<string, unknown>;
type Call = { name: string; args: Record<string, unknown> };

/** One scripted OpenAI-compatible streaming response: a tool call or a final answer. */
function streamed(call: Call | null, id?: string) {
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

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] the chat assistant plans canonical changes and only the human's review applies them",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-chat-review-"));
    const idea = "# Idea\n\nKeep drafts small and reviewable. ^claim\n";
    const index = "# Index\n\n- [[Projects/Idea]]\n";
    const text = (path: string) => Bun.file(join(root, path)).text();
    let nextCall: Call | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "review-test", state: "loaded" }] });
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
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await mkdir(join(root, ".notient"));
      await mkdir(join(root, "Projects"));
      await Bun.write(join(root, "Projects/Idea.md"), idea);
      await Bun.write(join(root, "Index.md"), index);
      await Bun.write(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=review-test\nNOTIENT_CONTEXT_TOKENS=32768\n`,
      );
      daemon = await startTestDaemon(root);
      const client = daemon.client;
      const started = await daemonResult(client, "chat.start", { topic: "Archive the idea" });
      const conversationId = (started.conversation as { id: string }).id;
      const turn = async (call: Call, invalid = false) => {
        nextCall = call;
        const frames: Frame[] = [];
        for await (const frame of client.call("chat.send", {
          conversationId,
          userMessage: "Archive the settled idea.",
        }))
          frames.push(frame);
        const failed = frames.find((frame) => frame.type === "error");
        if (failed && !invalid) throw new Error(`chat.send failed: ${JSON.stringify(failed)}`);
        expect(frames.some((frame) => frame.event === "loop:approval_pending")).toBe(false);
        const error =
          frames.find((frame) => frame.event === "loop:tool_call_error") ??
          frames.find((frame) => frame.event === "loop:error");
        const result = frames.find((frame) => frame.event === "loop:tool_call_result");
        return {
          error: error ? String(error.error ?? error.message) : null,
          result: result?.result as Frame,
        };
      };
      const archive = (indexBody: string) => ({
        name: "changes.preview",
        args: {
          changes: [
            {
              kind: "archive",
              source: { path: "Projects/Idea.md", revision: contentRevision(idea) },
              destination: "Archive/Idea.md",
              updateReferences: true,
            },
            {
              kind: "append",
              source: { path: "Index.md", revision: contentRevision(indexBody) },
              text: "\nArchived ideas stay linked.\n",
            },
          ],
        },
      });

      // A model-chosen key or a stale read is a tool error with nothing stored.
      const keyed = await turn(
        {
          name: "changes.preview",
          args: { ...archive(index).args, idempotencyKey: "model-key" },
        },
        true,
      );
      expect(keyed.result).toBeUndefined();
      expect(keyed.error).toContain("idempotencyKey");
      const stale = await turn(archive("# Index\n"));
      expect(stale.error).toContain("note revision changed");

      // The reference-aware archive plan is stored without touching any note.
      const planned = await turn(archive(index));
      expect(planned.error).toBeNull();
      expect(planned.result).toMatchObject({ applied: false, conflicts: [] });
      const effects = planned.result.effects as Array<{ kind: string; path: string }>;
      expect(effects.map((effect) => effect.kind)).toContain("move");
      expect(JSON.stringify(planned.result)).not.toContain("Keep drafts small");
      expect(await text("Projects/Idea.md")).toBe(idea);
      expect(await text("Index.md")).toBe(index);

      const submit = (from: Frame, rationale: string): Call => ({
        name: "changes.submit_for_review",
        args: { previewId: from.previewId, previewRevision: from.previewRevision, rationale },
      });
      const submitted = await turn(submit(planned.result, "The idea is settled."));
      expect(submitted.error).toBeNull();
      expect(submitted.result).toMatchObject({ state: "pending", applied: false });
      const replay = await turn(submit(planned.result, "The idea is settled."));
      expect(replay.result.reviewId).toBe(submitted.result.reviewId);
      expect(await text("Projects/Idea.md")).toBe(idea);

      // The review names the assistant, never the human, as requester.
      const listed = await daemonResult(client, "proposals.list", { limit: 10 });
      expect(listed.proposals).toMatchObject([
        {
          id: submitted.result.reviewId,
          state: "pending",
          provenance: { requestedBy: { id: "assistant:human", kind: "agent" } },
        },
      ]);
      const review = (listed.proposals as Array<Record<string, string>>)[0];

      // The stored preview cannot bypass its review, even for the human.
      await expect(
        daemonResult(client, "changes.apply", {
          previewId: review.previewId,
          previewRevision: review.previewRevision,
          idempotencyKey: "bypass-review",
        }),
      ).rejects.toThrow("PENDING_APPROVAL");

      // A human edit to a reviewed source leaves the review stale and unappliable.
      const editedIndex = `${index}\nHuman note.\n`;
      await Bun.write(join(root, "Index.md"), editedIndex);
      const staleApply = await daemonResult(client, "proposals.approve", {
        id: review.id,
        previewId: review.previewId,
        previewRevision: review.previewRevision,
        idempotencyKey: "human-apply-stale",
      });
      expect(staleApply.state).toBe("conflict");
      expect(await text("Index.md")).toBe(editedIndex);

      // A fresh plan applies only through the human's review, and undoes exactly.
      const replanned = await turn(archive(editedIndex));
      const current = await turn(submit(replanned.result, "Same archive, current index."));
      const pending = await daemonResult(client, "proposals.get", {
        id: current.result.reviewId,
      });
      const proposal = pending.proposal as Record<string, string>;
      const applied = await daemonResult(client, "proposals.approve", {
        id: proposal.id,
        previewId: proposal.previewId,
        previewRevision: proposal.previewRevision,
        idempotencyKey: "human-apply-current",
      });
      expect(applied.state).toBe("applied");
      expect(await Bun.file(join(root, "Projects/Idea.md")).exists()).toBe(false);
      expect(await text("Archive/Idea.md")).toBe(idea);
      const archivedIndex = await text("Index.md");
      expect(archivedIndex).toContain("Human note.");
      expect(archivedIndex).toContain("Archived ideas stay linked.");
      const history = await daemonResult(client, "history.list", { limit: 20 });
      const entries = history.entries as Array<{ id: string; clientIdentity: string }>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.clientIdentity === "assistant:human")).toBe(true);

      // Rejection is durable for the assistant too.
      const retitle = await turn({
        name: "changes.preview",
        args: {
          changes: [
            {
              kind: "edit",
              source: { path: "Index.md", revision: contentRevision(archivedIndex) },
              selector: { kind: "heading", text: "Index" },
              replacement: "# Everything\n",
            },
          ],
        },
      });
      const retitleReview = await turn(submit(retitle.result, "A broader title."));
      const stored = (
        await daemonResult(client, "proposals.get", { id: retitleReview.result.reviewId })
      ).proposal as Record<string, string>;
      await daemonResult(client, "proposals.reject", {
        id: stored.id,
        revision: stored.revision,
        idempotencyKey: "human-reject-retitle",
      });
      const revived = await turn(submit(retitle.result, "A broader title."));
      expect(revived.result).toMatchObject({ reviewId: stored.id, state: "rejected" });
      expect(await text("Index.md")).toBe(archivedIndex);

      // The generic CLI reaches the same catalog operations as a named agent.
      const env = daemon.env;
      const api = async (operation: string, input: Record<string, unknown>) => {
        const child = Bun.spawn(
          [
            process.execPath,
            resolve("src/cli/index.ts"),
            "api",
            operation,
            "--input",
            JSON.stringify(input),
            "--vault",
            root,
            "--as",
            "cli-agent",
            "--ndjson",
          ],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        return { code, frame: JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Frame };
      };
      const cliPreview = await api("changes.preview", {
        idempotencyKey: "cli-note",
        changes: [{ kind: "create", path: "Cli.md", body: "# Cli\n", expected: null }],
      });
      expect(cliPreview.code).toBe(0);
      const cliSubmit = await api("proposals.submit", {
        previewId: cliPreview.frame.previewId,
        previewRevision: cliPreview.frame.revision,
        rationale: "Created from a script.",
        idempotencyKey: "cli-submit",
      });
      expect(cliSubmit.code).toBe(0);
      expect(cliSubmit.frame.proposal).toMatchObject({
        state: "pending",
        provenance: { requestedBy: { id: "cli-agent", kind: "agent" } },
      });
      const cliApprove = await api("proposals.approve", {
        id: (cliSubmit.frame.proposal as Frame).id,
        previewId: cliPreview.frame.previewId,
        previewRevision: cliPreview.frame.revision,
        idempotencyKey: "cli-self-approve",
      });
      expect(cliApprove.code).toBe(1);
      expect(cliApprove.frame.code).toBe("FORBIDDEN");
      expect(await Bun.file(join(root, "Cli.md")).exists()).toBe(false);
      const cliSettings = await api("chat.settings", {});
      expect(cliSettings.frame).toMatchObject({ ok: true, operation: "chat.settings" });
      const cliConfigure = await api("chat.configure", {
        budget: cliSettings.frame.budget,
        revision: cliSettings.frame.revision,
        idempotencyKey: "cli-configure",
      });
      expect(cliConfigure.code).toBe(1);
      expect(cliConfigure.frame.code).toBe("FORBIDDEN");
    } finally {
      await daemon?.stop();
      server.stop(true);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
