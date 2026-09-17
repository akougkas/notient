/** Exercise an installed tarball, with disposable notes and no generation endpoint. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OperationInput } from "../src/api/operations";
import {
  type ImplementedOperation,
  type OperationResult,
  operationOutputs,
} from "../src/api/results";
import { DEFAULT_NOTIENT_CONFIG } from "../src/core/settings/types";
import { vaultDaemonPidPath, vaultStateDir } from "../src/core/vault/identity";

const argument = process.argv[2];
if (!argument)
  throw new Error("Usage: bun run release:check /absolute/path/to/notient-version.tgz");
const tarball = resolve(argument);
if (!(await Bun.file(tarball).exists())) throw new Error("Candidate tarball does not exist");
const scratch = await mkdtemp(join(tmpdir(), "notient-prerelease-"));
const install = join(scratch, "install");
const vault = join(scratch, "vault");
await mkdir(install);
await mkdir(join(vault, ".notient"), { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => !key.startsWith("NOTIENT_") && value !== undefined,
  ),
) as Record<string, string>;
const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return request.method === "GET"
      ? Response.json({ data: [] })
      : new Response("Inference forbidden in package validation", { status: 503 });
  },
});
const cliPath = join(install, "node_modules/notient/dist/notient.js");
const mcp = new Client({ name: "prerelease-check", version: "1.0.0" });
let daemonStarted = false;
let success = false;
async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: install, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  try {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`Installed command failed (${code}): ${args[1]}\n${output}\n${error}`);
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}
const cli = (args: string[]) => run([process.execPath, cliPath, ...args]);
async function api<Name extends ImplementedOperation>(
  name: Name,
  input: OperationInput<Name>,
): Promise<OperationResult<Name>> {
  return operationOutputs[name].parse(
    JSON.parse(
      await cli(["api", name, "--input", JSON.stringify(input), "--vault", vault, "--json"]),
    ),
  ) as OperationResult<Name>;
}
try {
  await Bun.write(
    join(install, "package.json"),
    JSON.stringify({
      name: "notient-package-validation",
      private: true,
      type: "module",
      dependencies: { notient: `file:${tarball}` },
    }),
  );
  await run([process.execPath, "install", "--ignore-scripts"]);
  await run([
    process.execPath,
    "-e",
    "await import('@opentui/core'); await import('@opentui/react');",
  ]);
  const pkg = await Bun.file(join(install, "node_modules/notient/package.json")).json();
  assert.ok((await cli(["--version"])).includes(pkg.version));
  assert.ok((await cli(["--help"])).includes("brief"));
  for (const path of [
    "dist/daemon.js",
    "dist/schema.surql",
    "docs/openapi-v1.json",
    "docs/services.md",
    "integrations/obsidian/README.md",
  ])
    assert.ok(
      await Bun.file(join(install, "node_modules/notient", path)).exists(),
      `Missing packaged file: ${path}`,
    );
  const config = `${JSON.stringify(DEFAULT_NOTIENT_CONFIG, null, 2)}\n`;
  const deployment = `NOTIENT_LLM_BASE_URL=http://127.0.0.1:${server.port}/v1\nNOTIENT_LLM_MODEL=\nNOTIENT_EMBED_MODEL=\n`;
  await Bun.write(join(vault, ".notient/config.json"), config);
  await Bun.write(join(vault, ".notient/.env"), deployment);
  const original =
    "\uFEFF---\r\naliases: [Garden]\r\n---\r\n# Knowledge\r\n\r\n[[Evidence]]\r\n\r\nKeep exact sources.\r\n";
  await Bun.write(join(vault, "Garden.md"), original);
  await Bun.write(join(vault, "Evidence.md"), "# Evidence\n\nAn exact witness.\n");
  daemonStarted = true;
  const capabilities = await api("capabilities.get", {});
  assert.ok(capabilities.operations.includes("brief.run"));
  const read = await api("notes.read", { path: "Garden.md" });
  assert.equal(read.body, original);
  let graph = await api("graph.neighbors", { path: "Garden.md" });
  for (let i = 0; i < 100 && graph.coverage.state !== "current"; i++) {
    await Bun.sleep(100);
    graph = await api("graph.neighbors", { path: "Garden.md" });
  }
  assert.equal(graph.coverage.state, "current");
  assert.ok(graph.connections.some((connection) => connection.note?.path === "Evidence.md"));
  const preview = await api("changes.preview", {
    idempotencyKey: "installed-append",
    changes: [{ kind: "append", source: read.note, text: "\r\nReviewed candidate check.\r\n" }],
  });
  const apply = {
    previewId: preview.previewId,
    previewRevision: preview.revision,
    idempotencyKey: "installed-apply",
  };
  const applied = await api("changes.apply", apply);
  assert.equal(applied.state, "applied");
  assert.deepEqual(await api("changes.apply", apply), applied);
  const historyId = applied.effects[0]?.historyId;
  assert.ok(historyId);
  const detail = await api("history.get", { id: historyId });
  assert.equal(detail.before, original);
  const undo = { id: historyId, sources: detail.sources, idempotencyKey: "installed-undo" };
  const undone = await api("history.undo", undo);
  assert.ok(undone.entry.undo?.completedAt);
  assert.deepEqual(
    Buffer.from(await Bun.file(join(vault, "Garden.md")).arrayBuffer()),
    Buffer.from(original, "utf8"),
  );
  await cli(["daemon", "stop", "--vault", vault, "--json"]);
  assert.deepEqual(await api("history.undo", undo), undone);

  const pairing = JSON.parse(
    await cli([
      "pair",
      "create",
      "--vault",
      vault,
      "--label",
      "Package reader",
      "--kind",
      "agent",
      "--scopes",
      "read",
      "--json",
    ]),
  );
  // The published SDK export, resolved from the installed package exactly as
  // a consumer would: runtime behaviour first, then its declarations.
  await Bun.write(
    join(install, "sdk-consumer.ts"),
    `import { NotientApiError, NotientClient, type OperationResult } from "notient/sdk";
const [endpoint, code, vaultId] = process.argv.slice(2);
const credential = await NotientClient.pair(endpoint, code, vaultId);
const client = new NotientClient({ endpoint, token: credential.token, vaultId });
const read: OperationResult<"notes.read"> = await client.call("notes.read", { path: "Garden.md" });
let refused: string | null = null;
try {
  await client.call("changes.apply", JSON.parse(process.argv[5]));
} catch (error) {
  if (!(error instanceof NotientApiError)) throw error;
  refused = error.code;
}
// @ts-expect-error an unknown operation must not typecheck
const unknownOperation = () => client.call("notes.erase", {});
void unknownOperation;
console.log(JSON.stringify({ body: read.body, revision: read.note.revision, refused }));
`,
  );
  const consumed = JSON.parse(
    await run([
      process.execPath,
      "sdk-consumer.ts",
      pairing.endpoint,
      pairing.code,
      pairing.vaultId,
      JSON.stringify(apply),
    ]),
  );
  assert.equal(consumed.body, original);
  assert.equal(consumed.revision, read.note.revision);
  assert.equal(consumed.refused, "FORBIDDEN");
  await Bun.write(
    join(install, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
      },
      files: ["sdk-consumer.ts", "globals.d.ts"],
    }),
  );
  await Bun.write(join(install, "globals.d.ts"), "declare const process: { argv: string[] };\n");
  const tsc = resolve(import.meta.dir, "../node_modules/typescript/bin/tsc");
  await run([process.execPath, tsc, "-p", join(install, "tsconfig.json")]);

  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp", "--vault", vault, "--as", "release-reader"],
      cwd: install,
      env,
    }),
  );
  const tools = await mcp.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "notient_brief"));
  const result = await mcp.callTool({
    name: "notient_read_note",
    arguments: { path: "Garden.md" },
  });
  assert.notEqual(result.isError, true);
  assert.ok(JSON.stringify(result).includes(read.note.revision));
  assert.equal(await Bun.file(join(vault, ".notient/config.json")).text(), config);
  assert.equal(await Bun.file(join(vault, ".notient/.env")).text(), deployment);
  assert.equal(requests.filter((request) => request.startsWith("POST")).length, 0);
  success = true;
  console.log(
    JSON.stringify({
      tarball,
      version: pkg.version,
      installedRuntime: true,
      canonicalRead: true,
      graph: true,
      reviewedWrite: true,
      receiptReplay: true,
      undoAcrossRestart: true,
      pairedHttp: true,
      installedSdk: true,
      sdkDeclarations: true,
      readOnlyEnforced: true,
      mcp: true,
      mcpTools: tools.tools.length,
      configurationPreserved: true,
      generationCalls: 0,
    }),
  );
} finally {
  await mcp.close().catch(() => {});
  if (daemonStarted) {
    const record = await Bun.file(vaultDaemonPidPath(vault))
      .json()
      .catch(() => null);
    await cli(["daemon", "stop", "--vault", vault, "--json"]).catch(() => {});
    let stopped = !record?.pid;
    if (record?.pid)
      for (let i = 0; i < 600; i++) {
        try {
          process.kill(record.pid, 0);
        } catch {
          stopped = true;
          break;
        }
        await Bun.sleep(100);
      }
    if (!stopped) {
      success = false;
      process.exitCode = 1;
      console.error(`Candidate daemon has not exited; retained ${scratch}`);
    }
  }
  server.stop(true);
  if (success) {
    await rm(vaultStateDir(vault), { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  } else console.error(`Failed validation retained at ${scratch}`);
}
