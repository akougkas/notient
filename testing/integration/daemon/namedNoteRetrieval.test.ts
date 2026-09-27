import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextResultSchema, retrievalResultSchema } from "../../../src/api/retrieval";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] a project filename supplies exact bounded context even without a body keyword match",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-named-retrieval-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const name = "Orchid — storage engine.md";
    const body = "\ufeff# Native storage\r\n\r\nKeep durable buffers close to the application.\r\n";
    try {
      await writeFile(join(vault, name), body);
      await writeFile(join(vault, "References.md"), "An old Orchid reference.\n");
      daemon = await startTestDaemon(vault);
      const client = daemon.client;
      const search = async (query = "Orchid") =>
        retrievalResultSchema.parse(
          await daemonResult(client, "search.run", { query, mode: "lexical", scope: {}, limit: 5 }),
        );
      let result = await search();
      const deadline = performance.now() + 10000;
      while (result.coverage.state !== "current" && performance.now() < deadline) {
        await Bun.sleep(50);
        result = await search();
      }
      expect(result.coverage.state).toBe("current");
      const named = result.hits.find((hit) => hit.note.path === name);
      if (!named?.evidence) throw new Error("Named source must carry evidence");
      expect(named.evidence.quote).toBe(body);
      expect(named?.scoreKind).toBe("reciprocal-rank");
      expect(result.hits.some((hit) => hit.note.path === "References.md")).toBe(true);
      const context = contextResultSchema.parse(
        await daemonResult(daemon.client, "context.get", {
          query: "Orchid",
          scope: {},
          limit: 5,
          maxCharacters: 5000,
        }),
      );
      expect(context.sources).toContainEqual(named?.evidence);
      expect((await search('"Orchid"')).hits.map((hit) => hit.note.path)).toEqual([
        "References.md",
      ]);
      expect((await search("Orch")).hits).toEqual([]);
    } finally {
      await daemon?.stop();
      await rm(vault, { recursive: true, force: true });
      await rm(vaultStateDir(vault), { recursive: true, force: true });
    }
  },
  30000,
);
