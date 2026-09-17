import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { NotientClient } from "../../../src/api/client";
import { graphNeighborsSchema, graphPathSchema } from "../../../src/api/graph";
import { deriveTuiLayout } from "../../../src/cli/tui/layout";
import { createRpc } from "../../../src/cli/tui/rpc";
import { initialState, reducer } from "../../../src/cli/tui/store";
import { ExploreView } from "../../../src/cli/tui/views/ExploreView";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] revision-checked connections agree across HTTP, TUI, CLI and actual MCP",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-graph-api-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    const mcp = new Client({ name: "graph-test", version: "1" });
    let screen: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      await mkdir(join(root, "Ideas"));
      await Bun.write(join(root, "Garden.md"), "# Garden\n\n[Reading](Ideas/Reading.md)\n");
      await Bun.write(join(root, "Ideas/Reading.md"), "# Reading\n\n![[Evidence]]\n");
      await Bun.write(
        join(root, "Evidence.md"),
        "# Evidence\n\nKeep source passages with decisions.\n",
      );
      daemon = await startTestDaemon(root);
      const code = await daemonResult(daemon.client, "pairing.create", {
        label: "Graph read",
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
      let neighbors = await client.call("graph.neighbors", { path: "Garden.md" });
      for (let i = 0; i < 100 && neighbors.coverage.state !== "current"; i++) {
        await Bun.sleep(50);
        neighbors = await client.call("graph.neighbors", { path: "Garden.md" });
      }
      expect(neighbors.coverage.state).toBe("current");
      expect(neighbors.connections.map((edge) => edge.note.path)).toEqual(["Ideas/Reading.md"]);
      expect(neighbors.connections[0]).toMatchObject({
        state: "authored",
        assessment: null,
        direction: "outgoing",
      });
      const path = await client.call("graph.path", { from: "Garden.md", to: "Evidence.md" });
      expect(path.outcome).toBe("found");
      expect(path.path.map((note) => note.path)).toEqual([
        "Garden.md",
        "Ideas/Reading.md",
        "Evidence.md",
      ]);
      expect(path.steps.map((edge) => edge.relation)).toEqual(["wikilink", "embed"]);
      expect(await createRpc(daemon.client).neighbors("Garden.md")).toEqual(neighbors);
      expect(await createRpc(daemon.client).findPath("Garden.md", "Evidence.md")).toEqual(path);
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "api",
          "graph.neighbors",
          "--input",
          JSON.stringify({ path: "Garden.md" }),
          "--vault",
          root,
          "--as",
          "codex",
          "--json",
        ],
        { env: daemon.env, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      expect(await child.exited, err).toBe(0);
      expect(graphNeighborsSchema.parse(JSON.parse(out))).toEqual(neighbors);
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("src/cli/index.ts"), "mcp", "--vault", root, "--as", "codex"],
          env: daemon.env,
        }),
      );
      const response = await mcp.callTool({
        name: "notient_neighbors",
        arguments: { path: "Garden.md" },
      });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(graphNeighborsSchema.parse(JSON.parse(content[1].text))).toEqual(neighbors);
      const route = await mcp.callTool({
        name: "notient_find_path",
        arguments: { from: "Garden.md", to: "Evidence.md" },
      });
      expect(route.isError).not.toBe(true);
      expect(
        graphPathSchema.parse(JSON.parse((route.content as Array<{ text: string }>)[1].text)),
      ).toEqual(path);
      let state = reducer(initialState(root), { type: "explore/open", notePath: "Garden.md" });
      state = reducer(state, {
        type: "explore/neighbors",
        connections: neighbors,
        neighbors: neighbors.connections.map((edge) => ({
          connectionId: edge.id,
          notePath: edge.note.path,
          table: edge.relation,
          direction: edge.direction,
          confidence: edge.assessment ?? 1,
          agent: edge.author,
          proposed: edge.state === "proposed",
        })),
      });
      state = reducer(state, { type: "explore/pane", delta: 2 });
      await act(async () => {
        screen = await testRender(
          <ExploreView state={state} layout={deriveTuiLayout(100, 30).explore} />,
          { width: 100, height: 30 },
        );
      });
      await screen!.renderOnce();
      const rendered = screen!.captureCharFrame();
      expect(rendered).toContain("Reading");
      expect(rendered).toContain("Authored reference");
      expect(rendered).not.toContain("100%");
      await expect(
        client.call("graph.neighbors", { path: ".obsidian/private.md" }),
      ).rejects.toBeDefined();
      await expect(
        client.call("graph.path", { from: "Garden.md", to: "Missing.md" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const preview = await client.call("changes.preview", {
        idempotencyKey: "no-write",
        changes: [{ kind: "create", path: "Forbidden.md", body: "no", expected: null }],
      });
      await expect(
        client.call("changes.apply", {
          previewId: preview.previewId,
          previewRevision: preview.revision,
          idempotencyKey: "cannot-apply",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await Bun.file(join(root, "Forbidden.md")).exists()).toBe(false);
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
      await mcp.close().catch(() => {});
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
