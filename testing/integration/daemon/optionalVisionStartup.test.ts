import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] a reachable model with stalled vision inference cannot block local startup",
  async () => {
    let probes = 0;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models")
          return Response.json({
            object: "list",
            data: [
              { object: "model", id: "stalled-model" },
              { object: "model", id: "text-embedding-test" },
            ],
          });
        if (path === "/api/v0/models") return new Response(null, { status: 404 });
        if (path === "/v1/embeddings")
          return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
        if (path === "/v1/chat/completions") {
          probes++;
          return new Promise<Response>(() => {});
        }
        return new Response(null, { status: 404 });
      },
    });
    const vault = await mkdtemp(join(tmpdir(), "notient-vision-startup-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await writeFile(join(vault, "Local.md"), "# Local\nStill readable.\n");
      await mkdir(join(vault, ".notient"));
      await writeFile(
        join(vault, ".notient/.env"),
        `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${endpoint.port}/v1\nNOTIENT_LLM_MODEL=stalled-model\nNOTIENT_EMBED_MODEL=text-embedding-test\n`,
      );
      daemon = await startTestDaemon(vault, 15000);
      expect(probes).toBe(1);
      const note = await daemonResult(daemon.client, "notes.read", { path: "Local.md" });
      expect(note.body).toBe("# Local\nStill readable.\n");
      const status = await daemonResult(daemon.client, "daemon.status");
      expect(status.visionReady).toBe(false);
    } finally {
      await daemon?.stop();
      endpoint.stop(true);
      await rm(vault, { recursive: true, force: true });
      await rm(vaultStateDir(vault), { recursive: true, force: true });
    }
  },
  30000,
);
