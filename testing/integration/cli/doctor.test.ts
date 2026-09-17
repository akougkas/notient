import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstallation, runDoctorCommand } from "../../../src/cli/commands/doctor";
import { makeEmitter } from "../../../src/cli/output";
import { DEFAULT_NOTIENT_CONFIG } from "../../../src/core/settings/types";
import { vaultStateDir } from "../../../src/core/vault/identity";

describe.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "doctor read-only installation inspection",
  () => {
    let vault: string;
    beforeEach(async () => {
      vault = await mkdtemp(join(tmpdir(), "notient-doctor-"));
    });
    afterEach(async () => {
      await rm(vault, { recursive: true, force: true });
    });

    test("fresh vault needs no inference; missing config is reported without creating state", async () => {
      const note = "# Keep me\r\n\r\nAn authored thought.\r\n";
      await writeFile(join(vault, "Thought.md"), note);
      const report = await inspectInstallation(vault, { env: {} });
      expect(report.status).toBe("attention");
      expect(report.checks.find((check) => check.name === "Configuration")?.message).toContain(
        "canonical defaults",
      );
      expect(report.checks.find((check) => check.name === "Daemon")?.message).toContain(
        "No daemon",
      );
      expect(report.checks.find((check) => check.name === "Answers")?.message).toContain(
        "No reasoning model",
      );
      expect(await readdir(vault)).toEqual(["Thought.md"]);
      expect(await readFile(join(vault, "Thought.md"), "utf8")).toBe(note);
      await expect(readdir(vaultStateDir(vault))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("saved deployment wins; shared catalog is fetched once with its private credential and never generates", async () => {
      const requests: { path: string; method: string; auth: string | null }[] = [];
      const secret = "private-doctor-token";
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          requests.push({
            path,
            method: request.method,
            auth: request.headers.get("Authorization"),
          });
          if (path === "/v1/models")
            return Response.json({
              object: "list",
              data: [
                { id: "saved-chat", object: "model" },
                { id: "saved-embed", object: "model" },
              ],
            });
          return new Response(null, { status: 404 });
        },
      });
      try {
        await mkdir(join(vault, ".notient"));
        const config = JSON.stringify(DEFAULT_NOTIENT_CONFIG);
        const deployment = `NOTIENT_LLM_BASE_URL=${server.url.origin}/v1\nNOTIENT_LLM_MODEL=saved-chat\nNOTIENT_EMBED_MODEL=saved-embed\nNOTIENT_LLM_API_KEY=${secret}\n`;
        await writeFile(join(vault, ".notient/config.json"), config);
        await writeFile(join(vault, ".notient/.env"), deployment);
        const report = await inspectInstallation(vault, {
          env: {
            NOTIENT_LLM_BASE_URL: "http://127.0.0.1:1/v1",
            NOTIENT_LLM_MODEL: "wrong-model",
            NOTIENT_LLM_API_KEY: "wrong-credential",
          },
        });
        expect(report.checks.find((check) => check.name === "Answers")).toMatchObject({
          status: "pass",
        });
        expect(report.checks.find((check) => check.name === "Semantic search")).toMatchObject({
          status: "pass",
        });
        expect(requests).toEqual([
          { path: "/v1/models", method: "GET", auth: `Bearer ${secret}` },
          { path: "/api/v0/models", method: "GET", auth: `Bearer ${secret}` },
        ]);
        expect(JSON.stringify(report)).not.toContain(secret);
        expect(JSON.stringify(report)).not.toContain("wrong-model");
        expect(await readFile(join(vault, ".notient/config.json"), "utf8")).toBe(config);
        expect(await readFile(join(vault, ".notient/.env"), "utf8")).toBe(deployment);
        const lines: string[] = [];
        makeEmitter({ mode: "pretty", write: (line) => lines.push(line) }).emit(report);
        expect(lines.join("\n")).toContain("✓ Answers");
        expect(lines.join("\n")).not.toContain(secret);
      } finally {
        await server.stop(true);
      }
    });

    test("configuration errors block readiness without repair or credential disclosure", async () => {
      const secret = "private-malformed-config-token";
      await mkdir(join(vault, ".notient"));
      await writeFile(join(vault, ".notient/.env"), `NOTIENT_LLM_API_KEY=${secret}\n`);
      const bad = `{"unexpected":"${secret}"}`;
      await writeFile(join(vault, ".notient/config.json"), bad);
      const report = await inspectInstallation(vault, { env: {} });
      expect(report.status).toBe("blocked");
      expect(report.checks.find((check) => check.name === "Configuration")).toMatchObject({
        status: "fail",
      });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(await readFile(join(vault, ".notient/config.json"), "utf8")).toBe(bad);
      const exit = await runDoctorCommand({ vaultPath: vault, emitter: { emit() {} } });
      expect(exit).toBe(1);
    });

    test("an inference outage is attention, not a claim that local files cannot work", async () => {
      const report = await inspectInstallation(vault, {
        env: {
          NOTIENT_LLM_BASE_URL: "http://127.0.0.1:1/v1",
          NOTIENT_LLM_MODEL: "unavailable-chat",
          NOTIENT_EMBED_MODEL: "unavailable-embed",
        },
        timeoutMs: 100,
      });
      expect(report.status).toBe("attention");
      expect(report.checks.find((check) => check.name === "Answers")?.status).toBe("attention");
      expect(report.checks.find((check) => check.name === "Semantic search")?.status).toBe(
        "attention",
      );
      await expect(readdir(vaultStateDir(vault))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("an agent identity cannot enter the private deployment inspector", async () => {
      const events: unknown[] = [];
      await expect(
        runDoctorCommand({
          vaultPath: vault,
          clientIdentity: "codex",
          emitter: { emit: (event) => events.push(event) },
        }),
      ).rejects.toThrow("PERMISSION_DENIED");
      expect(events).toEqual([]);
    });
  },
);
