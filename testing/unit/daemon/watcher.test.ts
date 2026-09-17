import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import { FsVault } from "../../../src/adapters/fsVault";
import type { SurrealConnection } from "../../../src/core/db/surreal";
import { EventBus } from "../../../src/core/events/eventBus";
import { makeExclusionPredicate } from "../../../src/core/indexer/excludePaths";
import { DaemonMutationJournal } from "../../../src/core/vault/daemonMutationJournal";
import { VaultWatcher, type VaultWatcherOptions, isWslPath } from "../../../src/daemon/watcher";

const INCLUDE_ALL = (): boolean => false;
const WATCHER_ACTIVITY = {
  recordHumanActivity: () => {},
  recordDeletion: () => {},
};

function watcherRuntimeDeps() {
  return {
    activity: WATCHER_ACTIVITY,
    mutationJournal: new DaemonMutationJournal(),
    approvalIntents: {
      cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
    },
  };
}

function makeSurrealStub(error?: Error): SurrealConnection {
  return {
    db: {
      create: () => ({
        content: async (input: Record<string, unknown>) => [
          { ...input, id: new RecordId("note", String(input.path)) },
        ],
      }),
      query: (sql: string) => ({
        collect: async () => {
          if (
            error !== undefined &&
            !sql.startsWith("SELECT path, sha, tier1_at, structural_version FROM note") &&
            !sql.startsWith("SELECT path FROM note") &&
            !sql.startsWith("SELECT id, path, reference_targets FROM note")
          )
            throw error;
          return [[]];
        },
      }),
    } as unknown as Surreal,
    close: async () => {},
  };
}

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

describe("VaultWatcher exclusion", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-watch-exclude-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("mandatory owned paths are never enqueued even when exclusion settings omit them", async () => {
    await mkdir(join(root, "nOtIeNt", "CoNvErSaTiOnS"), { recursive: true });
    await mkdir(join(root, "nOtIeNt", "pRoPoSaLs"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      pollingInterval: 50,
      forcePolling: true,
      isExcluded: makeExclusionPredicate({
        excludePaths: [],
        excludeGlobs: ["**/*.excalidraw.md"],
      }),
    });
    await watcher.start();
    await writeFile(join(root, "nOtIeNt", "CoNvErSaTiOnS", "chat.md"), "transcript");
    await writeFile(join(root, "nOtIeNt", "pRoPoSaLs", "pending.md"), "proposal");
    await writeFile(join(root, "notes", "diagram.excalidraw.md"), "scene");
    await writeFile(join(root, "notes", "real.md"), "prose");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A second write exercises the `change` handler, not just `add`.
    await writeFile(join(root, "nOtIeNt", "CoNvErSaTiOnS", "chat.md"), "transcript v2");
    await writeFile(join(root, "nOtIeNt", "pRoPoSaLs", "pending.md"), "proposal v2");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await watcher.stop();

    expect(enqueued).toContain("notes/real.md");
    expect(enqueued).not.toContain("nOtIeNt/CoNvErSaTiOnS/chat.md");
    expect(enqueued).not.toContain("nOtIeNt/pRoPoSaLs/pending.md");
    expect(enqueued).not.toContain("notes/diagram.excalidraw.md");
  });
});

describe("VaultWatcher ignore rules", () => {
  let root: string;
  let watcher: VaultWatcher | null = null;
  const enqueued: string[] = [];

  beforeEach(async () => {
    enqueued.length = 0;
    root = await mkdtemp(join(tmpdir(), "notient-watcher-"));
    await mkdir(join(root, "Notes"), { recursive: true });
    await mkdir(join(root, ".trash"), { recursive: true });
    watcher = new VaultWatcher({
      root,
      enqueue: (path) => {
        enqueued.push(path);
      },
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      forcePolling: true,
      pollingInterval: 25,
    });
    await watcher.start();
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = null;
    await rm(root, { recursive: true, force: true });
  });

  test("skips any dot-prefixed directory segment and keeps normal notes", async () => {
    await writeFile(join(root, ".trash", "Deleted.md"), "# deleted\n", "utf8");
    await writeFile(join(root, "Notes", "a.md"), "# a\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(enqueued).toContain("Notes/a.md");
    expect(enqueued).not.toContain(".trash/Deleted.md");
  });
});

describe("VaultWatcher activity attribution", () => {
  test("indexes daemon writes without mistaking them for human focus", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-watch-attribution-"));
    const journal = new DaemonMutationJournal();
    const activity: Array<{ source: string; notePath?: string | null }> = [];
    const enqueued: string[] = [];
    const watcher = new VaultWatcher({
      root,
      enqueue: (path) => enqueued.push(path),
      surrealDb: makeSurrealStub(),
      bus: new EventBus(),
      activity: {
        recordHumanActivity: (event) => activity.push(event),
        recordDeletion: (path) => activity.push({ source: "vault:delete", notePath: path }),
      },
      mutationJournal: journal,
      approvalIntents: {
        cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
      },
      isExcluded: INCLUDE_ALL,
      forcePolling: true,
      pollingInterval: 25,
    });
    const daemonVault = new FsVault(root, {
      reserveMutation: (mutation) => journal.reserve(mutation),
    });

    try {
      await watcher.start();
      await daemonVault.write("daemon.md", "written by Notient");
      await writeFile(join(root, "human.md"), "written by a human", "utf8");
      const deadline = Date.now() + 1_500;
      while (enqueued.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }

    expect(enqueued).toContain("daemon.md");
    expect(enqueued).toContain("human.md");
    expect(activity).toEqual([{ source: "vault:add", notePath: "human.md" }]);
  });

  test("a deferred add cannot leak a human stamp into a restarted watcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-watch-stop-stamp-"));
    const bus = new EventBus();
    let releaseRename = (): void => {};
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let announceRenameQuery = (): void => {};
    const renameQueryStarted = new Promise<void>((resolve) => {
      announceRenameQuery = resolve;
    });
    let editStampQueries = 0;
    const surrealDb: SurrealConnection = {
      db: {
        create: () => ({
          content: async (input: Record<string, unknown>) => [
            { ...input, id: new RecordId("note", String(input.path)) },
          ],
        }),
        query: (sql: string) => ({
          collect: async () => {
            if (sql.startsWith("UPDATE note SET tombstoned_at")) {
              announceRenameQuery();
              await renameGate;
            }
            if (sql.startsWith("UPDATE note SET last_user_edit_at")) editStampQueries += 1;
            return [[]];
          },
        }),
      } as unknown as Surreal,
      close: async () => {},
    };
    const watcher = new VaultWatcher({
      root,
      enqueue: () => {},
      surrealDb,
      bus,
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      forcePolling: true,
      pollingInterval: 20,
    });

    try {
      await watcher.start();
      await writeFile(join(root, "deferred.md"), "human body", "utf8");
      await renameQueryStarted;

      const stopping = watcher.stop();
      await Promise.resolve();
      releaseRename();
      await stopping;
      // Remove the source so startup does not legitimately admit a new add.
      await rm(join(root, "deferred.md"));

      await watcher.start();
      bus.emit({ type: "vault:note-saved", path: "deferred.md", sha: "ignored" });
      await watcher.drain();
      expect(editStampQueries).toBe(0);
    } finally {
      releaseRename();
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("VaultWatcher substrate contract", () => {
  test("rejects construction without SurrealDB", () => {
    expect(
      () =>
        new VaultWatcher({
          root: "/tmp/notient-watcher-contract",
          enqueue: () => {},
          bus: new EventBus(),
          isExcluded: INCLUDE_ALL,
        } as unknown as VaultWatcherOptions),
    ).toThrow("VaultWatcher requires the SurrealDB substrate");
  });

  test("emits an indexer error when a substrate write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-watch-failure-"));
    const bus = new EventBus();
    const errors: Array<{ path: string; phase: string; message: string }> = [];
    bus.on("indexer:error", (event) => {
      errors.push({ path: event.path, phase: event.phase ?? "", message: event.message });
    });
    const watcher = new VaultWatcher({
      root,
      enqueue: () => {},
      surrealDb: makeSurrealStub(new Error("database unavailable")),
      bus,
      ...watcherRuntimeDeps(),
      isExcluded: INCLUDE_ALL,
      forcePolling: true,
      pollingInterval: 25,
    });

    try {
      await watcher.start();
      await writeFile(join(root, "new.md"), "body", "utf8");
      const deadline = Date.now() + 1_000;
      while (!errors.some((entry) => entry.phase === "watcher-rename") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }

    expect(errors).toContainEqual({
      path: "new.md",
      phase: "watcher-rename",
      message: "database unavailable",
    });
    expect(errors).toContainEqual({
      path: "<tombstone-recovery>",
      phase: "watcher-cascade-recovery",
      message: "database unavailable",
    });
  });
});
