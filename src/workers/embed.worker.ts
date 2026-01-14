/**
 * Embed Worker
 *
 * Parallelizes embedding HTTP calls to Ollama (4 concurrent).
 * Uses Transferable for Float32Array (zero-copy transfer).
 */

// ============================================================================
// Types
// ============================================================================

export interface EmbedConfig {
  host: string;
  model: string;
  keepAliveMs: number;
}

// Messages TO worker
export type EmbedCommand =
  | { type: "init"; config: EmbedConfig }
  | { type: "embed"; texts: string[]; requestId: string };

// Messages FROM worker
export type EmbedResult =
  | { type: "ready" }
  | { type: "embedResult"; requestId: string; embeddings: Float32Array[]; dimension: number }
  | { type: "error"; requestId?: string; message: string };

// ============================================================================
// Worker State
// ============================================================================

let config: EmbedConfig | null = null;
const MAX_CONCURRENT = 4;

function postResult(result: EmbedResult) {
  // Transfer Float32Array buffers for zero-copy
  if (result.type === "embedResult" && result.embeddings.length > 0) {
    const transferables = result.embeddings.map((e) => e.buffer);
    // @ts-expect-error - Worker postMessage signature differs between environments
    self.postMessage(result, transferables);
  } else {
    self.postMessage(result);
  }
}

// ============================================================================
// Ollama API
// ============================================================================

async function embedSingle(text: string): Promise<number[]> {
  if (!config) throw new Error("Worker not initialized");

  const response = await fetch(`${config.host}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: [text],
      truncate: true,
      keep_alive: `${config.keepAliveMs}ms`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.embeddings || !Array.isArray(data.embeddings) || data.embeddings.length === 0) {
    throw new Error("Invalid embedding response from Ollama");
  }

  return data.embeddings[0];
}

/**
 * Process texts in parallel with concurrency limit
 */
async function embedBatch(
  texts: string[],
): Promise<{ embeddings: Float32Array[]; dimension: number }> {
  if (texts.length === 0) {
    return { embeddings: [], dimension: 0 };
  }

  const results: (number[] | Error)[] = new Array(texts.length);
  let nextIndex = 0;
  let dimension = 0;

  // Worker function that processes one text at a time
  const worker = async () => {
    while (nextIndex < texts.length) {
      const idx = nextIndex++;
      try {
        const embedding = await embedSingle(texts[idx]);
        results[idx] = embedding;
        if (dimension === 0 && embedding.length > 0) {
          dimension = embedding.length;
        }
      } catch (error) {
        results[idx] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  // Launch concurrent workers
  const workers = Array(Math.min(MAX_CONCURRENT, texts.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);

  // Convert to Float32Array, throwing on first error
  const embeddings: Float32Array[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result instanceof Error) {
      throw result;
    }
    embeddings.push(new Float32Array(result));
  }

  return { embeddings, dimension };
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = async (e: MessageEvent<EmbedCommand>) => {
  const cmd = e.data;

  try {
    switch (cmd.type) {
      case "init":
        config = cmd.config;
        postResult({ type: "ready" });
        break;

      case "embed": {
        if (!config) {
          postResult({
            type: "error",
            requestId: cmd.requestId,
            message: "Worker not initialized",
          });
          return;
        }

        const { embeddings, dimension } = await embedBatch(cmd.texts);
        postResult({
          type: "embedResult",
          requestId: cmd.requestId,
          embeddings,
          dimension,
        });
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postResult({
      type: "error",
      requestId: cmd.type === "embed" ? cmd.requestId : undefined,
      message,
    });
  }
};
