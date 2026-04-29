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

export const EDGE_TABLES = [
  // Deterministic (Tier 1; class = 'EXTRACTED')
  "wikilink",
  "embed",
  "frontmatter_ref",
  "tagged",
  "contained_in",
  "under_heading",
  // Extracted semantic (Tier 3 extractor; class = 'INFERRED')
  "mentions",
  "asserts",
  "asks",
  // Proposed semantic (Tier 3 linker; class = 'INFERRED', approved = false)
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
] as const;

export type EdgeTable = (typeof EDGE_TABLES)[number];

/**
 * Returns the SurrealQL DDL block that defines the seven provenance fields
 * and two indexes for a single edge table. Every `DEFINE FIELD` and
 * `DEFINE INDEX` uses `OVERWRITE` so re-applying the block is a no-op.
 *
 * Mirrors the representative block in spec §3.4 (lines 159-175), substituting
 * the table name for `wikilink`.
 */
export function provenanceFields(table: EdgeTable): string {
  return [
    `DEFINE FIELD OVERWRITE source ON ${table} TYPE string ASSERT $value INSIDE ['wikilink','embed','frontmatter','structure','extractor','linker','user'];`,
    `DEFINE FIELD OVERWRITE class ON ${table} TYPE string ASSERT $value INSIDE ['EXTRACTED','INFERRED','AMBIGUOUS'];`,
    `DEFINE FIELD OVERWRITE confidence ON ${table} TYPE float ASSERT $value >= 0 AND $value <= 1;`,
    `DEFINE FIELD OVERWRITE evidence ON ${table} TYPE option<array<record<chunk>>>;`,
    `DEFINE FIELD OVERWRITE agent ON ${table} TYPE option<string>;`,
    `DEFINE FIELD OVERWRITE approved ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD OVERWRITE created_at ON ${table} TYPE datetime DEFAULT time::now();`,
    `DEFINE INDEX OVERWRITE ${table}_approved ON ${table} FIELDS approved;`,
    `DEFINE INDEX OVERWRITE ${table}_source ON ${table} FIELDS source;`,
  ].join("\n");
}
