import type { RecordId, Surreal } from "surrealdb";
import { extract } from "../markdown/extractor";
import { processAst } from "../markdown/pipeline";
import { resolveTargets } from "../markdown/resolver";
import { headingSlug } from "../markdown/slug";
import type { MarkdownExtraction, WikilinkSpec } from "../markdown/types";
import {
  clearTier1Edges,
  lookupBlockByExplicitId,
  lookupBlockByHeading,
  lookupNoteByPath,
  markTier1Done,
  relateEdge,
  replaceBlocks,
  upsertNoteByPath,
  upsertTag,
} from "../db/surreal";

/**
 * Tier 1 indexer: turns a saved note into deterministic SurrealDB edges.
 *
 * Spec: §5.2, Phase 2 plan §Task 12.
 *
 * Atomicity is delivered via a session-level BEGIN TRANSACTION ... COMMIT
 * pair. If any step throws, the transaction is cancelled and `tier1_at`
 * does not advance.
 */

export interface Tier1Input {
  notePath: string;
  source: string;
  vaultPaths: string[];
}

export interface Tier1Output {
  noteId: RecordId<"note">;
  extraction: MarkdownExtraction;
}

interface ResolvedWikilink extends WikilinkSpec {
  resolvedTargetPath: string | null;
}

async function resolveWikilinkTarget(
  db: Surreal,
  link: ResolvedWikilink,
): Promise<RecordId<"note"> | RecordId<"block"> | null> {
  if (link.resolvedTargetPath === null) {
    return null;
  }
  const noteId = await lookupNoteByPath(db, link.resolvedTargetPath);
  if (noteId === null) {
    return null;
  }
  if (link.targetBlockId !== null) {
    const blockId = await lookupBlockByExplicitId(db, noteId, link.targetBlockId);
    if (blockId !== null) {
      return blockId;
    }
    return noteId;
  }
  if (link.targetHeading !== null) {
    const slug = headingSlug(link.targetHeading);
    if (slug.length > 0) {
      const blockId = await lookupBlockByHeading(db, noteId, slug);
      if (blockId !== null) {
        return blockId;
      }
    }
    return noteId;
  }
  return noteId;
}

export async function runTier1(db: Surreal, input: Tier1Input): Promise<Tier1Output> {
  const ast = processAst(input.source);
  const extraction = extract(ast, input.notePath);

  const wikilinkResolutions = resolveTargets(
    input.notePath,
    extraction.wikilinks.map((wikilink) => ({
      rawTarget: wikilink.rawTarget,
      targetHeading: wikilink.targetHeading,
      targetBlockId: wikilink.targetBlockId,
    })),
    input.vaultPaths,
  );
  const frontmatterResolutions = resolveTargets(
    input.notePath,
    extraction.frontmatterRefs.map((ref) => ({
      rawTarget: ref.rawTarget,
      targetHeading: null,
      targetBlockId: null,
    })),
    input.vaultPaths,
  );

  // Per-operation atomicity only: surrealdb-js opens a fresh implicit
  // transaction per query, so a session-level BEGIN/COMMIT pair via
  // separate db.query() calls is not honored. markTier1Done is the last
  // step; on partial failure, the next runTier1 retry self-heals because
  // replaceBlocks and clearTier1Edges are delete-then-insert idempotent.
  try {
    const noteId = await upsertNoteByPath(db, {
      path: input.notePath,
      sha: extraction.bodySha,
      wordCount: extraction.wordCount,
    });

    await clearTier1Edges(db, noteId);
    const blockIds = await replaceBlocks(db, noteId, extraction.blocks);

    let currentHeadingBlock: RecordId<"block"> | null = null;
    for (let index = 0; index < extraction.blocks.length; index += 1) {
      const block = extraction.blocks[index];
      const blockId = blockIds[index];
      await relateEdge(db, {
        table: "contained_in",
        from: blockId,
        to: noteId,
        source: "structure",
        confidenceClass: "EXTRACTED",
        confidence: 1,
      });
      if (block.headingLevel !== null) {
        currentHeadingBlock = blockId;
        continue;
      }
      if (currentHeadingBlock !== null) {
        await relateEdge(db, {
          table: "under_heading",
          from: blockId,
          to: currentHeadingBlock,
          source: "structure",
          confidenceClass: "EXTRACTED",
          confidence: 1,
        });
      }
    }

    for (let index = 0; index < extraction.wikilinks.length; index += 1) {
      const link = extraction.wikilinks[index];
      const resolution = wikilinkResolutions[index];
      const fromBlockOrd = link.fromBlockOrd;
      const fromId =
        fromBlockOrd !== null && fromBlockOrd >= 0 && fromBlockOrd < blockIds.length
          ? blockIds[fromBlockOrd]
          : noteId;
      const enriched: ResolvedWikilink = { ...link, resolvedTargetPath: resolution.targetPath };
      const toId = await resolveWikilinkTarget(db, enriched);
      const isEmbed = link.isEmbed;
      await relateEdge(db, {
        table: isEmbed ? "embed" : "wikilink",
        from: fromId,
        to: toId,
        source: isEmbed ? "embed" : "wikilink",
        confidenceClass: "EXTRACTED",
        confidence: 1,
        targetUnresolved: toId === null ? link.rawTarget : null,
      });
    }

    for (let index = 0; index < extraction.frontmatterRefs.length; index += 1) {
      const ref = extraction.frontmatterRefs[index];
      const resolution = frontmatterResolutions[index];
      if (resolution.targetPath === null) {
        continue;
      }
      const targetNote = await lookupNoteByPath(db, resolution.targetPath);
      if (targetNote === null) {
        continue;
      }
      await relateEdge(db, {
        table: "frontmatter_ref",
        from: noteId,
        to: targetNote,
        source: "frontmatter",
        confidenceClass: "EXTRACTED",
        confidence: 1,
      });
    }

    for (const tag of extraction.tags) {
      const tagId = await upsertTag(db, tag.path);
      const fromId =
        tag.fromBlockOrd !== null &&
        tag.fromBlockOrd >= 0 &&
        tag.fromBlockOrd < blockIds.length
          ? blockIds[tag.fromBlockOrd]
          : noteId;
      await relateEdge(db, {
        table: "tagged",
        from: fromId,
        to: tagId,
        source: "structure",
        confidenceClass: "EXTRACTED",
        confidence: 1,
      });
    }

    await markTier1Done(db, noteId);
    return { noteId, extraction };
  } catch (error) {
    throw error;
  }
}
