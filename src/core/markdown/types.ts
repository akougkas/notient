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
  /** Markdown heading depth, preserved exactly from H1 through H6. */
  headingLevel: 1 | 2 | 3 | 4 | 5 | 6 | null;
  headingPath: string[];
  headingSlug: string | null;
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export const STRUCTURAL_INDEX_VERSION = 4;

export interface NoteLinkSpec {
  syntax: "wiki" | "markdown";
  fromBlockOrd: number | null;
  rawTarget: string;
  targetHeading: string | null;
  targetBlockId: string | null;
  isEmbed: boolean;
}

export interface TagSpec {
  fromBlockOrd: number | null;
  path: string;
}

export interface FrontmatterRefSpec {
  key: string;
  rawTarget: string;
}

export interface MarkdownExtraction {
  blocks: BlockSpec[];
  links: NoteLinkSpec[];
  tags: TagSpec[];
  frontmatterRefs: FrontmatterRefSpec[];
  bodySha: string;
  wordCount: number;
}
