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
  private worker!: Worker;
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
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;

  /**
   * Create a VectorWorkerBridge.
   * @param workerCodeOrUrl - Either a Blob URL (blob:...) or the worker code as a string
   */
  constructor(workerCodeOrUrl: string) {
    // Determine if this is a URL or raw code
    const isUrl =
      workerCodeOrUrl.startsWith("blob:") ||
      workerCodeOrUrl.startsWith("http") ||
      workerCodeOrUrl.startsWith("file");

    let workerUrl: string;
    if (isUrl) {
      workerUrl = workerCodeOrUrl;
    } else {
      // Create Blob URL from worker code
      const blob = new Blob([workerCodeOrUrl], { type: "application/javascript" });
      workerUrl = URL.createObjectURL(blob);
    }

    this.worker = new Worker(workerUrl, {
      type: "module",
    });

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.worker.onmessage = (event: MessageEvent<VectorResult>) => {
      this.handleMessage(event.data);
    };

    this.worker.onerror = (event) => {
      console.error(
        "[VectorWorkerBridge] Worker error:",
        event.message,
        event.filename,
        event.lineno,
      );
      this.rejectAllPending(new Error(`Worker error: ${event.message}`));
      event.preventDefault();
    };

    this.worker.onmessageerror = () => {
      console.error("[VectorWorkerBridge] Message deserialization failed");
      this.rejectAllPending(new Error("Worker message deserialization failed"));
    };
  }

  /**
   * Reject all pending operations with an error.
   * Used when worker errors or terminates.
   */
  private rejectAllPending(error: Error): void {
    // Reject all pending searches
    for (const [, pending] of this.pendingSearches) {
      pending.reject(error);
    }
    this.pendingSearches.clear();

    // Reject all pending adds
    for (const pending of this.pendingAdds) {
      pending.reject(error);
    }
    this.pendingAdds = [];

    // Reject pending save if exists
    if (this.pendingSave) {
      this.pendingSave.reject(error);
      this.pendingSave = null;
    }
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

      case "error": {
        console.error("[VectorWorkerBridge] Error from worker:", message.message);
        // Check if error has requestId (specific operation failed)
        const errorWithId = message as { requestId?: string; message: string };
        if (errorWithId.requestId) {
          const pending = this.pendingSearches.get(errorWithId.requestId);
          if (pending) {
            pending.reject(new Error(message.message));
            this.pendingSearches.delete(errorWithId.requestId);
          }
        } else {
          // No requestId - worker may be broken, reject all pending
          this.rejectAllPending(new Error(`Worker error: ${message.message}`));
        }
        break;
      }
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
        [embedding.buffer] as Transferable[], // Zero-copy transfer if aligned
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
    // Reject all pending operations before terminating
    this.rejectAllPending(new Error("Worker terminated"));
    this.worker.terminate();
  }
}
