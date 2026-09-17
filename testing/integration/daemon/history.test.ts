import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotientClient } from "../../../src/api/client";
import { historyListSchema } from "../../../src/api/history";
import { createRpc } from "../../../src/cli/tui/rpc";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] history keeps exact undo receipts across edits, retries and daemon restarts",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-history-api-"));
    const mcp = new Client({ name: "history-check", version: "1.0.0" });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      daemon = await startTestDaemon(root);
      const code = await daemonResult(daemon.client, "pairing.create", {
        label: "History operator",
        kind: "human",
        scopes: ["read", "write", "admin"],
      });
      const credential = await NotientClient.pair(
        String(code.endpoint),
        String(code.code),
        String(code.vaultId),
      );
      const client = new NotientClient({
        endpoint: String(code.endpoint),
        token: credential.token,
        vaultId: credential.vaultId,
      });
      const preview = await client.call("changes.preview", {
        idempotencyKey: "history-create",
        changes: [
          {
            kind: "create",
            path: "Thought.md",
            body: "# Thought\n\nKeep my meaning.\n",
            expected: null,
          },
        ],
      });
      await client.call("changes.apply", {
        previewId: preview.previewId,
        previewRevision: preview.revision,
        idempotencyKey: "apply-history-create",
      });
      const list = await client.call("history.list", { limit: 10 });
      expect(list.entries).toHaveLength(1);
      const id = list.entries[0].id;
      expect(list.entries[0]).toMatchObject({
        undo: null,
        reversible: true,
        clientIdentity: credential.principal.id,
      });
      const detail = await client.call("history.get", { id });
      expect(detail.before).toBeNull();
      expect(detail.after).toBe("# Thought\n\nKeep my meaning.\n");
      expect(await createRpc(daemon.client).historyEntry(id)).toEqual(detail);
      const undo = { id, sources: detail.sources, idempotencyKey: "undo-exact-thought" };
      // A human edit between review and effect must win.
      await Bun.write(join(root, "Thought.md"), "Human changed this.\n");
      await expect(client.call("history.undo", undo)).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await client.call("history.get", { id })).entry.undo).toBeNull();
      expect(await Bun.file(join(root, "Thought.md")).text()).toBe("Human changed this.\n");
      await Bun.write(join(root, "Thought.md"), detail.after ?? "");
      const undone = await client.call("history.undo", undo);
      expect(undone.entry.undo?.completedAt).toBeNumber();
      expect(await Bun.file(join(root, "Thought.md")).exists()).toBe(false);
      expect((await client.call("history.list", { limit: 10 })).entries).toHaveLength(1);
      // After completion, a new human note must never be deleted by a retry.
      await Bun.write(join(root, "Thought.md"), "A fresh human note.\n");
      expect(await client.call("history.undo", undo)).toEqual(undone);
      expect(await Bun.file(join(root, "Thought.md")).text()).toBe("A fresh human note.\n");
      const agentCode = await daemonResult(daemon.client, "pairing.create", {
        label: "History agent",
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
      expect((await agent.call("history.list", { limit: 10 })).entries).toHaveLength(0);
      await expect(agent.call("history.get", { id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(agent.call("history.undo", undo)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "history-reader"],
          env: daemon.env,
        }),
      );
      const catalog = await mcp.listTools();
      expect(catalog.tools.some((tool) => tool.name === "notient_history_entry")).toBe(true);
      const ownHistory = await mcp.callTool({ name: "notient_history", arguments: { limit: 10 } });
      expect(ownHistory.isError).not.toBe(true);
      expect(
        historyListSchema.parse(JSON.parse((ownHistory.content as Array<{ text: string }>)[1].text))
          .entries,
      ).toEqual([]);
      const hiddenHistory = await mcp.callTool({
        name: "notient_history_entry",
        arguments: { id },
      });
      expect(hiddenHistory.isError).toBe(true);
      await mcp.close();
      await daemon.stop();
      daemon = await startTestDaemon(root);
      const rpc = createRpc(daemon.client);
      expect(await rpc.undoHistory(undo)).toEqual(undone);
      expect(await Bun.file(join(root, "Thought.md")).text()).toBe("A fresh human note.\n");
      const child = Bun.spawn(
        [process.execPath, resolve("src/cli/index.ts"), "history", "--vault", root, "--json"],
        { env: daemon.env, stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      expect(output).toContain(id.replaceAll('"', '\\"'));
      expect(output).toContain('"completedAt":');
    } finally {
      await mcp.close().catch(() => {});
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
