/**
 * Chunk sizes are bounded by the EMBEDDER's context, not by the chat model's.
 * The minimum supported embedding context is 512 tokens. Some compatible
 * servers truncate silently past their model's limit, so a 400/800 chunk
 * would routinely lose its tail before it ever reached a vector. 320/480
 * leaves headroom for the char/4 token estimate being an underestimate on
 * dense prose and code. Operators with a longer-context embedder raise these
 * via `indexer.chunk` in `<vault>/.notient/config.json`.
 */
export const CHUNK = {
  targetTokens: 320,
  maxTokens: 480,
} as const;

/**
 * Tier 3 extraction windowing.
 *
 * The chat model is the throughput bottleneck: one structured-output call per
 * 320-token chunk costs ~250-500 output tokens at ~20 tok/s per stream, so a
 * 14k-chunk vault needs ~20 hours per pass. Output tokens and call count are
 * the cost; prompt tokens are cheap. Packing several chunks into one windowed
 * call collapses the call count by roughly 5x while chunk-level evidence
 * survives through the model-emitted `chunkRefs`.
 *
 * `windowTokens` is the soft ceiling for a window measured by `tokenEstimate`.
 * `headingBreakMinTokens` lets a window close early at an H1/H2 boundary once
 * it already holds enough material to be worth its own call.
 */
export const EXTRACT = {
  windowTokens: 2400,
  headingBreakMinTokens: 1200,
  maxEntities: 8,
  maxClaims: 6,
  maxQuestions: 4,
  // Qwen3.8 may spend output tokens on reasoning despite enable_thinking=false.
  // A measured 1,400-token run exhausted its budget without an answer.
  maxTokens: 4096,
} as const;

/**
 * Linker prompt caps. `linkerNeighbors` merges four kNN probes of `k` each,
 * so a long note could otherwise put 60-80 candidate chunks into one prompt.
 * The caps keep input bounded regardless of note length.
 */
export const LINKER = {
  maxCandidates: 12,
  maxEvidencePerNote: 2,
  evidenceSnippetChars: 600,
  maxActiveChunksInPrompt: 6,
} as const;
