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
 * Tier 1 owns the deterministic-extraction subset of edge tables. These names
 * are referenced from both the cleanup path in the surreal DAL and the
 * transaction script in `runTier1`; hoisting them here keeps the two sites in
 * lockstep so a future addition to Tier 1 can not silently desync.
 */
export const TIER1_EDGE_TABLES = [
  "wikilink",
  "embed",
  "frontmatter_ref",
  "tagged",
  "contained_in",
  "under_heading",
] as const satisfies readonly EdgeTable[];

/**
 * Tier 1 cleanup filters by `class = 'EXTRACTED'` rather than by `source`
 * because the daemon_write override may rewrite `source` to the agent's
 * name (e.g. `'linker'`). Filtering by class keeps Tier 3 edges (which use
 * `class = 'INFERRED'`) safe even though they live in different tables today.
 */
export const TIER1_EDGE_CLASS = "EXTRACTED" as const;

/**
 * Returns the SurrealQL DDL block that defines the eight provenance fields
 * and three indexes for a single edge table. Every `DEFINE FIELD` and
 * `DEFINE INDEX` uses `OVERWRITE` so re-applying the block is a no-op.
 *
 * Mirrors the representative block in spec §3.4 (lines 159-175), substituting
 * the table name for `wikilink`.
 *
 * `applied` is the second half of the pending-state contract owned by
 * `ApprovalService` (Phase 4 plan §Task 3). The default of `true` keeps
 * extractor and Tier 1 edges untouched: those edges have no writeback to run
 * and therefore land in the terminal applied state at creation time. Linker
 * proposals (`approved = false`) inherit `applied = true` as well; the
 * approve flow flips `applied` to `false` while it runs the writeback and
 * back to `true` when the `history` row is committed. Search consumers that
 * adopt the `approved AND applied` filter (Task 11) see no behaviour change
 * for the extractor/Tier 1 case, while linker rows become visible only
 * after the writeback finishes.
 */
export function provenanceFields(table: EdgeTable): string {
  return [
    `DEFINE FIELD OVERWRITE source ON ${table} TYPE string ASSERT $value INSIDE ['wikilink','embed','frontmatter','structure','extractor','linker','user'];`,
    `DEFINE FIELD OVERWRITE class ON ${table} TYPE string ASSERT $value INSIDE ['EXTRACTED','INFERRED','AMBIGUOUS'];`,
    `DEFINE FIELD OVERWRITE confidence ON ${table} TYPE float ASSERT $value >= 0 AND $value <= 1;`,
    `DEFINE FIELD OVERWRITE evidence ON ${table} TYPE option<array<record<chunk>>>;`,
    `DEFINE FIELD OVERWRITE agent ON ${table} TYPE option<string>;`,
    `DEFINE FIELD OVERWRITE approved ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD OVERWRITE applied ON ${table} TYPE bool DEFAULT true;`,
    `DEFINE FIELD OVERWRITE created_at ON ${table} TYPE datetime DEFAULT time::now();`,
    `DEFINE INDEX OVERWRITE ${table}_approved ON ${table} FIELDS approved;`,
    `DEFINE INDEX OVERWRITE ${table}_applied ON ${table} FIELDS applied;`,
    `DEFINE INDEX OVERWRITE ${table}_source ON ${table} FIELDS source;`,
  ].join("\n");
}
