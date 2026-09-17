import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDraft, type CaptureStorage } from "../../../integrations/obsidian/src/captureDraft";
import { NotientClient } from "../../../src/api/client";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] native capture state survives reload and ambiguous HTTP saves without overwriting later edits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-obsidian-capture-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let state: unknown = null;
    let storageAvailable = true;
    const storage: CaptureStorage = {
      read: () => structuredClone(state),
      write: (record) => {
        if (!storageAvailable) throw new Error("Local storage is full");
        state = structuredClone(record);
      },
    };
    const sessions: CaptureDraft[] = [];
    try {
      daemon = await startTestDaemon(root);
      const pending = await daemonResult(daemon.client, "pairing.create", {
        label: "Native capture test",
        kind: "human",
        scopes: ["read", "write"],
      });
      const paired = await NotientClient.pair(
        String(pending.endpoint),
        String(pending.code),
        String(pending.vaultId),
      );
      let interrupt = false;
      let applies = 0;
      const client = new NotientClient({
        endpoint: String(pending.endpoint),
        token: paired.token,
        vaultId: paired.vaultId,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const result = await fetch(input, init);
          if (String(input).endsWith("/changes/apply")) {
            applies++;
            if (interrupt) {
              interrupt = false;
              await result.arrayBuffer();
              throw new Error("Connection lost after the daemon committed its receipt");
            }
          }
          return result;
        }) as typeof fetch,
      });
      let connected = true;
      let vaultId = paired.vaultId;
      const open = () => {
        const session = new CaptureDraft(storage, () => (connected ? { client, vaultId } : null));
        sessions.push(session);
        return session;
      };
      let session = open();
      const body =
        "# A thought\n\nKeep my **meaning**, [[Source]] and café 🌱.\n\n- [ ] Find evidence\n";
      connected = false;
      session.edit({ path: "Captured.md", body });
      await session.preview();
      expect(session.error).toContain("Reconnect");
      expect(session.record.draft.body).toBe(body);
      session.close();
      connected = true;
      session = open();
      expect(session.record.draft.body).toBe(body);
      expect(session.seed("Do not overwrite")).toBe(false);
      await session.preview();
      expect(session.error).toBeNull();
      expect(session.record.draft.preview?.effects[0].after).toBe(body);
      expect(await Bun.file(join(root, "Captured.md")).exists()).toBe(false);

      // Pairing changes cannot retarget an existing reviewed save.
      vaultId = "other-vault";
      await session.save();
      expect(session.error).toContain("different paired vault");
      expect(applies).toBe(0);
      vaultId = paired.vaultId;
      storageAvailable = false;
      await session.save();
      expect(session.persisted).toBe(false);
      expect(applies).toBe(0);
      storageAvailable = true;

      interrupt = true;
      await session.save();
      expect(session.record.saveStarted).toBe(true);
      expect(session.record.receipt).toBeNull();
      expect(applies).toBe(1);
      expect(await readFile(join(root, "Captured.md"), "utf8")).toBe(body);
      const id = session.record.draft.id;
      session.edit({ body: "New unreviewed content" });
      session.reset();
      expect(session.record.draft.id).toBe(id);
      expect(session.record.draft.body).toBe(body);
      session.close();
      const later = `${body}\nHuman wrote this later.\n`;
      await writeFile(join(root, "Captured.md"), later);
      session = open();
      expect(session.record.saveStarted).toBe(true);
      await session.save();
      expect(session.record.receipt).toMatchObject({ state: "applied", ok: true });
      expect(session.record.receipt?.effects[0].historyId).toBeTruthy();
      const receipt = structuredClone(session.record.receipt);
      expect(session.record.saveStarted).toBe(false);
      expect(await readFile(join(root, "Captured.md"), "utf8")).toBe(later);
      await session.save();
      expect(applies).toBe(2);
      expect(session.record.receipt).toEqual(receipt);

      session.reset();
      session.edit({ path: "Race.md", body: "My new thought" });
      await session.preview();
      await writeFile(join(root, "Race.md"), "Someone created this before save.");
      await session.save();
      expect(session.record.receipt?.state).toBe("conflict");
      expect(session.record.draft.body).toBe("My new thought");
      expect(await readFile(join(root, "Race.md"), "utf8")).toBe(
        "Someone created this before save.",
      );
      session.edit({ path: "Another.md" });
      await session.preview();
      await session.save();
      expect(session.record.receipt?.state).toBe("applied");
      expect(await readFile(join(root, "Another.md"), "utf8")).toBe("My new thought");
    } finally {
      for (const session of sessions) session.close();
      await daemon?.stop();
      await rm(root, { recursive: true, force: true });
      await rm(vaultStateDir(root), { recursive: true, force: true });
    }
  },
  30000,
);
