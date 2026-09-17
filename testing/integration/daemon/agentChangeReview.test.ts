import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type ToolText = { content: Array<{ text: string }>; isError?: boolean };

const text = async (path: string) =>
  Buffer.from(await Bun.file(path).arrayBuffer()).toString("utf8");

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] an agent previews and submits exact changes that only the human can apply or reject",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-agent-review-"));
    const mcp = new Client({ name: "agent-review", version: "1.0.0" });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const idea = "# Idea\n\nKeep drafts small. ^claim\n";
    const index = "# Index\n\nSee [[Idea]] for the claim.\n";
    try {
      await mkdir(join(root, "Projects"), { recursive: true });
      await Bun.write(join(root, "Projects/Idea.md"), idea);
      await Bun.write(join(root, "Index.md"), index);
      daemon = await startTestDaemon(root);
      const client = daemon.client;
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "review-agent"],
          env: daemon.env,
        }),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await mcp.callTool({ name, arguments: args })) as ToolText;
        return { result, payload: result.isError ? null : JSON.parse(result.content[1].text) };
      };
      const previewMove = async (key: string, indexBody: string) =>
        call("notient_preview_changes", {
          idempotencyKey: key,
          changes: [
            {
              kind: "edit",
              source: { path: "Projects/Idea.md", revision: contentRevision(idea) },
              selector: { kind: "block", id: "claim" },
              replacement: "Keep drafts small and reviewable. ^claim",
            },
            {
              kind: "move",
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
        });

      const first = await previewMove("archive-idea", index);
      expect(first.result.isError).not.toBe(true);
      expect(first.result.content[0].text).toContain("No note bytes changed");
      expect(first.payload.conflicts).toEqual([]);
      expect(await text(join(root, "Projects/Idea.md"))).toBe(idea);

      const submitted = await call("notient_submit_change", {
        previewId: first.payload.previewId,
        previewRevision: first.payload.revision,
        rationale: "The idea is settled; archive it and keep the index link valid.",
        idempotencyKey: "submit-archive-idea",
      });
      expect(submitted.result.isError).not.toBe(true);
      const review = submitted.payload.proposal;
      expect(review).toMatchObject({
        state: "pending",
        previewId: first.payload.previewId,
        provenance: { requestedBy: { id: "review-agent", kind: "agent" } },
      });
      expect(review.provenance.sources.map((source: { path: string }) => source.path)).toEqual([
        "Projects/Idea.md",
        "Index.md",
      ]);
      // Exact replay converges on the same review.
      const replay = await call("notient_submit_change", {
        previewId: first.payload.previewId,
        previewRevision: first.payload.revision,
        rationale: "The idea is settled; archive it and keep the index link valid.",
        idempotencyKey: "submit-archive-idea",
      });
      expect(replay.payload.proposal.id).toBe(review.id);

      // The agent cannot apply its own preview or approve the review.
      const agentCode = await daemonResult(client, "pairing.create", {
        label: "Review agent",
        kind: "agent",
        scopes: ["read", "write"],
      });
      const agentCredential = await NotientClient.pair(
        String(agentCode.endpoint),
        String(agentCode.code),
        String(agentCode.vaultId),
      );
      const agent = new NotientClient({
        endpoint: String(agentCode.endpoint),
        token: agentCredential.token,
        vaultId: agentCredential.vaultId,
      });
      await expect(
        agent.call("proposals.approve", {
          id: review.id,
          previewId: review.previewId,
          previewRevision: review.previewRevision,
          idempotencyKey: "agent-self-approve",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        daemonResult(client, "changes.apply", {
          previewId: review.previewId,
          previewRevision: review.previewRevision,
          idempotencyKey: "bypass-review",
        }),
      ).rejects.toThrow("PENDING_APPROVAL");
      expect(await text(join(root, "Projects/Idea.md"))).toBe(idea);

      // A human edit to a reviewed source makes the review stale and unappliable.
      const editedIndex = `${index}\nHuman note.\n`;
      await Bun.write(join(root, "Index.md"), editedIndex);
      const listed = await daemonResult(client, "proposals.list", { limit: 10 });
      expect(listed.proposals).toMatchObject([{ id: review.id, state: "stale" }]);
      const staleApply = await daemonResult(client, "proposals.approve", {
        id: review.id,
        previewId: review.previewId,
        previewRevision: review.previewRevision,
        idempotencyKey: "human-apply-stale",
      });
      expect(staleApply.state).toBe("conflict");
      expect(await text(join(root, "Index.md"))).toBe(editedIndex);
      expect(await Bun.file(join(root, "Archive/Idea.md")).exists()).toBe(false);

      // A fresh preview over the current bytes applies only after the human applies it.
      const second = await previewMove("archive-idea-2", editedIndex);
      const resubmitted = await call("notient_submit_change", {
        previewId: second.payload.previewId,
        previewRevision: second.payload.revision,
        rationale: "Same archive over the current index.",
        idempotencyKey: "submit-archive-idea-2",
      });
      const current = resubmitted.payload.proposal;
      expect(current.id).not.toBe(review.id);
      const applied = await daemonResult(client, "proposals.approve", {
        id: current.id,
        previewId: current.previewId,
        previewRevision: current.previewRevision,
        idempotencyKey: "human-apply-current",
      });
      expect(applied.state).toBe("applied");
      expect(await Bun.file(join(root, "Projects/Idea.md")).exists()).toBe(false);
      expect(await text(join(root, "Archive/Idea.md"))).toBe(
        "# Idea\n\nKeep drafts small and reviewable. ^claim\n",
      );
      const archivedIndex = await text(join(root, "Index.md"));
      expect(archivedIndex).toContain("Human note.");
      expect(archivedIndex).toContain("Archived ideas stay linked.");
      expect(archivedIndex).not.toBe(editedIndex);
      const history = await daemonResult(client, "history.list", { limit: 20 });
      expect(
        (history.entries as Array<{ clientIdentity: string }>).every(
          (entry) => entry.clientIdentity === "review-agent",
        ),
      ).toBe(true);
      const agentView = await call("notient_get_review", { id: current.id });
      expect(agentView.payload.proposal.state).toBe("approved");

      // Rejection is durable; resubmitting the same preview cannot revive it.
      const note = await call("notient_read_note", { path: "Index.md" });
      const third = await call("notient_preview_changes", {
        idempotencyKey: "retitle-index",
        changes: [
          {
            kind: "edit",
            source: { path: "Index.md", revision: note.payload.note.revision },
            selector: { kind: "heading", text: "Index" },
            replacement: "# Everything\n",
          },
        ],
      });
      const rejectedReview = (
        await call("notient_submit_change", {
          previewId: third.payload.previewId,
          previewRevision: third.payload.revision,
          rationale: "A broader title.",
          idempotencyKey: "submit-retitle",
        })
      ).payload.proposal;
      await daemonResult(client, "proposals.reject", {
        id: rejectedReview.id,
        revision: rejectedReview.revision,
        idempotencyKey: "human-reject-retitle",
      });
      const revived = await call("notient_submit_change", {
        previewId: third.payload.previewId,
        previewRevision: third.payload.revision,
        rationale: "Please reconsider.",
        idempotencyKey: "submit-retitle-again",
      });
      expect(revived.payload.proposal).toMatchObject({ id: rejectedReview.id, state: "rejected" });
      expect(await text(join(root, "Index.md"))).toBe(archivedIndex);

      // Another caller cannot submit a preview it does not own.
      await expect(
        agent.call("proposals.submit", {
          previewId: third.payload.previewId,
          previewRevision: third.payload.revision,
          rationale: "Not mine.",
          idempotencyKey: "foreign-submit",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await mcp.close().catch(() => {});
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
