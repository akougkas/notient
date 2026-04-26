export interface EchoGuardOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry {
  key: string;
  expiresAt: number;
}

export class EchoGuard {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries: Entry[] = [];
  private readonly index = new Map<string, number>();

  constructor(opts: EchoGuardOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 256;
  }

  mark(path: string, sha: string): void {
    const key = `${path}@${sha}`;
    this.purgeExpired();
    if (this.index.has(key)) return;
    this.entries.push({ key, expiresAt: Date.now() + this.ttlMs });
    this.index.set(key, this.entries.length - 1);
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift();
      if (removed) this.index.delete(removed.key);
      this.rebuildIndex();
    }
  }

  take(path: string, sha: string): boolean {
    const key = `${path}@${sha}`;
    this.purgeExpired();
    const idx = this.index.get(key);
    if (idx === undefined) return false;
    this.entries.splice(idx, 1);
    this.index.delete(key);
    this.rebuildIndex();
    return true;
  }

  private purgeExpired(): void {
    const now = Date.now();
    while (this.entries.length > 0 && this.entries[0].expiresAt <= now) {
      const removed = this.entries.shift();
      if (removed) this.index.delete(removed.key);
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (let i = 0; i < this.entries.length; i++) {
      this.index.set(this.entries[i].key, i);
    }
  }
}
