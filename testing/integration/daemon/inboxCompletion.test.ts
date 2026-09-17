import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentRevision, inspectMarkdown } from "../../../src/api/notes";
import { jobResultSchema } from "../../../src/api/pipelines";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

const RAFT = "Raft elects one leader per term through randomized election timeouts.";

/** Scripted structured outputs keyed by the pipeline stage's schema name. */
function stageOutput(name: string, documents: Array<{ path?: string }>): unknown {
  const raft = documents.findIndex((document) => document.path === "Inbox/raft.md");
  if (name === "classify_inbox")
    return {
      items: [
        {
          note: raft,
          category: "reference",
          decision: "organize",
          title: "Raft leader election",
          explanation: "A concrete explanation of Raft leader election.",
          evidence: [{ note: raft, quote: RAFT }],
        },
      ],
      abstention: null,
    };
  if (name === "enrich_notes") return { suggestions: [], abstention: "Already concise." };
  return { comparisons: [], abstention: "No related notes." };
}

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] an inbox item is marked processed only by the final effect, after its move succeeds",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-inbox-completion-"));
    const body = `# Raft\n\n${RAFT}\n`;
    const done = "---\nstatus: processed\n---\n# Old\n\nAlready handled.\n";
    const stages: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "inbox-test-model", state: "loaded" }] });
        const input = (await request.json()) as {
          response_format?: { json_schema?: { name?: string } };
          messages: Array<{ role: string; content: string }>;
        };
        const name = input.response_format?.json_schema?.name ?? "";
        stages.push(name);
        // Correction rounds append prose; the document payload stays in an earlier turn.
        const user = input.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => {
            try {
              return [JSON.parse(message.content) as { documents?: Array<{ path?: string }> }];
            } catch {
              return [];
            }
          })[0] ?? { documents: [] };
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(stageOutput(name, user.documents ?? [])),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      },
    });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await mkdir(join(root, ".notient"), { mode: 0o700 });
      await mkdir(join(root, "Inbox"));
      await writeFile(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=inbox-test-model\n`,
        { mode: 0o600 },
      );
      await writeFile(join(root, "Inbox/raft.md"), body);
      await writeFile(join(root, "Inbox/done.md"), done);
      await writeFile(join(root, "Index.md"), "# Index\n\n[[raft]]\n");
      daemon = await startTestDaemon(root);
      const client = daemon.client;
      const settle = async (id: string) => {
        const deadline = performance.now() + 20000;
        while (performance.now() < deadline) {
          const { job } = jobResultSchema.parse(await daemonResult(client, "jobs.get", { id }));
          if (
            ["completed", "awaiting-approval", "cancelled", "failed", "partial"].includes(job.state)
          )
            return job;
          await Bun.sleep(20);
        }
        throw new Error("inbox job did not settle");
      };

      // An already-marked item is not classified again.
      const skipped = await daemonResult(client, "pipelines.run", {
        pipeline: "inbox",
        sources: [{ path: "Inbox/done.md", revision: contentRevision(done) }],
        idempotencyKey: "inbox-done",
        preview: false,
      });
      const skippedJob = await settle(jobResultSchema.parse(skipped).job.id);
      expect(skippedJob.plan?.reason).toContain("already marked status: processed");
      expect(stages).toEqual([]);

      const run = await daemonResult(client, "pipelines.run", {
        pipeline: "inbox",
        sources: [{ path: "Inbox/raft.md", revision: contentRevision(body) }],
        idempotencyKey: "inbox-raft",
        preview: false,
      });
      const job = await settle(jobResultSchema.parse(run).job.id);
      expect(job.state).toBe("awaiting-approval");
      if (!job.previewId || !job.previewRevision) throw new Error("inbox job staged no preview");
      const preview = await daemonResult(client, "changes.get", { previewId: job.previewId });
      const effects = preview.effects as Array<{
        kind: string;
        path: string;
        destination: string | null;
        after: string;
      }>;
      const move = effects.findIndex((effect) => effect.kind === "move");
      const destination = effects[move]?.destination;
      if (!destination) throw new Error("inbox preview has no move");
      expect(destination.startsWith("Notient/notes/")).toBe(true);
      const marker = effects.at(-1);
      expect(marker?.path).toBe(destination);
      expect(move).toBeLessThan(effects.length - 1);
      expect(inspectMarkdown(marker?.after ?? "").frontmatter.properties).toEqual({
        status: "processed",
      });

      // A failed move leaves the item unmarked in the inbox.
      await mkdir(join(root, "Notient/notes"), { recursive: true });
      await writeFile(join(root, destination), "A human note already lives here.\n");
      const review = {
        id: job.proposalIds[0],
        previewId: job.previewId,
        previewRevision: job.previewRevision,
      };
      const blocked = await daemonResult(client, "proposals.approve", {
        ...review,
        idempotencyKey: "apply-blocked",
      });
      expect(blocked.state).not.toBe("applied");
      expect(await readFile(join(root, "Inbox/raft.md"), "utf8")).toBe(body);
      expect(await readFile(join(root, destination), "utf8")).toBe(
        "A human note already lives here.\n",
      );

      // Once the destination is free, the move and then the marker apply.
      await rm(join(root, destination));
      const applied = await daemonResult(client, "proposals.approve", {
        ...review,
        idempotencyKey: "apply-free",
      });
      expect(applied.state).toBe("applied");
      expect(await Bun.file(join(root, "Inbox/raft.md")).exists()).toBe(false);
      const moved = await readFile(join(root, destination), "utf8");
      expect(moved).toBe(`---\nstatus: processed\n---\n${body}`);
    } finally {
      await daemon?.stop();
      server.stop(true);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
