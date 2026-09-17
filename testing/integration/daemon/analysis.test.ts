import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { briefResultSchema } from "../../../src/api/brief";
import { NotientClient } from "../../../src/api/client";
import { comparisonResultSchema } from "../../../src/api/comparison";
import { contentRevision } from "../../../src/api/notes";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { analysisFiles, analysisProvider, analysisSources } from "../../analysisFixture";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] comparison shares exact evidence across HTTP, CLI and MCP, rejects stale and incomplete inference and has no effects",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-comparison-"));
    const provider = analysisProvider();
    const mcp = new Client({ name: "comparison-check", version: "1.0.0" });
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await provider.configure(root);
      daemon = await startTestDaemon(root);
      const code = await daemonResult(daemon.client, "pairing.create", {
        label: "comparison reader",
        kind: "agent",
        scopes: ["read"],
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
      expect((await client.connect()).operations).toContain("notes.compare");
      const input = {
        sources: analysisSources,
        question: "Do these guarantees contradict each other?",
      };
      const result = await client.call("notes.compare", input);
      expect(result.abstained).toBe(false);
      expect(result.comparisons[0].judgment).toBe("different-assumptions");
      expect(result.sources).toEqual(analysisSources);
      for (const source of result.comparisons[0].evidence) {
        expect(source.quote).toBe(
          analysisFiles[source.path as keyof typeof analysisFiles].slice(
            source.range.start,
            source.range.end,
          ),
        );
        expect(source.range.startLine).toBe(3);
      }
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        accounting: "provider-total",
        chargedTokens: 300,
        generationCeiling: 16384,
        completion: {
          usage: {
            completionTokens: 100,
            reasoningTokens: 70,
            visibleAnswerTokens: null,
            nonReasoningCompletionTokens: 30,
            totalTokens: 300,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("Private synthetic reasoning");
      expect(JSON.stringify(provider.requests)).not.toContain("private canary");
      expect(JSON.stringify(provider.requests[0])).toContain(input.question);
      await expect(
        client.call("notes.compare", { sources: [analysisSources[0], analysisSources[0]] }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      await expect(
        client.call("notes.correlate", {
          source: analysisSources[0],
          scope: { folders: ["Other"] },
          limit: 6,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const calls = provider.requests.length;
      const alone = await client.call("notes.correlate", {
        source: analysisSources[0],
        scope: { paths: [analysisSources[0].path] },
        limit: 6,
      });
      expect(alone.abstained).toBe(true);
      expect(alone.comparisons).toEqual([]);
      expect(provider.requests).toHaveLength(calls);
      for (let count = 0; count < 100; count++) {
        const status = await daemonResult(daemon.client, "daemon.status");
        if ((status.indexing as { state: string }).state === "current") break;
        if (count === 99) throw new Error("index never became current");
        await Bun.sleep(50);
      }
      const correlated = await client.call("notes.correlate", {
        source: analysisSources[0],
        scope: { folders: ["Work"] },
        limit: 6,
      });
      expect(correlated.sources).toEqual(analysisSources);
      expect(correlated.coverage?.state).toBe("current");
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "comparison-reader"],
          env: daemon.env,
        }),
      );
      const tool = await mcp.callTool({ name: "notient_compare_notes", arguments: input });
      expect(tool.isError).not.toBe(true);
      expect(
        comparisonResultSchema.parse(JSON.parse((tool.content as Array<{ text: string }>)[1].text))
          .comparisons,
      ).toEqual(result.comparisons);
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "compare",
          ...analysisSources.map((source) => source.path),
          "--vault",
          root,
          "--json",
        ],
        { env: daemon.env, stdout: "pipe", stderr: "pipe" },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(comparisonResultSchema.parse(JSON.parse(output.trim())).comparisons).toEqual(
        result.comparisons,
      );
      // The canonical brief reads current source passages, not stored claim paraphrases.
      const briefInput = { query: "storage", scope: { folders: ["Work"] }, limit: 2 };
      const brief = await client.call("brief.run", briefInput);
      expect(brief.abstained).toBe(false);
      expect(brief.sources).toHaveLength(2);
      expect(brief.attempts[0].chargedTokens).toBe(300);
      for (const statement of [brief.summary!, ...brief.findings])
        for (const source of statement.evidence)
          expect(source.quote).toBe(
            analysisFiles[source.path as keyof typeof analysisFiles].slice(
              source.range.start,
              source.range.end,
            ),
          );
      expect(JSON.stringify(brief)).not.toContain("Private synthetic reasoning");
      const fileBrief = await client.call("brief.run", {
        source: analysisSources[0],
        scope: { folders: ["Work"] },
        limit: 1,
      });
      expect(fileBrief.topic).toBe("Storage café 😀");
      expect(fileBrief.sources).toEqual([analysisSources[0]]);
      const noEvidenceCalls = provider.requests.length;
      const emptyBrief = await client.call("brief.run", {
        ...briefInput,
        scope: { folders: ["Missing"] },
      });
      expect(emptyBrief).toMatchObject({
        abstained: true,
        summary: null,
        findings: [],
        attempts: [],
      });
      expect(provider.requests).toHaveLength(noEvidenceCalls);
      await expect(
        client.call("brief.run", { source: analysisSources[0], scope: { folders: ["Missing"] } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const briefTool = await mcp.callTool({ name: "notient_brief", arguments: briefInput });
      expect(briefTool.isError).not.toBe(true);
      expect(
        briefResultSchema.parse(JSON.parse((briefTool.content as Array<{ text: string }>)[1].text))
          .summary,
      ).toEqual(brief.summary);
      const briefChild = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "brief",
          "--file",
          analysisSources[0].path,
          "--max-notes",
          "1",
          "--vault",
          root,
          "--json",
        ],
        { env: daemon.env, stdout: "pipe", stderr: "pipe" },
      );
      const [briefOutput, briefErrors, briefExit] = await Promise.all([
        new Response(briefChild.stdout).text(),
        new Response(briefChild.stderr).text(),
        briefChild.exited,
      ]);
      expect(briefExit, briefErrors).toBe(0);
      for (const flag of ["--file", "--max-notes", "--max-claims"]) {
        const invalid = Bun.spawn(
          [
            process.execPath,
            resolve("src/cli/index.ts"),
            "brief",
            "storage",
            flag,
            "--vault",
            root,
            "--json",
          ],
          { env: daemon.env, stdout: "pipe", stderr: "pipe" },
        );
        const [out, err, code] = await Promise.all([
          new Response(invalid.stdout).text(),
          new Response(invalid.stderr).text(),
          invalid.exited,
        ]);
        expect(code).toBe(1);
        expect(out + err).toContain("INVALID_PARAMS");
      }
      expect(briefResultSchema.parse(JSON.parse(briefOutput.trim())).summary).toEqual(
        fileBrief.summary,
      );
      provider.setMode("repair-evidence");
      expect((await client.call("brief.run", briefInput)).attempts).toHaveLength(2);
      provider.setMode("abstain");
      expect(await client.call("brief.run", briefInput)).toMatchObject({
        abstained: true,
        summary: null,
        findings: [],
      });
      for (const mode of ["invalid-quote", "truncated", "reasoning-only", "over-budget"] as const) {
        provider.setMode(mode);
        const previous = provider.requests.length;
        await expect(client.call("brief.run", briefInput)).rejects.toBeDefined();
        expect(provider.requests.length - previous).toBe(mode === "invalid-quote" ? 2 : 1);
      }
      provider.setMode("abstain");
      expect(await client.call("notes.compare", input)).toMatchObject({
        abstained: true,
        reason: expect.stringContaining("do not establish"),
      });
      for (const mode of ["repair", "repair-evidence"] as const) {
        provider.setMode(mode);
        const repaired = await client.call("notes.compare", input);
        expect(repaired.attempts).toHaveLength(2);
        expect(new Set(repaired.comparisons[0].evidence.map((source) => source.path)).size).toBe(2);
      }
      for (const mode of ["invalid-quote", "truncated", "reasoning-only", "over-budget"] as const) {
        provider.setMode(mode);
        const previous = provider.requests.length;
        await expect(client.call("notes.compare", input)).rejects.toBeDefined();
        expect(provider.requests.length - previous).toBe(mode === "invalid-quote" ? 2 : 1);
      }
      provider.setMode("normal");
      provider.beforeAnswer(async () => {
        await writeFile(
          join(root, analysisSources[0].path),
          "A human changed the claim while the model reasoned.\n",
        );
      });
      await expect(client.call("notes.compare", input)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        client.call("brief.run", { source: analysisSources[0], scope: {}, limit: 1 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      provider.beforeAnswer();
      await writeFile(
        join(root, analysisSources[0].path),
        analysisFiles[analysisSources[0].path as keyof typeof analysisFiles],
      );
      provider.setMode("wait");
      const controller = new AbortController();
      const previous = provider.requests.length;
      const pending = client
        .call("notes.compare", input, controller.signal)
        .catch((error) => error);
      for (let count = 0; count < 100 && provider.requests.length === previous; count++)
        await Bun.sleep(20);
      expect(provider.requests.length).toBe(previous + 1);
      controller.abort();
      expect((await pending).code).toBe("REQUEST_INTERRUPTED");
      for (let count = 0; count < 100 && !provider.cancelled; count++) await Bun.sleep(20);
      expect(provider.cancelled).toBe(true);
      expect((await daemonResult(daemon.client, "history.list", {})).entries).toEqual([]);
      expect((await daemonResult(daemon.client, "jobs.list", {})).jobs).toEqual([]);
      for (const [path, body] of Object.entries(analysisFiles))
        expect(await Bun.file(join(root, path)).text()).toBe(body);
      // Imported Obsidian notes can put the useful section far past the opening.
      // The same lexical authority must find it inside each explicit selection.
      provider.setMode("normal");
      const longSources = [];
      for (const source of analysisSources) {
        const body = `# Unrelated introduction\n\n${"Historical navigation and unrelated background.\n\n".repeat(250)}${analysisFiles[source.path as keyof typeof analysisFiles]}`;
        await writeFile(join(root, source.path), body);
        longSources.push({ path: source.path, revision: contentRevision(body) });
      }
      for (const source of longSources) {
        for (let count = 0; count < 120; count++) {
          const page = await client.call("search.run", {
            query: "replicas persists",
            mode: "lexical",
            scope: { paths: [source.path] },
            limit: 1,
          });
          if (page.hits[0]?.evidence?.revision === source.revision) break;
          if (count === 119) throw new Error("long source passage did not become retrievable");
          await Bun.sleep(50);
        }
      }
      const focused = await client.call("notes.compare", {
        sources: longSources,
        question: "replicas persists",
      });
      expect(focused.abstained).toBe(false);
      expect(focused.comparisons[0].evidence.every((source) => source.range.start > 10000)).toBe(
        true,
      );
      expect(focused.limitations.some((text) => text.includes("bounded passages"))).toBe(true);
      expect(JSON.stringify(provider.requests.at(-1))).not.toContain("private canary");
    } finally {
      await mcp.close().catch(() => {});
      await daemon?.stop();
      provider.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
