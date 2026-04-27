import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep, posix } from "node:path";

export interface VaultWatcherOptions {
  root: string;
  enqueue: (vaultRelativePath: string) => void;
  /** Override polling decision (true = always poll, false = always inotify). */
  forcePolling?: boolean;
  pollingInterval?: number;
}

const DOT_PREFIXES = new Set([".notient", ".obsidian", ".git"]);

export class VaultWatcher {
  private watcher: FSWatcher | null = null;

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
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}

export function isWslPath(path: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path);
}
