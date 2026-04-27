import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWatcher, isWslPath } from "./watcher";

describe("isWslPath", () => {
  test("matches /mnt/<letter>/ paths", () => {
    expect(isWslPath("/mnt/c/Users/x")).toBe(true);
    expect(isWslPath("/mnt/d/projects")).toBe(true);
  });

  test("rejects native paths", () => {
    expect(isWslPath("/home/user/notes")).toBe(false);
    expect(isWslPath("/tmp/v")).toBe(false);
  });
});

describe("VaultWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-watch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits enqueue when a markdown file is added after start", async () => {
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await writeFile(join(root, "new.md"), "hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await watcher.stop();
    expect(enqueued).toContain("new.md");
  });

  test("ignoreInitial: existing files are not enqueued on start", async () => {
    await writeFile(join(root, "existing.md"), "x");
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      pollingInterval: 50,
      forcePolling: true,
    });
    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await watcher.stop();
    expect(enqueued).toEqual([]);
  });
});
