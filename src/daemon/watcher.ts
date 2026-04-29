import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { RecordId } from "surrealdb";
import type { SurrealConnection } from "../core/db/surreal";
import type { EventBus } from "../core/events/eventBus";

export interface VaultWatcherOptions {
  root: string;
  enqueue: (vaultRelativePath: string) => void;
  /** Override polling decision (true = always poll, false = always inotify). */
  forcePolling?: boolean;
  pollingInterval?: number;
  /**
   * Optional SurrealDB connection. When provided, the watcher handles
   * unlink (60s tombstone with scheduled cascade-delete) and rename
   * detection (60s SHA-match window) in addition to add/change events.
   */
  surrealDb?: SurrealConnection;
  bus?: EventBus;
  /** Override tombstone window for tests (default 60_000 ms). */
  tombstoneWindowMs?: number;
}

const DEFAULT_TOMBSTONE_WINDOW_MS = 60_000;

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);

async function sha256Body(absolutePath: string): Promise<string> {
  const buffer = await readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly cascadeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: VaultWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const usePolling = this.options.forcePolling ?? isWslPath(this.options.root);
    this.watcher = chokidar.watch(this.options.root, {
      ignoreInitial: true,
      usePolling,
      interval: this.options.pollingInterval ?? 1000,
      ignored: (path) => {
        const segments = path.split(sep);
        return segments.some((segment) => DOT_PREFIXES.has(segment));
      },
    });
    await new Promise<void>((resolve, reject) => {
      const watcher = this.watcher;
      if (!watcher) {
        resolve();
        return;
      }
      watcher.once("ready", () => resolve());
      watcher.once("error", reject);
    });
    const onChange = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = relative(this.options.root, absolutePath).split(sep).join(posix.sep);
      this.options.enqueue(vaultPath);
    };
    const onAdd = async (absolutePath: string): Promise<void> => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = relative(this.options.root, absolutePath).split(sep).join(posix.sep);
      const renamed = await this.tryDetectRename(vaultPath, absolutePath);
      if (!renamed) {
        this.options.enqueue(vaultPath);
      }
    };
    const onUnlink = (absolutePath: string): void => {
      if (!absolutePath.endsWith(".md")) return;
      const vaultPath = relative(this.options.root, absolutePath).split(sep).join(posix.sep);
      void this.handleUnlink(vaultPath);
    };
    this.watcher.on("add", onAdd);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", onUnlink);
  }

  async stop(): Promise<void> {
    for (const timer of this.cascadeTimers.values()) {
      clearTimeout(timer);
    }
    this.cascadeTimers.clear();
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }

  private async handleUnlink(vaultPath: string): Promise<void> {
    const surrealDb = this.options.surrealDb;
    if (surrealDb === undefined) {
      return;
    }
    try {
      await surrealDb.db
        .query("UPDATE note SET tombstoned_at = time::now() WHERE path = $path;", {
          path: vaultPath,
        })
        .collect();
      this.options.bus?.emit({ type: "indexer:tombstoned", path: vaultPath });
      this.scheduleCascade(vaultPath);
    } catch {
      // Swallow watcher-side DB errors; the daemon's higher-level supervisor logs.
    }
  }

  private scheduleCascade(vaultPath: string): void {
    const surrealDb = this.options.surrealDb;
    if (surrealDb === undefined) {
      return;
    }
    const window = this.options.tombstoneWindowMs ?? DEFAULT_TOMBSTONE_WINDOW_MS;
    const previous = this.cascadeTimers.get(vaultPath);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    const timer = setTimeout(() => {
      void this.runCascade(vaultPath);
    }, window);
    timer.unref?.();
    this.cascadeTimers.set(vaultPath, timer);
  }

  private async runCascade(vaultPath: string): Promise<void> {
    this.cascadeTimers.delete(vaultPath);
    const surrealDb = this.options.surrealDb;
    if (surrealDb === undefined) {
      return;
    }
    try {
      const [rows] = await surrealDb.db
        .query<[Array<{ id: RecordId<"note">; tombstoned_at?: string }>]>(
          "SELECT id, tombstoned_at FROM note WHERE path = $path AND tombstoned_at != NONE LIMIT 1;",
          { path: vaultPath },
        )
        .collect<[Array<{ id: RecordId<"note">; tombstoned_at?: string }>]>();
      const noteId = rows[0]?.id;
      if (noteId === undefined) {
        return;
      }
      await surrealDb.db
        .query(
          "DELETE block WHERE note = $note; DELETE wikilink, embed, frontmatter_ref, tagged, contained_in, under_heading WHERE in = $note OR in IN (SELECT VALUE id FROM block WHERE note = $note);",
          { note: noteId },
        )
        .collect();
      await surrealDb.db.query("DELETE $note;", { note: noteId }).collect();
    } catch {
      // Cascade failures are best-effort; next add cycle compensates.
    }
  }

  private async tryDetectRename(vaultPath: string, absolutePath: string): Promise<boolean> {
    const surrealDb = this.options.surrealDb;
    if (surrealDb === undefined) {
      return false;
    }
    let bodySha: string;
    try {
      bodySha = await sha256Body(absolutePath);
    } catch {
      return false;
    }
    try {
      // Tombstone window enforcement happens client-side via the cascade
      // timer: rows older than the window are deleted before this query
      // can see them, so a `tombstoned_at != NONE` filter is sufficient.
      const [rows] = await surrealDb.db
        .query<[Array<{ id: RecordId<"note">; path: string }>]>(
          "SELECT id, path FROM note WHERE sha = $sha AND tombstoned_at != NONE LIMIT 1;",
          { sha: bodySha },
        )
        .collect<[Array<{ id: RecordId<"note">; path: string }>]>();
      const match = rows[0];
      if (match === undefined || match.path === vaultPath) {
        return false;
      }
      await surrealDb.db
        .query("UPDATE $id SET path = $path, tombstoned_at = NONE;", {
          id: match.id,
          path: vaultPath,
        })
        .collect();
      const fromPath = match.path;
      this.options.bus?.emit({ type: "indexer:renamed", fromPath, toPath: vaultPath });
      const timer = this.cascadeTimers.get(fromPath);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.cascadeTimers.delete(fromPath);
      }
      this.options.enqueue(vaultPath);
      return true;
    } catch {
      return false;
    }
  }
}

export function isWslPath(path: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path);
}
