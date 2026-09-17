import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotientClient } from "../../../src/api/client";
import { type PipelineJob, jobListSchema, jobResultSchema } from "../../../src/api/pipelines";
import { createRpc } from "../../../src/cli/tui/rpc";
import { dispatchSlashCommand } from "../../../src/cli/tui/slashCommands";
import { connect } from "../../../src/core/db/surreal";
import { JobStore } from "../../../src/core/pipelines/jobStore";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";
import { pipelineJobFixture } from "../../pipelineJobFixture";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] durable job inspection agrees across HTTP, CLI, TUI, MCP and actual daemon restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-jobs-api-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const mcp = new Client({ name: "job-inspection-test", version: "1" });
    try {
      daemon = await startTestDaemon(root);
      // Seed a persisted failure fixture through the same store, without enabling
      // background execution. This test exercises inspection, not model quality.
      const db = await connect({
        url: `ws://127.0.0.1:${(await readFile(vaultPortPath(root), "utf8")).trim()}/rpc`,
        user: "root",
        pass: (await readFile(vaultSecretPath(root), "utf8")).trim(),
        namespace: "notient",
        database: "vault",
      });
      let stored: PipelineJob;
      try {
        stored = await new JobStore(db.db).create(pipelineJobFixture());
      } finally {
        await db.close();
      }
      const ipc = jobResultSchema.parse(
        await daemonResult(daemon.client, "jobs.get", { id: stored.id }),
      );
      const page = jobListSchema.parse(await daemonResult(daemon.client, "jobs.list"));
      expect(page.jobs[0]?.id).toBe(stored.id);
      expect(page.jobs[0]?.failure?.code).toBe("INFERENCE_UNAVAILABLE");
      expect((await createRpc(daemon.client).job(stored.id)).job).toEqual(ipc.job);
      const shown = await dispatchSlashCommand(`/job ${stored.id}`, {
        client: daemon.client,
        vaultPath: root,
      });
      expect(shown.message).toContain("INFERENCE_UNAVAILABLE");
      expect(shown.message).toContain("Reasoning endpoint unreachable");
      const paired = await daemonResult(daemon.client, "pairing.create", {
        label: "job inspector",
        kind: "agent",
        scopes: ["read"],
      });
      const credential = await NotientClient.pair(
        String(paired.endpoint),
        String(paired.code),
        String(paired.vaultId),
      );
      const http = new NotientClient({
        endpoint: String(paired.endpoint),
        token: credential.token,
        vaultId: credential.vaultId,
      });
      expect(await http.call("jobs.get", { id: stored.id })).toEqual(ipc);
      expect(await http.call("jobs.list", {})).toEqual(page);
      await expect(
        http.call("jobs.get", { id: "018f05cd-3f7b-7000-8000-000000000002" }),
      ).rejects.toThrow("job does not exist");
      const cli = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "jobs",
          "get",
          stored.id,
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
      expect(JSON.parse(stdout).job).toEqual(ipc.job);
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "codex"],
          env: daemon.env,
          cwd: tmpdir(),
          stderr: "pipe",
        }),
      );
      const result = await mcp.callTool({ name: "notient_get_job", arguments: { id: stored.id } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("INFERENCE_UNAVAILABLE");
      await mcp.close();
      await daemon.stop();
      daemon = undefined;
      daemon = await startTestDaemon(root);
      expect(
        jobResultSchema.parse(await daemonResult(daemon.client, "jobs.get", { id: stored.id })),
      ).toEqual(ipc);
      expect(jobListSchema.parse(await daemonResult(daemon.client, "jobs.list"))).toEqual(page);
    } finally {
      await mcp.close();
      await daemon?.stop();
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  60000,
);

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] job controls share authority and durable receipts across HTTP, CLI, TUI, MCP and restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-job-controls-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const mcp = new Client({ name: "job-control-test", version: "1" });
    try {
      daemon = await startTestDaemon(root);
      const operatorClient = daemon.client;
      const pair = async (scopes: string[]) => {
        const pending = await daemonResult(operatorClient, "pairing.create", {
          label: "job controller",
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
      const db = await connect({
        url: `ws://127.0.0.1:${(await readFile(vaultPortPath(root), "utf8")).trim()}/rpc`,
        user: "root",
        pass: (await readFile(vaultSecretPath(root), "utf8")).trim(),
        namespace: "notient",
        database: "vault",
      });
      let jobs: PipelineJob[];
      try {
        const store = new JobStore(db.db);
        jobs = await Promise.all(
          [
            writer.credential.principal,
            ...Array(3).fill({ id: "codex", kind: "agent", scopes: ["read", "write"] }),
          ].map((caller) =>
            store.create(
              pipelineJobFixture({ id: randomUUID(), state: "paused", stage: "paused", caller }),
            ),
          ),
        );
      } finally {
        await db.close();
      }
      const request = (job: PipelineJob) => ({
        id: job.id,
        action: "cancel" as const,
        revision: job.revision,
        idempotencyKey: `cancel-${job.id}`,
      });
      const httpRequest = request(jobs[0]);
      await expect(reader.client.call("jobs.control", httpRequest)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(writer.client.call("jobs.control", request(jobs[1]))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const receipt = await writer.client.call("jobs.control", httpRequest);
      expect(receipt.job.state).toBe("cancelled");
      expect(await writer.client.call("jobs.control", httpRequest)).toEqual(receipt);
      const cli = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "jobs",
          "cancel",
          jobs[1].id,
          "--revision",
          jobs[1].revision,
          "--idempotency-key",
          request(jobs[1]).idempotencyKey,
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
      expect(JSON.parse(stdout).job.state).toBe("cancelled");
      const shown = await dispatchSlashCommand(
        `/job ${jobs[2].id} cancel ${jobs[2].revision} ${request(jobs[2]).idempotencyKey}`,
        { client: daemon.client, vaultPath: root },
      );
      expect(shown.message).toContain("cancel accepted: cancelled");
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "codex"],
          env: daemon.env,
          cwd: tmpdir(),
          stderr: "pipe",
        }),
      );
      const result = await mcp.callTool({
        name: "notient_control_job",
        arguments: request(jobs[3]),
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("cancelled");
      await mcp.close();
      await daemon.stop();
      daemon = undefined;
      daemon = await startTestDaemon(root);
      const endpoint = (await daemonResult(daemon.client, "pairing.list")).endpoint;
      const resumed = new NotientClient({
        endpoint: String(endpoint),
        token: writer.credential.token,
        vaultId: writer.credential.vaultId,
      });
      expect(await resumed.call("jobs.control", httpRequest)).toEqual(receipt);
      expect((await resumed.call("jobs.get", { id: jobs[0].id })).job.state).toBe("cancelled");
      await daemonResult(daemon.client, "pairing.revoke", { id: writer.credential.credentialId });
      await expect(resumed.call("jobs.control", httpRequest)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      await mcp.close();
      await daemon?.stop();
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  60000,
);
