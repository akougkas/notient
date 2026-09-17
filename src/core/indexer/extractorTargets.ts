import type { RecordId, Surreal } from "surrealdb";
import type { ExtractorEdgeTable } from "../db/edgeTables";
import { withSurrealRetry } from "../db/retry";

/**
 * Delete one extractor-owned semantic target only when its last incoming
 * relation is still absent at the instant the delete commits.
 *
 * The check and delete deliberately share a transaction. A separate SELECT
 * followed by DELETE can erase a target after another extraction has related
 * it, and non-atomic pruning is just as dangerous as non-atomic graph writes.
 * Retrying the whole transaction is safe: both the referenced and already
 * deleted outcomes are idempotent.
 */
export async function deleteExtractorTargetWhenUnreferenced(
  db: Surreal,
  table: ExtractorEdgeTable,
  id: RecordId,
): Promise<void> {
  const transaction = `BEGIN TRANSACTION;
LET $incoming = (SELECT VALUE id FROM ${table} WHERE out = $id LIMIT 1);
DELETE $id WHERE array::len($incoming) = 0 RETURN NONE;
COMMIT TRANSACTION;`;
  await withSurrealRetry(() => db.query(transaction, { id }).collect());
}
