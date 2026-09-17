import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import type { ChangeSet } from "../../../src/api/operations";
import { createRpc } from "../../../src/cli/tui/rpc";
import { ReviewView } from "../../../src/cli/tui/views/ReviewView";
import { saveReview } from "../../../src/core/approvals/reviewStorage";
import { connect } from "../../../src/core/db/surreal";
import { JobStore } from "../../../src/core/pipelines/jobStore";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";
import { pipelineJobFixture } from "../../pipelineJobFixture";

type Screen = Awaited<ReturnType<typeof testRender>>;
async function frame(screen: Screen, text: string) {
  let last = "";
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await Bun.sleep(30);
    });
    await screen.renderOnce();
    last = screen.captureCharFrame();
    if (last.includes(text)) return last;
  }
  throw new Error(`Review did not show ${text}:\n${last}`);
}

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] review authority and exact decisions agree across HTTP, terminal, MCP and restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-reviews-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let db: Awaited<ReturnType<typeof connect>> | undefined;
    let screen: Screen | undefined;
    const mcp = new Client({ name: "review-test", version: "1" });
    try {
      await Bun.write(join(root, "Garden.md"), "# Garden\n\nKeep evidence with decisions.\n");
      daemon = await startTestDaemon(root);
      const pair = async (kind: "human" | "agent", scopes: string[]) => {
        const code = await daemonResult(daemon!.client, "pairing.create", {
          label: `Review ${kind}`,
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
      const human = await pair("human", ["read", "write"]);
      const agent = await pair("agent", ["read", "write"]);
      db = await connect({
        url: `ws://127.0.0.1:${(await readFile(vaultPortPath(root), "utf8")).trim()}/rpc`,
        user: "root",
        pass: (await readFile(vaultSecretPath(root), "utf8")).trim(),
        namespace: "notient",
        database: "vault",
      });
      const saved = await human.call("notes.read", { path: "Garden.md" });
      const note = await human.call("notes.read", {
        ...saved.note,
        selector: { kind: "range", start: 10, end: 39 },
      });
      if (!note.selected) throw new Error("Missing source evidence");
      const seed = async (key: string, changes: ChangeSet["changes"], createdAt: number) => {
        const preview = await human.call("changes.preview", { idempotencyKey: key, changes });
        const jobId = randomUUID();
        const proposal = await saveReview(
          db!.db,
          {
            id: contentRevision(key),
            revision: "0".repeat(64),
            state: "pending",
            previewId: preview.previewId,
            previewRevision: preview.revision,
            edgeIds: [],
            provenance: {
              pipeline: "enrich",
              jobId,
              configurationRevision: "b".repeat(64),
              sources: [note.note],
              evidence: [note.selected!],
              rationale: "Keep **evidence** with each recorded decision.",
              score: null,
            },
            createdAt,
            decidedAt: null,
            decidedBy: null,
            appliedHistory: [],
          },
          null,
        );
        await new JobStore(db!.db).create(
          pipelineJobFixture({
            id: jobId,
            state: "completed",
            stage: "completed",
            previewId: preview.previewId,
            previewRevision: preview.revision,
            proposalIds: [proposal.id],
            sourceRevisions: [note.note],
            failure: null,
          }),
        );
        return { proposal, preview, jobId };
      };
      const first = await seed(
        "first-review",
        [{ kind: "append", source: note.note, text: "\nReviewed insight.\n" }],
        200,
      );
      const second = await seed(
        "second-review",
        [{ kind: "create", path: "Other.md", expected: null, body: "# Other\n" }],
        100,
      );
      const page = await human.call("proposals.list", { limit: 1 });
      expect(page.proposals[0].id).toBe(first.proposal.id);
      expect(
        (await human.call("proposals.list", { limit: 1, cursor: page.nextCursor! })).proposals[0]
          .id,
      ).toBe(second.proposal.id);
      await expect(
        human.call("proposals.list", { limit: 1, state: "pending", cursor: page.nextCursor! }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const request = {
        id: first.proposal.id,
        previewId: first.preview.previewId,
        previewRevision: first.preview.revision,
        idempotencyKey: "approve-first",
      };
      await expect(agent.call("proposals.approve", request)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        human.call("changes.apply", {
          previewId: first.preview.previewId,
          previewRevision: first.preview.revision,
          idempotencyKey: "bypass",
        }),
      ).rejects.toMatchObject({ code: "PENDING_APPROVAL" });
      expect((await createRpc(daemon.client).review(first.proposal.id)).proposal).toEqual(
        (await agent.call("proposals.get", { id: first.proposal.id })).proposal,
      );
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "codex"],
          env: daemon.env,
          cwd: tmpdir(),
          stderr: "pipe",
        }),
      );
      const tool = await mcp.callTool({
        name: "notient_get_review",
        arguments: { id: first.proposal.id },
      });
      expect(tool.isError).not.toBe(true);
      expect(JSON.stringify(tool.content)).toContain(first.proposal.previewId);
      await mcp.close();
      const rpc = createRpc(daemon.client);
      await act(async () => {
        screen = await testRender(
          <ReviewView
            rpc={() => rpc}
            width={80}
            height={28}
            active
            onRequests={() => {}}
            onOpen={() => {}}
            onClose={() => {}}
          />,
          { width: 80, height: 28 },
        );
      });
      if (!screen) throw new Error("Review did not mount");
      await frame(screen, "Garden.md");
      await act(async () => {
        screen!.mockInput.pressEnter();
      });
      await frame(screen, "Keep evidence");
      await act(async () => {
        screen!.mockInput.pressKey("2");
      });
      await frame(screen, "Reviewed insight.");
      await act(async () => {
        screen!.mockInput.pressKey("a");
      });
      await frame(screen, "Press a again");
      expect(await Bun.file(join(root, "Garden.md")).text()).toBe(note.body);
      await act(async () => {
        screen!.mockInput.pressKey("a");
      });
      await frame(screen, "applied");
      expect(await Bun.file(join(root, "Garden.md")).text()).toContain("Reviewed insight.");
      expect((await human.call("jobs.get", { id: first.jobId })).job.stage).toBe(
        "reviewed-and-applied",
      );
      const receipt = await human.call("proposals.approve", request);
      expect(receipt.state).toBe("applied");
      await Bun.write(join(root, "Garden.md"), `${note.body}\nOwner keeps editing.\n`);
      expect(await human.call("proposals.approve", request)).toEqual(receipt);
      expect((await human.call("proposals.get", { id: second.proposal.id })).proposal.state).toBe(
        "stale",
      );
      const rejection = {
        id: second.proposal.id,
        revision: second.proposal.revision,
        idempotencyKey: "reject-second",
      };
      expect((await human.call("proposals.reject", rejection)).proposal.state).toBe("rejected");
      expect((await human.call("jobs.get", { id: second.jobId })).job.stage).toBe(
        "review-rejected",
      );
      await expect(
        human.call("proposals.approve", {
          ...request,
          id: second.proposal.id,
          previewId: second.preview.previewId,
          previewRevision: second.preview.revision,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        human.call("changes.apply", {
          previewId: second.preview.previewId,
          previewRevision: second.preview.revision,
          idempotencyKey: "apply-rejected",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await act(async () => {
        screen!.renderer.destroy();
      });
      screen = undefined;
      await db.close();
      db = undefined;
      await daemon.stop();
      daemon = await startTestDaemon(root);
      expect(await human.call("proposals.approve", request)).toEqual(receipt);
      expect((await human.call("proposals.reject", rejection)).proposal.state).toBe("rejected");
      expect(await Bun.file(join(root, "Other.md")).exists()).toBe(false);
      expect(await Bun.file(join(root, "Garden.md")).text()).toContain("Owner keeps editing.");
    } finally {
      if (screen)
        await act(async () => {
          screen!.renderer.destroy();
        });
      await mcp.close();
      await db?.close();
      await daemon?.stop();
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  60000,
);
