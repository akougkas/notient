/**
 * Idempotent SurrealDB schema applier for the Notient vault graph.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §3.6.
 *
 * The `DEFINE ACCESS agent_jwt` block in `schema.surql` references the session
 * parameter `$NOTIENT_AGENT_JWT_KEY`. That parameter MUST be bound via `db.set`
 * (the SDK's wrapper for the SurrealQL `LET` statement) BEFORE the schema query
 * runs, otherwise SurrealDB rejects the DDL with an undefined-parameter error.
 * The applier enforces this ordering.
 *
 * Provenance fields for every edge table live in TypeScript (see
 * `./edgeTables.ts`) and are emitted as a second `query` call after the base
 * schema, so the canonical edge list stays in one place.
 */

import type { Surreal } from "surrealdb";
import { EDGE_TABLES, provenanceFields } from "./edgeTables";

export async function applySchema(db: Surreal, jwtKey: string): Promise<void> {
  await db.set("NOTIENT_AGENT_JWT_KEY", jwtKey);

  const schemaSource = await Bun.file(new URL("./schema.surql", import.meta.url)).text();
  await db.query(schemaSource);

  const provenanceSource = EDGE_TABLES.map(provenanceFields).join("\n");
  await db.query(provenanceSource);
}
