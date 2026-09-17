/**
 * Edge-table catalog for the Notient vault graph.
 *
 * The schema applier reads `EDGE_TABLES` and emits one provenance block per
 * table by calling `provenanceFields(table)`. Keeping this list in TypeScript
 * (not in `schema.surql`) lets the rest of the DAL share the same canonical
 * names without parsing SurrealQL.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.4 (15 edge tables, partitioned by provenance class).
 */

/** Deterministic relations owned by Tier 1 extraction. */
export const TIER1_EDGE_TABLES = [
  "wikilink",
  "embed",
  "frontmatter_ref",
  "tagged",
  "contained_in",
  "under_heading",
] as const;

/** Semantic relations whose evidence must name at least one live chunk. */
export const EXTRACTOR_EDGE_TABLES = ["mentions", "asserts", "asks"] as const;

/**
 * Semantic relations that can be proposed, approved, and written back to
 * Markdown. Every schema, storage, retrieval, and model boundary consumes
 * this catalog directly so adding a relation cannot create split authority.
 */
export const WRITEBACK_EDGE_TABLES = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
] as const;

/** Authored note references and reviewed semantic relations share traversal. */
export const NOTE_CONNECTION_TABLES = [
  "wikilink",
  "embed",
  "frontmatter_ref",
  ...WRITEBACK_EDGE_TABLES,
] as const;

/** Every graph edge table, derived from its single owning category. */
export const EDGE_TABLES = [
  ...TIER1_EDGE_TABLES,
  ...EXTRACTOR_EDGE_TABLES,
  ...WRITEBACK_EDGE_TABLES,
] as const;

export type EdgeTable = (typeof EDGE_TABLES)[number];

export type WritebackEdgeTable = (typeof WRITEBACK_EDGE_TABLES)[number];

export type ExtractorEdgeTable = (typeof EXTRACTOR_EDGE_TABLES)[number];

export function isWritebackEdgeTable(value: string): value is WritebackEdgeTable {
  return (WRITEBACK_EDGE_TABLES as readonly string[]).includes(value);
}

/** Return the writeback table encoded in an edge record id, or null. */
export function writebackEdgeTableFromId(id: string): WritebackEdgeTable | null {
  const colonIndex = id.indexOf(":");
  if (colonIndex <= 0) return null;
  const prefix = id.slice(0, colonIndex);
  return isWritebackEdgeTable(prefix) ? prefix : null;
}

/** Every persisted provenance source accepted by the graph schema. */
export const EDGE_SOURCES = [
  "wikilink",
  "markdown",
  "embed",
  "frontmatter",
  "structure",
  "extractor",
  "linker",
  "synthesizer",
  "contradictionHunter",
  "pipeline-relate",
  "pipeline-contradictions",
  "pipeline-inbox",
  "user",
] as const;

export type EdgeSource = (typeof EDGE_SOURCES)[number];

export function isEdgeSource(value: unknown): value is EdgeSource {
  return typeof value === "string" && (EDGE_SOURCES as readonly string[]).includes(value);
}

export function isExtractorEdgeTable(table: EdgeTable): table is ExtractorEdgeTable {
  return (EXTRACTOR_EDGE_TABLES as readonly EdgeTable[]).includes(table);
}

/**
 * Tier 1 cleanup filters by `class = 'EXTRACTED'` rather than by `source`
 * because provenance class is the ownership boundary. A matching
 * `daemon_write` keeps the canonical extraction source and records the
 * arbitrary authenticated client identity in `agent`.
 */
export const TIER1_EDGE_CLASS = "EXTRACTED" as const;

/**
 * Returns the SurrealQL DDL block that defines the provenance fields
 * and three indexes for a single edge table. Every `DEFINE FIELD` and
 * `DEFINE INDEX` uses `OVERWRITE` so re-applying the block is a no-op.
 *
 * Mirrors the representative block in spec §3.4 (lines 159-175), substituting
 * the table name for `wikilink`.
 *
 * `applied` is the second half of the pending-state contract owned by
 * `ApprovalService`. Extractor and Tier 1 edges need no writeback and enter
 * the terminal applied state. Linker proposals start unapproved; approval
 * flips `applied` false during writeback and true when the history row commits.
 * Consumers require `approved AND applied`, so a semantic edge becomes
 * visible only after its writeback finishes.
 */
export function provenanceFields(table: EdgeTable): string {
  const evidenceField = isExtractorEdgeTable(table)
    ? `DEFINE FIELD OVERWRITE evidence ON ${table} TYPE array<record<chunk>> ASSERT array::len($value) > 0;`
    : `DEFINE FIELD OVERWRITE evidence ON ${table} TYPE option<array<record<chunk>>>;`;
  return [
    `DEFINE FIELD OVERWRITE source ON ${table} TYPE string ASSERT $value INSIDE [${EDGE_SOURCES.map((source) => `'${source}'`).join(",")}];`,
    `DEFINE FIELD OVERWRITE class ON ${table} TYPE string ASSERT $value INSIDE ['EXTRACTED','INFERRED','AMBIGUOUS'];`,
    `DEFINE FIELD OVERWRITE confidence ON ${table} TYPE float ASSERT $value >= 0 AND $value <= 1;`,
    evidenceField,
    `DEFINE FIELD OVERWRITE provenance ON ${table} TYPE option<string>;`,
    `DEFINE FIELD OVERWRITE agent ON ${table} TYPE option<string>;`,
    `DEFINE FIELD OVERWRITE approved ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD OVERWRITE applied ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD OVERWRITE approved_by ON ${table} TYPE option<string>;`,
    `DEFINE FIELD OVERWRITE created_at ON ${table} TYPE datetime DEFAULT time::now();`,
    `DEFINE INDEX OVERWRITE ${table}_approved ON ${table} FIELDS approved;`,
    `DEFINE INDEX OVERWRITE ${table}_applied ON ${table} FIELDS applied;`,
    `DEFINE INDEX OVERWRITE ${table}_source ON ${table} FIELDS source;`,
  ].join("\n");
}
