import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changeResultSchema } from "../../../src/api/changes";
import { NotientClient } from "../../../src/api/client";
import { contentRevision } from "../../../src/api/notes";
import { contextResultSchema, retrievalResultSchema } from "../../../src/api/retrieval";
import { type ClientHandle, type RpcResponseFrame, connectClient } from "../../../src/cli/client";
import { inspectInstallation } from "../../../src/cli/commands/doctor";
import { createRpc } from "../../../src/cli/tui/rpc";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { currentPlatform, resolveSocketPath } from "../../../src/daemon/socket";

const enabled = process.env.NOTIENT_SMOKE === "1";
async function result(
  client: ClientHandle,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponseFrame> {
  for await (const frame of client.call(method, params)) {
    if (frame.type === "error") throw new Error(`${frame.code}: ${frame.message}`);
    if (frame.type === "result") return frame;
  }
  throw new Error("missing terminal result");
}

describe.skipIf(!enabled)("[smoke] model-independent daemon", () => {
  test.each(["unconfigured", "unreachable"])(
    "authenticated read and lexical retrieval with %s inference",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "notient-v010-outage-"));
      const body =
        "\ufeff# Offline\r\n\r\nDurability keeps authored notes readable without inference.\r\n";
      await writeFile(join(root, "Offline.md"), body);
      await mkdir(join(root, ".notient"));
      if (mode === "unreachable")
        await writeFile(
          join(root, ".notient/.env"),
          "NOTIENT_LLM_BASE_URL=http://127.0.0.1:1/v1\nNOTIENT_LLM_MODEL=unreachable-test-model\nNOTIENT_EMBED_MODEL=unreachable-test-embedding\n",
        );
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("NOTIENT_")),
      );
      const child = Bun.spawn([process.execPath, resolve("src/daemon/index.ts"), "--vault", root], {
        cwd: tmpdir(),
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      let output = "";
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            output += new TextDecoder().decode(item.value);
          }
        } finally {
          reader.releaseLock();
        }
      };
      const readers = [consume(child.stdout), consume(child.stderr)];
      let client: ClientHandle | undefined;
      try {
        // An unreachable port can time out instead of refusing, and startup then
        // waits out the catalog and embedding probes before reporting ready.
        const deadline = performance.now() + 45000;
        while (
          !output.includes('"type":"daemon:ready"') &&
          performance.now() < deadline &&
          child.exitCode === null
        )
          await Bun.sleep(25);
        expect(output).toContain('"type":"daemon:ready"');
        client = await connectClient({
          vaultPath: root,
          socketPath: resolveSocketPath(root, currentPlatform()),
          autoSpawn: false,
        });
        const note = await result(client, "notes.read", { path: "Offline.md" });
        const tui = createRpc(client);
        expect((await tui.status()).vaultId).toMatch(/^[a-f0-9]{16}$/);
        expect((await tui.status()).httpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect((await tui.noteBody("Offline.md")).body).toBe(body);
        expect(note.body).toBe(body);
        expect(note.note).toEqual({ path: "Offline.md", revision: contentRevision(body) });
        const searchDeadline = performance.now() + 8000;
        let hits: Array<{ notePath: string }> = [];
        while (performance.now() < searchDeadline) {
          const search = await result(client, "search.run", {
            query: "Durability",
            mode: "quick",
            limit: 10,
          });
          hits = (search.result as { hits: Array<{ notePath: string }> }).hits;
          if (hits.some((hit) => hit.notePath === "Offline.md")) break;
          await Bun.sleep(50);
        }
        if (!hits.some((hit) => hit.notePath === "Offline.md"))
          throw new Error(`lexical index unavailable: ${output}`);
        const readCurrentSearch = async () =>
          retrievalResultSchema.parse(
            await result(client!, "search.run", {
              query: "Durability",
              mode: "lexical",
              scope: {},
              limit: 10,
            }),
          );
        let canonical = await readCurrentSearch();
        const coverageDeadline = performance.now() + 8000;
        while (canonical.coverage.state !== "current" && performance.now() < coverageDeadline) {
          await Bun.sleep(50);
          canonical = await readCurrentSearch();
        }
        expect(canonical.hits).toHaveLength(1);
        expect(canonical.coverage.state).toBe("current");
        expect((await tui.status()).indexing).toMatchObject({
          state: "current",
          total: 1,
          current: 1,
          failed: 0,
        });
        const diagnosis = await inspectInstallation(root, { env: {} });
        expect(diagnosis.checks.find((check) => check.name === "Daemon")?.status).toBe("pass");
        expect(diagnosis.checks.find((check) => check.name === "Search")?.message).toContain(
          "1/1 notes current",
        );
        expect(diagnosis.status).toBe("attention");
        // A saved deployment change is detected without restarting the live owner.
        if (mode === "unconfigured") {
          await writeFile(join(root, ".notient/.env"), "NOTIENT_LLM_MODEL=next-generation-model\n");
          const changed = await inspectInstallation(root, { env: {} });
          expect(changed.checks.find((check) => check.name === "Running deployment")?.status).toBe(
            "attention",
          );
          expect((await tui.status()).probe.configuredModel).toBe("");
        }
        const source = canonical.hits[0].evidence;
        if (!source) throw new Error("missing current source evidence");
        expect(source?.revision).toBe(contentRevision(body));
        expect(source?.quote).toBe(body.slice(source?.range.start, source?.range.end));
        expect(canonical.hits[0].freshness.state).toBe("current");
        const context = contextResultSchema.parse(
          await result(client, "context.get", {
            query: "Durability",
            scope: {},
            limit: 10,
            maxCharacters: 5000,
          }),
        );
        expect(context.sources).toEqual([source]);
        expect(context.coverage.state).toBe("current");
        const excluded = retrievalResultSchema.parse(
          await result(client, "search.run", {
            query: "Durability",
            mode: "lexical",
            scope: { excludeFolders: [""] },
            limit: 10,
          }),
        );
        expect(excluded.hits).toEqual([]);
        expect(await readFile(join(root, "Offline.md"), "utf8")).toBe(body);
        const pairing = await result(client, "pairing.create", {
          label: "Disposable integration client",
          kind: "human",
          scopes: ["read", "write"],
        });
        const credential = await NotientClient.pair(
          String(pairing.endpoint),
          String(pairing.code),
          String(pairing.vaultId),
        );
        const external = new NotientClient({
          endpoint: String(pairing.endpoint),
          token: credential.token,
          vaultId: credential.vaultId,
        });
        const capabilities = await external.connect();
        expect(capabilities.operations).toContain("changes.apply");
        const httpSearch = await external.call("search.run", {
          query: "Durability",
          mode: "lexical",
          scope: {},
          limit: 10,
        });
        expect(httpSearch.coverage.state).toBe("current");
        expect(httpSearch.hits).toEqual(canonical.hits);
        const httpRead = await external.call("notes.read", { path: "Offline.md" });
        expect(httpRead.body).toBe(note.body as string);
        expect(httpRead.note).toEqual({ path: "Offline.md", revision: contentRevision(body) });
        const preview = await external.call("changes.preview", {
          idempotencyKey: "http-append-preview",
          changes: [
            {
              kind: "append",
              source: httpRead.note,
              text: "\r\nVerified through HTTP and IPC.\r\n",
            },
          ],
        });
        const apply = {
          previewId: preview.previewId,
          previewRevision: preview.revision,
          idempotencyKey: "http-append-apply",
        };
        const receipt = changeResultSchema.parse(await result(client, "changes.apply", apply));
        expect(receipt.state).toBe("applied");
        expect(await external.call("changes.apply", apply)).toEqual(receipt);
        expect(await readFile(join(root, "Offline.md"), "utf8")).toBe(preview.effects[0].after);
        await result(client, "pairing.revoke", { id: credential.credentialId });
        await expect(external.call("notes.read", { path: "Offline.md" })).rejects.toThrow(
          "revoked",
        );
      } finally {
        await client?.close();
        child.kill("SIGTERM");
        await child.exited;
        await Promise.all(readers);
        await rm(root, { recursive: true, force: true });
        await rm(vaultStateDir(root), { recursive: true, force: true });
      }
    },
    90000,
  );
});
