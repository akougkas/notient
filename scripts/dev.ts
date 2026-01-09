#!/usr/bin/env bun
/**
 * Notient Development Script
 *
 * Builds and deploys to test vault with optional reset.
 *
 * Usage:
 *   bun scripts/dev.ts              # Build and copy to vault
 *   bun scripts/dev.ts --reset      # Soft reset (clear settings, keep index)
 *   bun scripts/dev.ts --hard-reset # Hard reset (wipe everything)
 *   bun scripts/dev.ts --watch      # Watch mode with auto-copy
 */

import { spawn } from "child_process";
import { existsSync, watch } from "fs";
import { cp, rm, mkdir } from "fs/promises";
import { join } from "path";

// Configuration
const VAULT_PLUGIN = "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient";
const PROJECT_ROOT = process.cwd();

const args = process.argv.slice(2);
const isReset = args.includes("--reset") || args.includes("-r");
const isHardReset = args.includes("--hard-reset") || args.includes("-H");
const isWatch = args.includes("--watch") || args.includes("-w");

async function resetVault(hard: boolean) {
  if (!existsSync(VAULT_PLUGIN)) {
    console.log("⚠️  Vault plugin directory doesn't exist, skipping reset");
    return;
  }

  const patterns = hard
    ? [
        // Hard reset: everything
        "data.json",
        "index-*.json",
        "state-*.json",
        "intelligence-*.json",
        "conversations.json",
        "cache",
        "locks",
        "logs",
        ".deleted",
        // Legacy (pre-0.2.0)
        "orama-*.json",
        "orama-*.orama",
        "orama-*.meta.json",
        "processing-queue",
        "lancedb",
        "index-state.json",
      ]
    : [
        // Soft reset: settings only
        "data.json",
        "cache",
        "locks",
        "logs",
      ];

  console.log(hard ? "🗑️  HARD RESET: Wiping ALL plugin data..." : "🔄 Soft reset: Clearing settings...");

  for (const pattern of patterns) {
    const target = join(VAULT_PLUGIN, pattern);
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      // Ignore errors for non-existent files
    }
  }

  console.log(hard ? "✅ Hard reset complete - indices DELETED" : "✅ Soft reset complete - indices PRESERVED");
}

async function copyToVault() {
  const files = ["main.js", "manifest.json", "styles.css"];

  // Ensure target directory exists
  await mkdir(VAULT_PLUGIN, { recursive: true });

  for (const file of files) {
    const src = join(PROJECT_ROOT, file);
    const dest = join(VAULT_PLUGIN, file);

    if (existsSync(src)) {
      await cp(src, dest);
    }
  }

  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`${time} 📦 Copied to vault`);
}

async function runBuild(dev: boolean = true): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["scripts/build.ts", dev ? "--dev" : ""], {
      stdio: "inherit",
      cwd: PROJECT_ROOT,
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

async function watchMode() {
  console.log("🔄 Watch mode: Building on file changes...\n");

  // Initial build
  if (await runBuild()) {
    await copyToVault();
  }

  // Debounce mechanism
  let timeout: Timer | null = null;

  // Watch src directory
  const watcher = watch(join(PROJECT_ROOT, "src"), { recursive: true }, async (event, filename) => {
    if (!filename?.endsWith(".ts") && !filename?.endsWith(".css")) return;

    // Debounce
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(async () => {
      console.log(`\n🔨 ${filename} changed, rebuilding...`);
      if (await runBuild()) {
        await copyToVault();
      }
    }, 100);
  });

  console.log("👀 Watching src/ for changes (Ctrl+C to stop)\n");

  // Keep process alive
  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n👋 Watch mode stopped");
    process.exit(0);
  });
}

async function main() {
  // Handle resets
  if (isHardReset) {
    await resetVault(true);
  } else if (isReset) {
    await resetVault(false);
  }

  // Watch mode or single build
  if (isWatch) {
    await watchMode();
  } else {
    console.log("🔨 Building (dev mode)...");
    if (await runBuild()) {
      await copyToVault();
      console.log("✅ Done! Reload Obsidian (Ctrl+R) or toggle plugin off/on");
    } else {
      console.log("❌ Build failed");
      process.exit(1);
    }
  }
}

main();
