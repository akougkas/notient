/**
 * Boot-time embedding endpoint probe.
 *
 * Notient never assumes a vector width. The configured embedding model is
 * whatever the operator pointed `embedding.model` at, and the operator is
 * free to swap it between runs. The probe embeds one short fixed string
 * against the live `/v1/embeddings` endpoint and reports the width that
 * came back, so the schema applier can size `chunk.vector` and the HNSW
 * index to the model that is actually serving.
 *
 * The probe is advisory. Bootstrap catches its failure, logs
 * `daemon:embedding_probe_failed`, and continues with `dimension: null`;
 * the applier then reuses the width recorded in `meta:embedding` or, if
 * there is none, skips the vector constraints entirely.
 */

import { type ResolvedEmbeddingIdentity, createEmbeddingIdentity } from "./embeddingIdentity";
import type { LLMProvider } from "./provider";

/** Short, stable, cheap. Content is irrelevant; only the width matters. */
export const PROBE_INPUT = "notient embedding probe";

export interface ProbeEmbeddingOptions {
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
}

export async function probeEmbedding(
  options: ProbeEmbeddingOptions,
): Promise<ResolvedEmbeddingIdentity> {
  const { provider, model, signal } = options;
  if (model.trim().length === 0) {
    throw new Error("probeEmbedding: embedding model id is empty");
  }

  let vectors: number[][];
  try {
    vectors = await provider.embed([PROBE_INPUT], { model, signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `probeEmbedding: embedding endpoint unreachable or rejected the request for model '${model}': ${detail}`,
    );
  }

  const vector = vectors[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(
      `probeEmbedding: embedding endpoint returned no vector for model '${model}'; got ${JSON.stringify(vectors).slice(0, 200)}`,
    );
  }
  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(
      `probeEmbedding: embedding endpoint returned a non-numeric vector for model '${model}'`,
    );
  }

  return createEmbeddingIdentity(model, vector.length);
}
