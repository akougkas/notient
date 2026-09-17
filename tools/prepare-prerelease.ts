/** Local artifacts only. Publishing, tagging and model inference are separate actions. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createOpenApiDocument } from "../src/api/openapi";

const root = resolve(import.meta.dir, "..");
async function run(args: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} exited ${code}\n${output}`);
  return output.trim();
}

const dirty = await run(["git", "status", "--porcelain", "--untracked-files=no"]);
if (dirty) throw new Error("Commit tracked changes before assembling an identifiable candidate.");
const untrackedCode = await run([
  "git",
  "ls-files",
  "--others",
  "--exclude-standard",
  "--",
  "src",
  "tools",
  "integrations",
  "plugins",
  ".agents",
  ".claude-plugin",
]);
if (untrackedCode)
  throw new Error("Untracked distributable source must be reviewed before packing.");
const commit = await run(["git", "rev-parse", "HEAD"]);
const pkg = await Bun.file(resolve(root, "package.json")).json();
const plugin = await Bun.file(resolve(root, "integrations/obsidian/manifest.json")).json();
const spec = `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
if ((await Bun.file(resolve(root, "docs/openapi-v1.json")).text()) !== spec)
  throw new Error(
    "OpenAPI is stale; regenerate with bun tools/build-openapi.ts and review the diff.",
  );
await run([process.execPath, "run", "build"]);
await run([process.execPath, "run", "build:obsidian"]);

const parent = resolve(root, "artifacts");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(resolve(parent, `notient-${pkg.version}-${commit.slice(0, 8)}-`));
const staging = await mkdtemp(resolve(output, ".plugin-"));
try {
  await run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", output]);
  const folder = resolve(staging, "notient");
  await mkdir(folder);
  for (const name of ["main.js", "manifest.json", "styles.css"])
    await copyFile(resolve(root, "integrations/obsidian/dist", name), resolve(folder, name));
  const zip = `notient-obsidian-${plugin.version}.zip`;
  await run(["zip", "-X", "-q", "-r", resolve(output, zip), "notient"], staging);
  await Bun.write(resolve(output, "openapi-v1.json"), spec);
  await Bun.write(
    resolve(output, "versions.json"),
    `${JSON.stringify({ [plugin.version]: plugin.minAppVersion }, null, 2)}\n`,
  );
  await copyFile(resolve(root, "docs/release-v0.1.0.md"), resolve(output, "RELEASE-NOTES.md"));
  await Bun.write(
    resolve(output, "INSTALL.md"),
    `# Installing Notient ${pkg.version}

Source commit: ${commit}
CLI/daemon: ${pkg.version}. Obsidian desktop plugin: ${plugin.version}.

Requires Bun 1.4.2 and SurrealDB 3.0.5 on PATH. The daemon runs on Linux/WSL;
macOS has implementation and deterministic coverage but lacks current host validation.
Native Windows daemon startup is unsupported; Windows Obsidian connects to WSL.

Install from this directory: \`bun add --global ./notient-${pkg.version}.tgz\`.
Then run \`notient --version\` and \`notient setup /path/to/vault\`, which guides a
first run and ends in the read-only \`notient doctor\` report. Launch the workspace
with \`notient --vault /path/to/vault\`. Ctrl+P opens its menu.
Structural indexing and lexical search work without a model. Configure your model
endpoint in the vault's private .notient/.env for answers and analysis.
Fresh installations do not enable background AI.

For Obsidian, extract the ZIP's notient/ folder into .obsidian/plugins/ and enable
Notient. Create pairing with \`notient pair create --vault /path/to/vault --label "Obsidian desktop" --kind human --scopes read,write,host\`, then enter the printed
endpoint, vault ID and single-use code in the plugin settings. Configuration and
undo require an explicitly granted admin scope. Never copy daemon token files.

The plugin is not in the Obsidian community directory; it installs from this ZIP.

SHA256SUMS identifies the included assets. candidate.json records the source and
build runtime; it does not assert that tests or host validation passed. Consult
RELEASE-NOTES.md for evidence and known limitations.
`,
  );
  const names = [
    `notient-${pkg.version}.tgz`,
    zip,
    "openapi-v1.json",
    "versions.json",
    "INSTALL.md",
    "RELEASE-NOTES.md",
  ];
  const assets = [];
  for (const name of names) {
    const bytes = await Bun.file(resolve(output, name)).arrayBuffer();
    assets.push({
      name,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
    });
  }
  await Bun.write(
    resolve(output, "candidate.json"),
    `${JSON.stringify(
      {
        packageVersion: pkg.version,
        pluginVersion: plugin.version,
        sourceCommit: commit,
        createdAt: new Date().toISOString(),
        bun: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        publication: "local-only",
        assets,
      },
      null,
      2,
    )}\n`,
  );
  const manifestHash = createHash("sha256")
    .update(await Bun.file(resolve(output, "candidate.json")).text())
    .digest("hex");
  await Bun.write(
    resolve(output, "SHA256SUMS"),
    `${assets.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n${manifestHash}  candidate.json\n`,
  );
  console.log(
    JSON.stringify({
      directory: output,
      candidate: basename(output),
      sourceCommit: commit,
      assets: assets.length,
    }),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
