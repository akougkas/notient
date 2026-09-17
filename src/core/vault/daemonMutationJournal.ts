export type VaultMutation =
  | { kind: "write"; path: string; sha: string }
  | { kind: "remove"; path: string }
  | { kind: "rename"; fromPath: string; toPath: string };

interface JournalEntry {
  kind: "write" | "remove" | "add";
  path: string;
  sha?: string;
  expiresAt: number;
}

/**
 * Short-lived attribution for filesystem events caused by this daemon.
 * Chokidar reports those writes through the same channel as editor saves;
 * the journal prevents Notient from mistaking its own prose for human focus.
 */
export class DaemonMutationJournal {
  private readonly entries: JournalEntry[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 15_000,
  ) {}

  record(mutation: VaultMutation): void {
    this.reserve(mutation);
  }

  /**
   * Publish attribution before a filesystem transition becomes observable.
   * The caller cancels the reservation if the guarded mutation loses its
   * precondition or fails before publication.
   */
  reserve(mutation: VaultMutation): () => void {
    this.prune();
    const expiresAt = this.now() + this.ttlMs;
    const added: JournalEntry[] = [];
    if (mutation.kind === "write") {
      added.push({
        kind: "write",
        path: mutation.path,
        sha: mutation.sha,
        expiresAt,
      });
    } else if (mutation.kind === "remove") {
      added.push({ kind: "remove", path: mutation.path, expiresAt });
    } else {
      added.push(
        { kind: "remove", path: mutation.fromPath, expiresAt },
        { kind: "add", path: mutation.toPath, expiresAt },
      );
    }
    this.entries.push(...added);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const entry of added) {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      }
    };
  }

  matchesWrite(path: string, sha: string): boolean {
    this.prune();
    return this.entries.some(
      (entry) =>
        entry.path === path &&
        ((entry.kind === "write" && entry.sha === sha) || entry.kind === "add"),
    );
  }

  matchesRemoval(path: string): boolean {
    this.prune();
    return this.entries.some((entry) => entry.kind === "remove" && entry.path === path);
  }

  private prune(): void {
    const now = this.now();
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index].expiresAt <= now) this.entries.splice(index, 1);
    }
  }
}
