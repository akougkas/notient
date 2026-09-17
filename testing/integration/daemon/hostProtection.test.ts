import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotientClient } from "../../../src/api/client";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] HTTP host guards preserve a pending write across daemon restart while reads remain available",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-host-restart-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await Bun.write(join(vault, "Garden.md"), "# Garden\n\nEvidence before action.\n");
      daemon = await startTestDaemon(vault);
      const code = await daemonResult(daemon.client, "pairing.create", {
        label: "Test host",
        kind: "human",
        scopes: ["read", "write", "host"],
      });
      const pair = await NotientClient.pair(
        String(code.endpoint),
        String(code.code),
        String(code.vaultId),
      );
      const host = new NotientClient({
        endpoint: String(code.endpoint),
        vaultId: pair.vaultId,
        token: pair.token,
      });
      const instanceId = randomUUID();
      let attached = await host.call("host.attach", { instanceId, label: "Test host" });
      const note = await host.call("notes.read", { path: "Garden.md" });
      const preview = await host.call("changes.preview", {
        idempotencyKey: "host-preview",
        changes: [{ kind: "append", source: note.note, text: "\nReviewed thought.\n" }],
      });
      expect((await host.call("changes.get", { previewId: preview.previewId })).revision).toBe(
        preview.revision,
      );
      const apply = () =>
        host.call("changes.apply", {
          previewId: preview.previewId,
          previewRevision: preview.revision,
          idempotencyKey: "host-apply",
        });
      const pending = apply();
      const command = async () => {
        const deadline = performance.now() + 8000;
        while (performance.now() < deadline) {
          const page = await host.call("host.poll", { sessionId: attached.sessionId });
          if (page.commands.length) return page.commands[0];
          await Bun.sleep(30);
        }
        throw new Error("host guard was not queued");
      };
      const first = await command();
      expect(first.kind).toBe("guard");
      await host.call("host.reply", {
        sessionId: attached.sessionId,
        commandId: first.id,
        result: { kind: "guard", allowed: false, reason: "Unsaved editor" },
      });
      expect((await pending).state).toBe("conflict");
      expect(await Bun.file(join(vault, "Garden.md")).text()).toBe(note.body);
      await daemon.stop();
      daemon = await startTestDaemon(vault);
      expect((await host.call("notes.read", { path: "Garden.md" })).note).toEqual(note.note);
      expect((await host.call("host.status", {})).hosts[0].connected).toBe(false);
      await expect(apply()).rejects.toThrow("Mutation recovery");
      const oldSession = attached.sessionId;
      attached = await host.call("host.attach", { instanceId, label: "Test host" });
      expect(attached.sessionId).not.toBe(oldSession);
      const retry = await command();
      expect(retry.kind).toBe("guard");
      await host.call("host.reply", {
        sessionId: attached.sessionId,
        commandId: retry.id,
        result: { kind: "guard", allowed: true, reason: null },
      });
      const deadline = performance.now() + 8000;
      while ((await host.call("notes.read", { path: "Garden.md" })).body === note.body) {
        if (performance.now() > deadline) throw new Error("guarded recovery did not finish");
        await host.call("host.poll", { sessionId: attached.sessionId });
        await Bun.sleep(30);
      }
      // Wait for the recovery gate to close its receipt, then the exact reviewed
      // request is a replay of that receipt, never a second append.
      let result: Awaited<ReturnType<typeof apply>> | undefined;
      while (!result) {
        try {
          result = await apply();
        } catch (error) {
          if (!String(error).includes("Mutation recovery") || performance.now() > deadline)
            throw error;
          await Bun.sleep(30);
        }
      }
      expect(result.state).toBe("applied");
      expect((await apply()).effects[0].historyId).toBe(result.effects[0].historyId);
      expect(await Bun.file(join(vault, "Garden.md")).text()).toBe(
        `${note.body}\nReviewed thought.\n`,
      );
      expect((await host.call("host.poll", { sessionId: attached.sessionId })).guards).toEqual([]);
      const history = await daemonResult(daemon.client, "history.list", { limit: 10 });
      expect(history.entries).toHaveLength(1);
    } finally {
      await daemon?.stop();
      await rm(vault, { recursive: true, force: true });
      await rm(vaultStateDir(vault), { recursive: true, force: true });
    }
  },
  60000,
);
