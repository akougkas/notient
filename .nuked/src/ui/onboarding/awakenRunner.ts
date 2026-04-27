export interface AwakenRunnerArgs {
  listMarkdown: () => Array<{ path: string; mtime: number }>;
  indexNote: (path: string) => Promise<unknown>;
  batchSize?: number;
}

export interface AwakenProgress {
  processed: number;
  total: number;
}

export interface AwakenComplete {
  totalIndexed: number;
  durationMs: number;
}

export interface AwakenError {
  path: string;
  message: string;
}

export interface AwakenCallbacks {
  onProgress: (p: AwakenProgress) => void;
  onComplete: (c: AwakenComplete) => void;
  onError: (e: AwakenError) => void;
}

export class AwakenRunner {
  private cancelled = false;
  private running = false;

  constructor(private readonly args: AwakenRunnerArgs) {}

  async start(callbacks: AwakenCallbacks): Promise<void> {
    if (this.running) return;
    this.cancelled = false;
    this.running = true;
    const start = Date.now();
    let processed = 0;
    let indexed = 0;
    try {
      const files = this.args.listMarkdown();
      const total = files.length;
      const batchSize = Math.max(1, this.args.batchSize ?? 10);
      for (let i = 0; i < files.length; i += batchSize) {
        if (this.cancelled) break;
        const batch = files.slice(i, i + batchSize);
        const settled = await Promise.allSettled(
          batch.map((file) => this.args.indexNote(file.path)),
        );
        for (let j = 0; j < settled.length; j++) {
          const result = settled[j];
          processed++;
          if (result.status === "fulfilled") {
            indexed++;
          } else {
            callbacks.onError({
              path: batch[j].path,
              message: (result.reason as Error)?.message ?? String(result.reason),
            });
          }
        }
        callbacks.onProgress({ processed, total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      callbacks.onComplete({ totalIndexed: indexed, durationMs: Date.now() - start });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.cancelled = true;
  }

  isRunning(): boolean {
    return this.running;
  }
}
