/**
 * Two-pass build for the notient CLI binary.
 *
 *   dist/notient.js   — CLI entry; opens a unix socket to the daemon and
 *                       lazy-loads the OpenTUI runtime when chat is
 *                       launched without a positional prompt.
 *   dist/daemon.js    — Daemon entry; spawned by the CLI when no socket
 *                       exists. The bundle includes the kernel, indexer,
 *                       coordinator, and chat surface.
 *
 * Bun's `--splitting` flag emits chunks for shared imports (TUI lazy
 * import, tree-sitter wasm assets) into the same output directory. After
 * each build pass we rename the entry from `index.js` to its final name.
 */

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

const DIST = "dist";

async function bundle(entry: string, finalName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    outdir: DIST,
    splitting: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  await rename(join(DIST, "index.js"), join(DIST, finalName));
  console.log(`build-cli: ${entry} -> dist/${finalName}`);
}

await rm(DIST, { recursive: true, force: true });
await bundle("src/cli/index.ts", "notient.js");
await bundle("src/daemon/index.ts", "daemon.js");
