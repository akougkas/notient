import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotientClient } from "../../../src/api/client";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] undo reports editor veto and rechecks authority after host acknowledgement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-history-host-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      daemon = await startTestDaemon(root);
      const pair = async (label: string, scopes: string[]) => {
        const code = await daemonResult(daemon!.client, "pairing.create", {
          label,
          kind: "human",
          scopes,
        });
        const credential = await NotientClient.pair(
          String(code.endpoint),
          String(code.code),
          String(code.vaultId),
        );
        return {
          credential,
          client: new NotientClient({
            endpoint: String(code.endpoint),
            vaultId: credential.vaultId,
            token: credential.token,
          }),
        };
      };
      const operator = await pair("Undo operator", ["read", "write", "admin"]);
      const { client } = operator;
      const preview = await client.call("changes.preview", {
        idempotencyKey: "create",
        changes: [
          { kind: "create", path: "Thought.md", body: "Original thought.\n", expected: null },
        ],
      });
      const applied = await client.call("changes.apply", {
        previewId: preview.previewId,
        previewRevision: preview.revision,
        idempotencyKey: "apply",
      });
      const id = applied.effects[0].historyId!;
      const detail = await client.call("history.get", { id });
      const undo = { id, sources: detail.sources, idempotencyKey: "guarded-undo" };
      const { client: host } = await pair("Editor", ["read", "host"]);
      const attached = await host.call("host.attach", {
        instanceId: crypto.randomUUID(),
        label: "Editor",
      });
      const command = async () => {
        for (let i = 0; i < 100; i++) {
          const page = await host.call("host.poll", { sessionId: attached.sessionId });
          if (page.commands.length) return page.commands[0];
          await Bun.sleep(30);
        }
        throw new Error("No undo guard");
      };
      const denied = client.call("history.undo", undo).catch((error) => error);
      const first = await command();
      expect(first.kind).toBe("guard");
      await host.call("host.reply", {
        sessionId: attached.sessionId,
        commandId: first.id,
        result: { kind: "guard", allowed: false, reason: "Unsaved Obsidian edits in Thought.md" },
      });
      expect(await denied).toMatchObject({
        code: "CONFLICT",
        message: "Unsaved Obsidian edits in Thought.md",
      });
      expect(await Bun.file(join(root, "Thought.md")).text()).toBe("Original thought.\n");
      expect((await client.call("history.get", { id })).entry.undo?.completedAt).toBeNull();
      const revoked = client.call("history.undo", undo).catch((error) => error);
      const second = await command();
      await daemonResult(daemon.client, "pairing.revoke", { id: operator.credential.credentialId });
      await host.call("host.reply", {
        sessionId: attached.sessionId,
        commandId: second.id,
        result: { kind: "guard", allowed: true, reason: null },
      });
      expect(await revoked).toMatchObject({
        code: "UNAUTHENTICATED",
        message: "credential revoked",
      });
      expect(await Bun.file(join(root, "Thought.md")).text()).toBe("Original thought.\n");
      expect((await host.call("history.get", { id })).entry.undo?.completedAt).toBeNull();
      expect((await host.call("host.poll", { sessionId: attached.sessionId })).guards).toEqual([]);
    } finally {
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
