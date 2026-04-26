/**
 * IndexerWorkerClient
 *
 * Thin main-thread wrapper around the indexer Web Worker. Owns one Worker
 * instance reused across notes (cheaper than spawning per-note) and uses
 * message correlation IDs so multiple in-flight runs do not collide.
 *
 * The caller is expected to apply the structured result (chunks, vectors,
 * extraction) to SQLite + HNSW on the main thread, since sql.js and the
 * vector index instance live there.
 */

import type { Chunk, Extraction } from "./types";

export interface IndexerWorkerEmbedConfig {
  baseUrl: string;
  model: string;
  batchSize?: number;
}

export interface IndexerWorkerExtractConfig {
  baseUrl: string;
  model: string;
  concurrency?: number;
}

export interface IndexerWorkerRunArgs {
  notePath: string;
  noteBody: string;
  embedConfig: IndexerWorkerEmbedConfig;
  extractConfig: IndexerWorkerExtractConfig;
  signal?: AbortSignal;
}

export interface IndexerWorkerRunResult {
  chunks: Chunk[];
  vectors: number[][];
  extraction: Extraction;
}

interface ResultPayload {
  type: "result";
  id: string;
  ok: true;
  chunks: Chunk[];
  vectors: number[][];
  extraction: Extraction;
}

interface ErrorPayload {
  type: "result";
  id: string;
  ok: false;
  message: string;
}

type WorkerOutgoingMessage = ResultPayload | ErrorPayload;

interface RunMessage {
  type: "run";
  id: string;
  notePath: string;
  noteBody: string;
  embedConfig: IndexerWorkerEmbedConfig;
  extractConfig: IndexerWorkerExtractConfig;
}

interface CancelMessage {
  type: "cancel";
  id: string;
}

type WorkerIncomingMessage = RunMessage | CancelMessage;

/**
 * Minimal Worker-like interface so the client can be unit-tested with a fake
 * worker (manual postMessage stub) without spawning a real Worker. Mirrors
 * the relevant parts of the DOM Worker shape so a real Worker satisfies it.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  // biome-ignore lint/suspicious/noExplicitAny: matches DOM Worker variance
  onmessage: ((event: any) => unknown) | null;
  // biome-ignore lint/suspicious/noExplicitAny: matches DOM Worker variance
  onerror?: ((event: any) => unknown) | null;
}

export type WorkerFactory = () => WorkerLike;

interface PendingRun {
  resolve: (result: IndexerWorkerRunResult) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  signal?: AbortSignal;
}

export class IndexerWorkerClient {
  private worker: WorkerLike;
  private readonly pending = new Map<string, PendingRun>();
  private nextId = 0;
  private disposed = false;

  constructor(factory: WorkerFactory) {
    this.worker = factory();
    this.worker.onmessage = (event) => {
      this.handleMessage(event.data as WorkerOutgoingMessage);
    };
    if (this.worker.onerror !== undefined) {
      this.worker.onerror = (event) => {
        this.failAll(new Error(`Worker error: ${event.message}`));
      };
    }
  }

  async run(args: IndexerWorkerRunArgs): Promise<IndexerWorkerRunResult> {
    if (this.disposed) {
      throw new Error("IndexerWorkerClient disposed");
    }
    if (args.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const id = `run-${++this.nextId}`;
    return new Promise<IndexerWorkerRunResult>((resolve, reject) => {
      const pending: PendingRun = { resolve, reject, signal: args.signal };
      if (args.signal) {
        const listener = () => {
          this.worker.postMessage({ type: "cancel", id });
        };
        args.signal.addEventListener("abort", listener, { once: true });
        pending.abortListener = listener;
      }
      this.pending.set(id, pending);
      this.worker.postMessage({
        type: "run",
        id,
        notePath: args.notePath,
        noteBody: args.noteBody,
        embedConfig: args.embedConfig,
        extractConfig: args.extractConfig,
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("IndexerWorkerClient disposed"));
    try {
      this.worker.terminate();
    } catch {
      // ignore
    }
  }

  private handleMessage(message: WorkerOutgoingMessage): void {
    if (message.type !== "result") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.abortListener && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (message.ok) {
      pending.resolve({
        chunks: message.chunks,
        vectors: message.vectors,
        extraction: message.extraction,
      });
    } else {
      pending.reject(new Error(message.message));
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.abortListener && pending.signal) {
        pending.signal.removeEventListener("abort", pending.abortListener);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
