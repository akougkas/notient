/**
 * Two-pass build for the notient CLI binary, plus the typed SDK export.
 *
 *   dist/notient.js   — CLI entry; opens a unix socket to the daemon and
 *                       lazy-loads the OpenTUI runtime when chat is
 *                       launched without a positional prompt.
 *   dist/daemon.js    — Daemon entry; spawned by the CLI when no socket
 *                       exists. The bundle includes the kernel, indexer,
 *                       coordinator, and chat surface.
 *
 *   dist/sdk/         — `notient/sdk`: one browser-safe ESM bundle of the
 *                       fetch client and its schemas (zod stays external)
 *                       with declarations emitted from `tsconfig.sdk.json`.
 *
 * Bun's `--splitting` flag emits chunks for shared imports into the same
 * output directory. Entry names are assigned during bundling so generated
 * chunks can safely import them (including Bun 1.4's shared exports).
 */

import { chmodSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIST = "dist";

// Preserve OpenTUI's package-relative workers, parsers and native assets.
// React stays external too so the renderer and application share one instance.
const RUNTIME_PACKAGES = ["@opentui/*", "react", "react/*"];

async function bundle(entry: string, finalName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    outdir: DIST,
    naming: { entry: finalName },
    splitting: true,
    external: RUNTIME_PACKAGES,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const filePath = join(DIST, finalName);
  const content = await readFile(filePath, "utf-8");
  if (!content.startsWith("#!")) {
    await writeFile(filePath, `#!/usr/bin/env bun\n${content}`);
  }
  chmodSync(filePath, 0o755);
  console.log(`build-cli: ${entry} -> dist/${finalName}`);
}

await rm(DIST, { recursive: true, force: true });
await bundle("src/cli/index.ts", "notient.js");
await bundle("src/daemon/index.ts", "daemon.js");

// `schemaApplier.ts` reads `./schema.surql` relative to its own file via
// `Bun.file(new URL("./schema.surql", import.meta.url))`. After bundling
// `schemaApplier.ts` into `dist/daemon.js`, `import.meta.url` points at
// the bundle, so the schema must sit beside it.
await copyFile("src/core/db/schema.surql", join(DIST, "schema.surql"));
console.log(`build-cli: src/core/db/schema.surql -> dist/schema.surql`);

const sdk = await Bun.build({
  entrypoints: ["src/api/sdk.ts"],
  target: "browser",
  format: "esm",
  outdir: join(DIST, "sdk"),
  naming: { entry: "index.js" },
  external: ["zod"],
});
if (!sdk.success) {
  for (const log of sdk.logs) console.error(log);
  process.exit(1);
}
const declarations = Bun.spawnSync([process.execPath, "x", "tsc", "-p", "tsconfig.sdk.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (declarations.exitCode !== 0) process.exit(declarations.exitCode ?? 1);
console.log("build-cli: src/api/sdk.ts -> dist/sdk/index.js + dist/sdk/types");
