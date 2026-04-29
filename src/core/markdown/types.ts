/**
 * Pure data contract between the markdown AST walker and the Tier 1 indexer.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.2 (block schema), §3.4 (edge tables), §8.2 (extractor shape).
 *
 * No methods on these shapes; the walker emits them, the indexer reads them.
 */

export interface BlockSpec {
  blockId: string | null;
  headingLevel: 1 | 2 | 3 | null;
  headingPath: string[];
  headingSlug: string | null;
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface WikilinkSpec {
  fromBlockOrd: number | null;
  rawTarget: string;
  targetPath: string | null;
  targetHeading: string | null;
  targetBlockId: string | null;
  targetHeadingPath: string[];
  alias: string | null;
  isEmbed: boolean;
  targetUnresolved: string | null;
}

export interface TagSpec {
  fromBlockOrd: number | null;
  path: string;
}

export interface FrontmatterRefSpec {
  key: string;
  rawTarget: string;
  targetPath: string | null;
}

export interface MarkdownExtraction {
  blocks: BlockSpec[];
  wikilinks: WikilinkSpec[];
  tags: TagSpec[];
  frontmatterRefs: FrontmatterRefSpec[];
  frontmatter: Record<string, unknown>;
  bodySha: string;
  wordCount: number;
}
