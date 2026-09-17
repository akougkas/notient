import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { jobResultSchema } from "../../../src/api/pipelines";
import { dispatchSlashCommand } from "../../../src/cli/tui/slashCommands";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] live pipelines execute through every client and revocation cancels detached inference",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-pipelines-api-"));
    const body =
      "# Storage\n\nWrite-ahead logging preserves committed transactions after a crash.\n";
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let calls = 0;
    let hold: Promise<void> | undefined;
    let release: (() => void) | undefined;
    const mcp = new Client({ name: "pipeline-test", version: "1" });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET")
          return Response.json({ data: [{ id: "pipeline-test-model", state: "loaded" }] });
        calls++;
        if (hold) await hold;
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "Synthetic reasoning remains separate.",
                content: JSON.stringify({
                  suggestions: [
                    {
                      note: 0,
                      summary: "",
                      tags: ["durability"],
                      aliases: [],
                      reason: "The note describes crash recovery.",
                      evidence: [
                        {
                          note: 0,
                          quote:
                            "Write-ahead logging preserves committed transactions after a crash.",
                        },
                      ],
                    },
                  ],
                  abstention: null,
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 350,
            total_tokens: 550,
            completion_tokens_details: { reasoning_tokens: 250 },
          },
        });
      },
    });
    try {
      await mkdir(join(root, ".notient"), { mode: 0o700 });
      await writeFile(
        join(root, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=pipeline-test-model\n`,
        { mode: 0o600 },
      );
      await writeFile(join(root, "Storage.md"), body);
      daemon = await startTestDaemon(root);
      const operatorClient = daemon.client;
      const pair = async (scopes: string[]) => {
        const pending = await daemonResult(operatorClient, "pairing.create", {
          label: "pipeline client",
          kind: "agent",
          scopes,
        });
        const credential = await NotientClient.pair(
          String(pending.endpoint),
          String(pending.code),
          String(pending.vaultId),
        );
        return {
          credential,
          client: new NotientClient({
            endpoint: String(pending.endpoint),
            token: credential.token,
            vaultId: credential.vaultId,
          }),
        };
      };
      const writer = await pair(["read", "write"]);
      const reader = await pair(["read"]);
      const listed = await reader.client.call("pipelines.list", {});
      expect(listed.pipelines).toHaveLength(7);
      expect(listed.pipelines.every((pipeline) => !pipeline.policy.enabled)).toBe(true);
      const sources = [{ path: "Storage.md", revision: contentRevision(body) }];
      const input = {
        pipeline: "enrich" as const,
        sources,
        idempotencyKey: "http-run",
        preview: false,
      };
      await expect(reader.client.call("pipelines.run", input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        writer.client.call("pipelines.run", {
          ...input,
          sources: [{ ...sources[0], revision: "0".repeat(64) }],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const [one, two] = await Promise.all([
        writer.client.call("pipelines.run", input),
        writer.client.call("pipelines.run", input),
      ]);
      expect(one.job.id).toBe(two.job.id);
      const settled = async (id: string) => {
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          const { job } = jobResultSchema.parse(
            await daemonResult(operatorClient, "jobs.get", { id }),
          );
          if (
            ["completed", "awaiting-approval", "cancelled", "failed", "partial"].includes(job.state)
          )
            return job;
          await Bun.sleep(10);
        }
        throw new Error("pipeline did not settle");
      };
      const completed = await settled(one.job.id);
      expect(completed.state).toBe("awaiting-approval");
      expect(completed.plan?.findings[0].evidence[0].quote).toBe(
        "Write-ahead logging preserves committed transactions after a crash.",
      );
      expect(completed.proposalIds).toHaveLength(1);
      expect(completed.attempts[0].chargedTokens).toBe(550);
      expect(calls).toBe(1);
      const cli = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "pipelines",
          "run",
          "enrich",
          "--sources",
          JSON.stringify(sources),
          "--preview",
          "--idempotency-key",
          "codex-run",
          "--vault",
          root,
          "--as",
          "codex",
          "--ndjson",
        ],
        { env: daemon.env, cwd: tmpdir(), stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(cli.stdout).text();
      expect(await cli.exited).toBe(0);
      const cliJob = jobResultSchema.parse(JSON.parse(stdout)).job;
      expect((await settled(cliJob.id)).state).toBe("completed");
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "codex"],
          env: daemon.env,
          cwd: tmpdir(),
          stderr: "pipe",
        }),
      );
      const mcpList = await mcp.callTool({ name: "notient_list_pipelines", arguments: {} });
      expect(mcpList.isError).not.toBe(true);
      const replay = await mcp.callTool({
        name: "notient_run_pipeline",
        arguments: { ...input, idempotencyKey: "codex-run", preview: true },
      });
      expect(replay.isError).not.toBe(true);
      expect(JSON.stringify(replay.content)).toContain(cliJob.id);
      expect(calls).toBe(2);
      const tui = await dispatchSlashCommand(
        `/pipeline ${JSON.stringify({ ...input, idempotencyKey: "tui-run", preview: true })}`,
        { client: operatorClient, vaultPath: root },
      );
      expect(tui.message).toContain("enrich job");
      const id = tui.message.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
      if (!id) throw new Error("TUI did not return a job identity");
      expect((await settled(id)).state).toBe("completed");
      expect(await readFile(join(root, "Storage.md"), "utf8")).toBe(body);
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const priorCalls = calls;
      const detached = await writer.client.call("pipelines.run", {
        ...input,
        idempotencyKey: "revoke-detached",
      });
      const deadline = performance.now() + 5000;
      while (calls === priorCalls && performance.now() < deadline) await Bun.sleep(5);
      expect(calls).toBe(priorCalls + 1);
      await daemonResult(operatorClient, "pairing.revoke", { id: writer.credential.credentialId });
      const revoked = await settled(detached.job.id);
      expect(revoked).toMatchObject({ state: "cancelled", effects: null, proposalIds: [] });
      expect(revoked.attempts[0].chargedTokens).toBeGreaterThan(0);
      expect(await readFile(join(root, "Storage.md"), "utf8")).toBe(body);
    } finally {
      release?.();
      await mcp.close();
      await daemon?.stop();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  60000,
);
