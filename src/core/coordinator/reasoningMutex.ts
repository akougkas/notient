export type MutexTask<T> = (signal: AbortSignal) => Promise<T>;

export interface MutexRunOptions {
  signal?: AbortSignal;
}

interface RunningJob {
  label: string;
  controller: AbortController;
}

export class ReasoningMutex {
  private chain: Promise<unknown> = Promise.resolve();
  private running: RunningJob | null = null;

  run<T>(label: string, task: MutexTask<T>, options: MutexRunOptions = {}): Promise<T> {
    const next = this.chain.then(async () => {
      if (options.signal?.aborted) throw asAbortError();
      const controller = new AbortController();
      const onCallerAbort = (): void => controller.abort();
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      this.running = { label, controller };
      try {
        return await task(controller.signal);
      } finally {
        options.signal?.removeEventListener("abort", onCallerAbort);
        this.running = null;
      }
    });
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async runPriority<T>(label: string, task: MutexTask<T>): Promise<T> {
    if (this.running && this.running.label !== label) {
      this.running.controller.abort();
    }
    return this.run(label, task);
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  currentLabel(): string | null {
    return this.running?.label ?? null;
  }
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
