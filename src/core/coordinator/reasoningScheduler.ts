import { AsyncLocalStorage } from "node:async_hooks";

export type ReasoningTask<T> = (signal: AbortSignal) => Promise<T>;

export interface ReasoningRunOptions {
  signal?: AbortSignal;
}

export interface ReasoningSchedulerOptions {
  maxConcurrent: number;
}

interface QueueEntry {
  context: <R>(fn: () => R) => R;
  label: string;
  task: ReasoningTask<unknown>;
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
  ownedChildren: Set<Promise<unknown>>;
  activeChild: OwnedChildEntry | null;
  childQueue: OwnedChildEntry[];
}

interface OwnedChildEntry {
  context: <R>(fn: () => R) => R;
  task: ReasoningTask<unknown>;
  linked: LinkedAbortSignal;
  started: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onAbort: (() => void) | null;
}

interface OwnershipContext {
  owner: RunningJob;
  kind: "owner" | "child";
}

/**
 * Process-wide scheduler for calls that consume a reasoning-model slot.
 *
 * Background work is FIFO up to `maxConcurrent`. Foreground work is inserted
 * at the head of the queue and asks running work with a different label to
 * abort when every slot is occupied. A caller-owned signal cancels only its
 * own queued or running task. First-level acquisitions made by a scheduled
 * owner inherit that owner's physical slot and are serialized. Acquiring the
 * scheduler again from one of those child tasks is rejected: recursive inline
 * work would bypass the slot cap, while recursive queueing would deadlock.
 */
export class ReasoningScheduler {
  private readonly maxConcurrent: number;
  private readonly queue: QueueEntry[] = [];
  private readonly running = new Set<RunningJob>();
  private readonly ownership = new AsyncLocalStorage<OwnershipContext>();

  constructor(options: ReasoningSchedulerOptions) {
    if (
      options === undefined ||
      !Number.isInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > 128
    ) {
      throw new Error("ReasoningScheduler maxConcurrent must be an integer between 1 and 128");
    }
    this.maxConcurrent = options.maxConcurrent;
  }

  run<T>(label: string, task: ReasoningTask<T>, options: ReasoningRunOptions = {}): Promise<T> {
    const context = this.activeContext();
    if (context?.kind === "child") return Promise.reject(recursiveAcquisitionError(label));
    if (context !== null) return this.runOwned(context.owner, task, options);
    return this.enqueue(label, task, options, false);
  }

  runPriority<T>(
    label: string,
    task: ReasoningTask<T>,
    options: ReasoningRunOptions = {},
  ): Promise<T> {
    const context = this.activeContext();
    if (context?.kind === "child") return Promise.reject(recursiveAcquisitionError(label));
    if (context !== null) return this.runOwned(context.owner, task, options);
    if (this.running.size >= this.maxConcurrent) {
      for (const job of this.running) {
        if (job.label !== label) job.controller.abort();
      }
    }
    return this.enqueue(label, task, options, true);
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
    const context = this.activeContext();
    if (context !== null) return context.owner.label;
    return this.running.values().next().value?.label ?? null;
  }

  private enqueue<T>(
    label: string,
    task: ReasoningTask<T>,
    options: ReasoningRunOptions,
    priority: boolean,
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(asAbortError());
    return new Promise<unknown>((resolve, reject) => {
      const entry: QueueEntry = {
        context: AsyncLocalStorage.snapshot(),
        label,
        task: task as ReasoningTask<unknown>,
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
      if (priority) this.queue.unshift(entry);
      else this.queue.push(entry);
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
    const job: RunningJob = {
      label: entry.label,
      controller,
      ownedChildren: new Set(),
      activeChild: null,
      childQueue: [],
    };
    this.running.add(job);

    const execution = entry.context(() =>
      this.ownership.run({ owner: job, kind: "owner" }, async () => {
        try {
          const value = await Promise.resolve().then(() => entry.task(controller.signal));
          await drainOwnedChildren(job);
          return value;
        } catch (error) {
          await drainOwnedChildren(job);
          throw error;
        }
      }),
    );
    void execution.then(
      (value) => {
        this.running.delete(job);
        this.cleanupEntry(entry);
        this.drain();
        entry.resolve(value);
      },
      (error) => {
        this.running.delete(job);
        this.cleanupEntry(entry);
        this.drain();
        entry.reject(error);
      },
    );
  }

  private activeContext(): OwnershipContext | null {
    const context = this.ownership.getStore();
    return context !== undefined && this.running.has(context.owner) ? context : null;
  }

  private runOwned<T>(
    owner: RunningJob,
    task: ReasoningTask<T>,
    options: ReasoningRunOptions,
  ): Promise<T> {
    const linked = linkAbortSignals(owner.controller.signal, options.signal);
    if (linked.signal.aborted) {
      linked.cleanup();
      return Promise.reject(asAbortError());
    }
    let childEntry: OwnedChildEntry;
    const execution = new Promise<unknown>((resolve, reject) => {
      childEntry = {
        context: AsyncLocalStorage.snapshot(),
        task: task as ReasoningTask<unknown>,
        linked,
        started: false,
        resolve,
        reject,
        onAbort: null,
      };
      const onAbort = (): void => {
        if (childEntry.started) return;
        const index = owner.childQueue.indexOf(childEntry);
        if (index < 0) return;
        owner.childQueue.splice(index, 1);
        this.cleanupOwnedEntry(childEntry);
        childEntry.reject(asAbortError());
      };
      childEntry.onAbort = onAbort;
      linked.signal.addEventListener("abort", onAbort, { once: true });
      owner.childQueue.push(childEntry);
      this.drainOwnedQueue(owner);
    });
    owner.ownedChildren.add(execution);
    void execution.then(
      () => owner.ownedChildren.delete(execution),
      () => owner.ownedChildren.delete(execution),
    );
    return execution as Promise<T>;
  }

  private drainOwnedQueue(owner: RunningJob): void {
    if (owner.activeChild !== null) return;
    const entry = owner.childQueue.shift();
    if (entry === undefined) return;
    if (entry.linked.signal.aborted) {
      this.cleanupOwnedEntry(entry);
      entry.reject(asAbortError());
      this.drainOwnedQueue(owner);
      return;
    }

    entry.started = true;
    owner.activeChild = entry;
    const execution = entry.context(() =>
      this.ownership.run({ owner, kind: "child" }, () =>
        Promise.resolve().then(() => entry.task(entry.linked.signal)),
      ),
    );
    void execution.then(
      (value) => {
        this.finishOwnedEntry(owner, entry);
        entry.resolve(value);
      },
      (error) => {
        this.finishOwnedEntry(owner, entry);
        entry.reject(error);
      },
    );
  }

  private finishOwnedEntry(owner: RunningJob, entry: OwnedChildEntry): void {
    if (owner.activeChild !== entry) {
      throw new Error("ReasoningScheduler owned-child state is corrupt");
    }
    owner.activeChild = null;
    this.cleanupOwnedEntry(entry);
    this.drainOwnedQueue(owner);
  }

  private cleanupOwnedEntry(entry: OwnedChildEntry): void {
    if (entry.onAbort !== null) {
      entry.linked.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
    }
    entry.linked.cleanup();
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.onCallerAbort !== null) {
      entry.callerSignal?.removeEventListener("abort", entry.onCallerAbort);
      entry.onCallerAbort = null;
    }
  }
}

async function drainOwnedChildren(owner: RunningJob): Promise<void> {
  while (owner.ownedChildren.size > 0) {
    await Promise.allSettled(owner.ownedChildren);
  }
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function linkAbortSignals(owner: AbortSignal, caller: AbortSignal | undefined): LinkedAbortSignal {
  if (caller === undefined || caller === owner) {
    return { signal: owner, cleanup: () => {} };
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  owner.addEventListener("abort", abort, { once: true });
  caller.addEventListener("abort", abort, { once: true });
  if (owner.aborted || caller.aborted) controller.abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      owner.removeEventListener("abort", abort);
      caller.removeEventListener("abort", abort);
    },
  };
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function recursiveAcquisitionError(label: string): Error {
  const error = new Error(
    `ReasoningScheduler cannot acquire '${label}' recursively from an owned child task`,
  );
  error.name = "ReasoningSchedulerReentrancyError";
  return error;
}
