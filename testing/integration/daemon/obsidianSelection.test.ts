import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editChangeSet,
  gateSelection,
  replacementFor,
} from "../../../integrations/obsidian/src/selection";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { analysisFiles, analysisProvider, analysisSources } from "../../analysisFixture";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

const editor = (saved: string) => saved.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] a native selection maps to the daemon's saved bytes, focuses analysis and only ever becomes a reviewed edit",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-obsidian-selection-"));
    const provider = analysisProvider();
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await provider.configure(root);
      const saved =
        "\ufeff---\r\ntitle: Café 😀\r\n---\r\n# Selection\r\n\r\nKeep 😀 this.\r\nChange this line.\r\nKeep that.\r\n";
      await writeFile(join(root, "Selection.md"), saved);
      daemon = await startTestDaemon(root);
      const pending = await daemonResult(daemon.client, "pairing.create", {
        label: "Native selection test",
        kind: "human",
        scopes: ["read", "write"],
      });
      const paired = await NotientClient.pair(
        String(pending.endpoint),
        String(pending.code),
        String(pending.vaultId),
      );
      const client = new NotientClient({
        endpoint: String(pending.endpoint),
        token: paired.token,
        vaultId: paired.vaultId,
      });
      const bind = async (body: string, path: string, selected: string) => {
        const buffer = editor(body);
        const from = buffer.indexOf(selected);
        const gate = await gateSelection({
          connected: true,
          path,
          saved: body,
          buffer,
          from,
          to: from + selected.length,
          revision: async (value) => contentRevision(value),
        });
        if (!gate.ok) throw new Error(gate.notice);
        return gate.target;
      };
      const target = await bind(saved, "Selection.md", "😀 this.\nChange this line.");
      const read = await client.call("notes.read", {
        path: target.path,
        revision: target.revision,
        selector: { kind: "range", start: target.start, end: target.end },
      });
      expect(read.selected?.quote).toBe("😀 this.\r\nChange this line.");
      expect(editor(read.selected?.quote ?? "")).toBe(target.text);

      const preview = await client.call(
        "changes.preview",
        editChangeSet(target, replacementFor(saved, "😀 this.\nChanged line."), "selection-edit"),
      );
      expect(preview.conflicts).toEqual([]);
      expect(preview.effects[0].after).toBe(saved.replace("Change this line.", "Changed line."));
      expect(await readFile(join(root, "Selection.md"), "utf8")).toBe(saved);

      // A later save makes the bound selection a conflict. It is never re-mapped.
      await writeFile(join(root, "Selection.md"), saved.replace("Keep that.", "Kept that."));
      await expect(
        client.call("changes.preview", editChangeSet(target, "anything", "selection-stale")),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      for (let count = 0; count < 100; count++) {
        const status = await daemonResult(daemon.client, "daemon.status");
        if ((status.indexing as { state: string }).state === "current") break;
        if (count === 99) throw new Error("index never became current");
        await Bun.sleep(50);
      }
      const [path, body] = Object.entries(analysisFiles)[0];
      const focus = await bind(body, path, "three replicas persist it");
      const before = provider.requests.length;
      const correlated = await client.call("notes.correlate", {
        source: analysisSources[0],
        focus: { start: focus.start, end: focus.end },
        scope: { folders: ["Work"] },
        limit: 6,
      });
      expect(correlated.sources).toEqual(analysisSources);
      const asked = JSON.parse(
        provider.requests[before].messages.find((message) => message.role === "user")?.content ??
          "{}",
      );
      expect(JSON.stringify(asked)).toContain("three replicas persist it");
      const brief = await client.call("brief.run", {
        source: analysisSources[0],
        focus: { start: focus.start, end: focus.end },
        scope: { folders: ["Work"] },
        limit: 8,
      });
      expect(brief.topic).toContain("three replicas persist it");
      await expect(
        client.call("brief.run", {
          source: analysisSources[0],
          focus: { start: 0, end: body.length + 1 },
          scope: {},
          limit: 8,
        }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      await expect(
        client.call("brief.run", { query: "storage", focus: { start: 0, end: 4 }, scope: {} }),
      ).rejects.toThrow("focus requires a saved source revision");
    } finally {
      await daemon?.stop();
      provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
