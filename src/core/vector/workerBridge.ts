import type { HNSWVectorStore } from "../../services/hnswVectorStore";

// ============================================================================
// Types
// ============================================================================

export type HNSWConfig = {
  M: number;
  efConstruction: number;
  efSearch: number;
  metric: "l2" | "cosine" | "ip";
  initialMaxElements: number;
};

// Messages TO worker
export type VectorCommand =
  | { type: "init"; config: HNSWConfig }
  | { type: "search"; embedding: Float32Array; k: number; requestId: string }
  | { type: "addItems"; items: Array<{ id: string; embedding: Float32Array }> }
  | { type: "markDeleted"; ids: string[] }
  | { type: "save" }
  | { type: "load"; data: ArrayBuffer };

// Messages FROM worker
export type VectorResult =
  | { type: "ready" }
  | { type: "searchResult"; requestId: string; results: Array<{ id: string; score: number }> }
  | { type: "addComplete"; count: number }
  | { type: "saveComplete"; data: ArrayBuffer }
  | { type: "error"; message: string };

// ============================================================================
// Worker Bridge
// ============================================================================

export class VectorWorkerBridge {
  private worker: Worker;
  private pendingSearches = new Map<
    string,
    { resolve: (results: { id: string; score: number }[]) => void; reject: (err: Error) => void }
  >();
  private pendingAdds: Array<{ resolve: (count: number) => void; reject: (err: Error) => void }> =
    [];
  private pendingSave: {
    resolve: (data: ArrayBuffer) => void;
    reject: (err: Error) => void;
  } | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(workerPath: string) {
    const workerUrl =
      workerPath.startsWith("http") || workerPath.startsWith("file")
        ? workerPath
        : `file://${workerPath}`;

    this.worker = new Worker(workerUrl, {
      type: "module",
    });

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.worker.onmessage = (event: MessageEvent<VectorResult>) => {
      this.handleMessage(event.data);
    };

    this.worker.onerror = (error) => {
      console.error("[VectorWorkerBridge] Worker error:", error);
    };
  }

  private handleMessage(message: VectorResult) {
    switch (message.type) {
      case "ready":
        this.resolveReady();
        break;

      case "searchResult": {
        const pending = this.pendingSearches.get(message.requestId);
        if (pending) {
          pending.resolve(message.results);
          this.pendingSearches.delete(message.requestId);
        }
        break;
      }

      case "addComplete": {
        const pending = this.pendingAdds.shift();
        if (pending) pending.resolve(message.count);
        break;
      }

      case "saveComplete": {
        if (this.pendingSave) {
          this.pendingSave.resolve(message.data);
          this.pendingSave = null;
        }
        break;
      }

      case "error":
        console.error("[VectorWorkerBridge] Error from worker:", message.message);
        // Clean up pending operations if needed, or let them timeout
        break;
    }
  }

  async init(config: HNSWConfig): Promise<void> {
    this.worker.postMessage({ type: "init", config });
    await this.readyPromise;
  }

  async search(embedding: Float32Array, k: number): Promise<Array<{ id: string; score: number }>> {
    const requestId = Math.random().toString(36).substring(7);
    return new Promise((resolve, reject) => {
      this.pendingSearches.set(requestId, { resolve, reject });
      this.worker.postMessage(
        { type: "search", embedding, k, requestId },
        [embedding.buffer] as any, // Zero-copy transfer if aligned
      );
    });
  }

  async addItems(items: Array<{ id: string; embedding: Float32Array }>): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pendingAdds.push({ resolve, reject });
      // We can't easily transfer multiple buffers in an array of objects
      // but Float32Array is structured cloneable and fast
      this.worker.postMessage({ type: "addItems", items });
    });
  }

  markDeleted(ids: string[]): void {
    this.worker.postMessage({ type: "markDeleted", ids });
  }

  async save(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      if (this.pendingSave) {
        reject(new Error("Save already in progress"));
        return;
      }
      this.pendingSave = { resolve, reject };
      this.worker.postMessage({ type: "save" });
    });
  }

  load(data: ArrayBuffer): void {
    this.worker.postMessage({ type: "load", data }, [data]);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
