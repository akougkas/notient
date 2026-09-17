import type { Surreal } from "surrealdb";
import type { BackupEmbeddingManifest } from "./surrealBackupFormat";

/**
 * Read the one embedding identity that gives stored chunk vectors meaning,
 * then prove every imported/exported vector belongs to that exact space.
 */
export async function readEmbeddingSnapshot(db: Surreal): Promise<BackupEmbeddingManifest> {
  const slices = await db
    .query<[unknown]>("SELECT * FROM meta WHERE key = 'embedding';")
    .collect<[unknown]>();
  if (!Array.isArray(slices) || slices.length !== 1 || !Array.isArray(slices[0])) {
    throw new Error("embedding snapshot query returned an invalid statement envelope");
  }
  const rows = slices[0];
  if (rows.length !== 1 || !isRecord(rows[0]) || !isRecord(rows[0].value)) {
    throw new Error("embedding snapshot requires exactly one meta:embedding row");
  }
  const model = rows[0].value.model;
  const dimension = rows[0].value.dimension;
  if (typeof model !== "string" || model.length === 0 || model.trim() !== model) {
    throw new Error("embedding snapshot model is not canonical");
  }
  if (typeof dimension !== "number" || !Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error("embedding snapshot dimension is not a positive integer");
  }

  const invalidSlices = await db
    .query<[unknown]>(
      `SELECT id FROM chunk
WHERE (vector != NONE AND (embed_model = NONE OR embed_model != $model OR array::len(vector) != $dimension))
   OR (vector = NONE AND embed_model != NONE)
LIMIT 1;`,
      { model, dimension },
    )
    .collect<[unknown]>();
  if (
    !Array.isArray(invalidSlices) ||
    invalidSlices.length !== 1 ||
    !Array.isArray(invalidSlices[0])
  ) {
    throw new Error("embedding vector integrity query returned an invalid statement envelope");
  }
  if (invalidSlices[0].length > 0) {
    throw new Error("stored chunk vectors do not match meta:embedding");
  }
  return { model, dimension };
}

export function assertCompatibleEmbeddingSnapshot(
  backup: BackupEmbeddingManifest,
  current: BackupEmbeddingManifest,
): void {
  if (backup.model === current.model && backup.dimension === current.dimension) return;
  throw new Error(
    `restore embedding mismatch: backup requires model '${backup.model}' at dimension ${backup.dimension}, but the running vault uses model '${current.model}' at dimension ${current.dimension}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
