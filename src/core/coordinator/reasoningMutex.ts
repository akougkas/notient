export type MutexTask<T> = (signal: AbortSignal) => Promise<T>;

export interface MutexRunOptions {
  signal?: AbortSignal;
}

export interface ReasoningMutexOptions {
  maxConcurrent?: number;
}

interface QueueEntry {
  label: string;
  task: MutexTask<unknown>;
  callerSignal: AbortSignal | undefined;
  started: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  taskController: AbortController | null;
  onCallerAbort: (() => void) | null;
}

interface RunningJob {
  label: string;
  controller: AbortController;
}

export class ReasoningMutex {
  private readonly maxConcurrent: number;
  private readonly queue: QueueEntry[] = [];
  private readonly running = new Set<RunningJob>();

  constructor(options: ReasoningMutexOptions = {}) {
    const configured = options.maxConcurrent ?? 1;
    this.maxConcurrent = Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 1;
  }

  run<T>(label: string, task: MutexTask<T>, options: MutexRunOptions = {}): Promise<T> {
    return this.enqueue(label, task, options, false);
  }

  runPriority<T>(label: string, task: MutexTask<T>): Promise<T> {
    if (this.running.size >= this.maxConcurrent) {
      for (const job of this.running) {
        if (job.label !== label) job.controller.abort();
      }
    }
    return this.enqueue(label, task, {}, true);
  }

  abort(label?: string): void {
    for (const job of this.running) {
      if (label === undefined || job.label === label) job.controller.abort();
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const entry = this.queue[index];
      if (label !== undefined && entry.label !== label) continue;
      this.queue.splice(index, 1);
      this.cleanupEntry(entry);
      entry.reject(asAbortError());
    }
  }

  isBusy(): boolean {
    return this.running.size > 0;
  }

  currentLabel(): string | null {
    return this.running.values().next().value?.label ?? null;
  }

  private enqueue<T>(
    label: string,
    task: MutexTask<T>,
    options: MutexRunOptions,
    priority: boolean,
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(asAbortError());
    return new Promise<unknown>((resolve, reject) => {
      const entry: QueueEntry = {
        label,
        task: task as MutexTask<unknown>,
        callerSignal: options.signal,
        started: false,
        resolve,
        reject,
        taskController: null,
        onCallerAbort: null,
      };
      const onCallerAbort = (): void => {
        if (entry.started) {
          entry.taskController?.abort();
          return;
        }
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.cleanupEntry(entry);
        reject(asAbortError());
      };
      entry.onCallerAbort = onCallerAbort;
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (priority) {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }
      this.drain();
    }) as Promise<T>;
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry === undefined) return;
      this.startEntry(entry);
    }
  }

  private startEntry(entry: QueueEntry): void {
    if (entry.callerSignal?.aborted) {
      this.cleanupEntry(entry);
      entry.reject(asAbortError());
      return;
    }

    const controller = new AbortController();
    entry.started = true;
    entry.taskController = controller;
    const job: RunningJob = { label: entry.label, controller };
    this.running.add(job);

    void entry
      .task(controller.signal)
      .then((value) => {
        entry.resolve(value);
      })
      .catch((error) => {
        entry.reject(error);
      })
      .finally(() => {
        this.running.delete(job);
        this.cleanupEntry(entry);
        this.drain();
      });
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.onCallerAbort !== null) {
      entry.callerSignal?.removeEventListener("abort", entry.onCallerAbort);
      entry.onCallerAbort = null;
    }
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
