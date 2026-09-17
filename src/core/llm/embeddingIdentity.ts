/**
 * The exact embedding space a vector belongs to.
 *
 * Model id alone is insufficient provenance: two models (or two revisions
 * served under one id) can emit different widths. `dimension: null` records
 * the explicit result of a failed boot probe. Such an identity may describe
 * the configured endpoint, but it cannot be used to read or write Tier 2.
 */
export interface EmbeddingIdentity {
  readonly model: string;
  readonly dimension: number | null;
}

export interface ResolvedEmbeddingIdentity extends EmbeddingIdentity {
  readonly dimension: number;
}

/** Build and freeze one validated embedding identity. */
export function createEmbeddingIdentity(
  model: string,
  dimension: number,
): ResolvedEmbeddingIdentity;
export function createEmbeddingIdentity(model: string, dimension: null): EmbeddingIdentity;
export function createEmbeddingIdentity(model: string, dimension: number | null): EmbeddingIdentity;
export function createEmbeddingIdentity(
  model: string,
  dimension: number | null,
): EmbeddingIdentity {
  if ((model.length === 0 && dimension !== null) || model.trim() !== model) {
    throw new Error("resolved embedding identity requires an exact, non-empty model id");
  }
  if (dimension !== null && (!Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error("embedding identity dimension must be a positive integer or null");
  }
  return Object.freeze({ model, dimension });
}

/**
 * Resolve the identity required by every Tier-2 read and write. A null width
 * means the boot probe failed, so accepting it would let unproven vectors
 * enter a database whose HNSW schema may describe a different space.
 */
export function requireResolvedEmbeddingIdentity(
  identity: EmbeddingIdentity,
): ResolvedEmbeddingIdentity {
  if (identity.dimension === null) {
    throw new Error(
      `embedding model '${identity.model}' has no resolved vector dimension; Tier 2 is unavailable until its endpoint can establish the configured space`,
    );
  }
  return identity as ResolvedEmbeddingIdentity;
}
