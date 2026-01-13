/**
 * Embed Worker Bridge
 *
 * Main thread proxy for the embed worker.
 * Provides async API for batch embedding operations.
 */

import type { EmbedCommand, EmbedConfig, EmbedResult } from "../../workers/embed.worker";

export class EmbedWorkerBridge {
  private worker: Worker;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: { embeddings: Float32Array[]; dimension: number }) => void;
      reject: (err: Error) => void;
    }
  >();
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

    this.worker.onmessage = (event: MessageEvent<EmbedResult>) => {
      this.handleMessage(event.data);
    };

    this.worker.onerror = (error) => {
      console.error("[EmbedWorkerBridge] Worker error:", error);
    };
  }

  private handleMessage(message: EmbedResult) {
    switch (message.type) {
      case "ready":
        this.resolveReady();
        break;

      case "embedResult": {
        const pending = this.pendingRequests.get(message.requestId);
        if (pending) {
          pending.resolve({
            embeddings: message.embeddings,
            dimension: message.dimension,
          });
          this.pendingRequests.delete(message.requestId);
        }
        break;
      }

      case "error": {
        if (message.requestId) {
          const pending = this.pendingRequests.get(message.requestId);
          if (pending) {
            pending.reject(new Error(message.message));
            this.pendingRequests.delete(message.requestId);
          }
        } else {
          console.error("[EmbedWorkerBridge] Error from worker:", message.message);
        }
        break;
      }
    }
  }

  /**
   * Initialize the worker with embedding configuration
   */
  async init(config: EmbedConfig): Promise<void> {
    this.worker.postMessage({ type: "init", config } as EmbedCommand);
    await this.readyPromise;
  }

  /**
   * Embed multiple texts in parallel
   * Returns Float32Array embeddings with zero-copy transfer
   */
  async embed(texts: string[]): Promise<{ embeddings: Float32Array[]; dimension: number }> {
    if (texts.length === 0) {
      return { embeddings: [], dimension: 0 };
    }

    const requestId = Math.random().toString(36).substring(7);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: "embed", texts, requestId } as EmbedCommand);
    });
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    this.worker.terminate();
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Worker terminated"));
    }
    this.pendingRequests.clear();
  }
}
