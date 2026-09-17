import { expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GraphNeighbors, graphNeighborsSchema } from "../../../src/api/graph";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] authored links follow live and offline inventory changes without editing sources",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-reference-lifecycle-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const source =
      '---\nrelated: "[[Later]]"\n---\n\n# Garden\n\n[[Later]]\n\n![[Later]]\n\n[Read later](Later.md)\n';
    const target = "# Later\n\nExact source evidence.\n";
    const waitConnections = async (count: number) => {
      if (!daemon) throw new Error("daemon is not running");
      const deadline = performance.now() + 15000;
      let result: GraphNeighbors | undefined;
      do {
        result = graphNeighborsSchema.parse(
          await daemonResult(daemon.client, "graph.neighbors", { path: "Garden.md" }),
        );
        if (result.coverage.state === "current" && result.connections.length === count)
          return result;
        await Bun.sleep(100);
      } while (performance.now() < deadline);
      throw new Error(`Expected ${count} current connections: ${JSON.stringify(result)}`);
    };
    try {
      await Bun.write(join(root, "Garden.md"), source);
      daemon = await startTestDaemon(root);
      await waitConnections(0);
      await Bun.write(join(root, "Later.md"), target);
      const connected = await waitConnections(4);
      expect(connected.connections.map((edge) => edge.relation).sort()).toEqual([
        "embed",
        "frontmatter_ref",
        "wikilink",
        "wikilink",
      ]);
      expect(connected.connections.every((edge) => edge.note.path === "Later.md")).toBe(true);
      await rename(join(root, "Later.md"), join(root, "Moved.md"));
      await waitConnections(0);
      await Bun.write(join(root, "Later.md"), "# Replacement\n\nA new destination.\n");
      await waitConnections(4);
      await rm(join(root, "Later.md"));
      await waitConnections(0);
      await daemon.stop();
      daemon = undefined;
      await Bun.write(join(root, "Later.md"), target);
      daemon = await startTestDaemon(root);
      await waitConnections(4);
      await daemon.stop();
      daemon = undefined;
      await rename(join(root, "Later.md"), join(root, "Elsewhere.md"));
      daemon = await startTestDaemon(root);
      await waitConnections(0);
      expect(await Bun.file(join(root, "Garden.md")).text()).toBe(source);
      expect(await Bun.file(join(root, "Moved.md")).text()).toBe(target);
      expect(await Bun.file(join(root, "Elsewhere.md")).text()).toBe(target);
    } finally {
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
