import type { RecordId, Surreal } from "surrealdb";
import { TIER1_EDGE_CLASS, TIER1_EDGE_TABLES } from "../db/edgeTables";
import {
  findRecentDaemonWrite,
  lookupBlockByExplicitId,
  lookupBlockByHeading,
  lookupNoteByPath,
} from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import { extract } from "../markdown/extractor";
import { processAst } from "../markdown/pipeline";
import { resolveTargets } from "../markdown/resolver";
import { headingSlug } from "../markdown/slug";
import type { FrontmatterRefSpec, MarkdownExtraction, WikilinkSpec } from "../markdown/types";

/**
 * Tier 1 indexer: turns a saved note into deterministic SurrealDB edges.
 *
 * Spec: §5.2, Phase 2 plan §Task 12.
 *
 * Atomicity is delivered via a single SurrealQL script that begins with
 * `BEGIN TRANSACTION;` and ends with `COMMIT TRANSACTION;`. SurrealDB
 * rolls the entire script back when any statement inside the script
 * fails, so the note's `tier1_at` does not advance and no partial blocks
 * or edges remain on disk. Pre-resolution work (parse, extract, resolver,
 * existence checks for the active note and every tag, target lookups
 * for cross-note wikilinks and frontmatter refs) runs BEFORE the
 * transaction; the transaction only writes.
 *
 * Pre-existence checks let us emit `CREATE ONLY` for new rows. SurrealDB
 * 3.x silently no-ops `UPSERT ... WHERE ...` when an assertion would
 * reject the implied insert; `CREATE` raises the error and the
 * transaction rolls back. Notes that already exist take an `UPDATE` path
 * via the resolved record id.
 */

export interface Tier1Input {
  notePath: string;
  source: string;
  vaultPaths: string[];
  /**
   * Optional event bus for diagnostic notifications. Tier 1 emits
   * `indexer:warn` once per dropped frontmatter ref whose target does
   * not resolve (Phase 2 plan locked decision 7).
   */
  bus?: EventBus;
}

export interface Tier1Output {
  noteId: RecordId<"note">;
  extraction: MarkdownExtraction;
}

type WikilinkTarget =
  | { kind: "unresolved" }
  | { kind: "selfNote" }
  | { kind: "other"; recordId: RecordId<"note"> | RecordId<"block"> };

type FrontmatterTarget =
  | { kind: "unresolved" }
  | { kind: "selfNote" }
  | { kind: "other"; recordId: RecordId<"note"> };

async function resolveWikilinkTarget(
  db: Surreal,
  link: WikilinkSpec,
  resolvedTargetPath: string | null,
  activeNotePath: string,
): Promise<WikilinkTarget> {
  if (resolvedTargetPath === null) {
    return { kind: "unresolved" };
  }
  if (resolvedTargetPath === activeNotePath) {
    return { kind: "selfNote" };
  }
  const noteId = await lookupNoteByPath(db, resolvedTargetPath);
  if (noteId === null) {
    return { kind: "unresolved" };
  }
  if (link.targetBlockId !== null) {
    const blockId = await lookupBlockByExplicitId(db, noteId, link.targetBlockId);
    return { kind: "other", recordId: blockId ?? noteId };
  }
  if (link.targetHeading !== null) {
    const slug = headingSlug(link.targetHeading);
    if (slug.length > 0) {
      const blockId = await lookupBlockByHeading(db, noteId, slug);
      if (blockId !== null) {
        return { kind: "other", recordId: blockId };
      }
    }
    return { kind: "other", recordId: noteId };
  }
  return { kind: "other", recordId: noteId };
}

async function resolveFrontmatterTarget(
  db: Surreal,
  resolvedTargetPath: string | null,
  activeNotePath: string,
): Promise<FrontmatterTarget> {
  if (resolvedTargetPath === null) {
    return { kind: "unresolved" };
  }
  if (resolvedTargetPath === activeNotePath) {
    return { kind: "selfNote" };
  }
  const noteId = await lookupNoteByPath(db, resolvedTargetPath);
  if (noteId === null) {
    return { kind: "unresolved" };
  }
  return { kind: "other", recordId: noteId };
}

function emitFrontmatterWarnings(
  bus: EventBus | undefined,
  notePath: string,
  refs: FrontmatterRefSpec[],
  targets: FrontmatterTarget[],
): void {
  if (bus === undefined) {
    return;
  }
  for (let index = 0; index < refs.length; index += 1) {
    if (targets[index].kind !== "unresolved") {
      continue;
    }
    const ref = refs[index];
    bus.emit({
      type: "indexer:warn",
      phase: "tier1",
      message: `frontmatter ref dropped: key='${ref.key}' raw='${ref.rawTarget}' note='${notePath}'`,
    });
  }
}

async function lookupTagId(db: Surreal, tagPath: string): Promise<RecordId<"tag"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"tag"> }>]>("SELECT id FROM tag WHERE path = $path LIMIT 1;", {
      path: tagPath,
    })
    .collect<[Array<{ id: RecordId<"tag"> }>]>();
  return rows[0]?.id ?? null;
}

interface TransactionScript {
  sql: string;
  bindings: Record<string, unknown>;
}

function fromExpression(fromBlockOrd: number | null, blockCount: number): string {
  if (fromBlockOrd !== null && fromBlockOrd >= 0 && fromBlockOrd < blockCount) {
    return `$block${fromBlockOrd}`;
  }
  return "$noteId";
}

interface DaemonWriteOverride {
  agent: string;
  targets: Set<string>;
}

function resolveWikilinkSourceLabel(
  defaultSourceLabel: string,
  resolvedTargetKey: string | null,
  daemonOverride: DaemonWriteOverride | null,
): string {
  if (
    daemonOverride !== null &&
    resolvedTargetKey !== null &&
    daemonOverride.targets.has(resolvedTargetKey)
  ) {
    return daemonOverride.agent;
  }
  return defaultSourceLabel;
}

function buildTier1Transaction(
  notePath: string,
  extraction: MarkdownExtraction,
  existingNoteId: RecordId<"note"> | null,
  existingTagIds: Array<RecordId<"tag"> | null>,
  wikilinkTargets: WikilinkTarget[],
  frontmatterTargets: FrontmatterTarget[],
  daemonOverride: DaemonWriteOverride | null,
): TransactionScript {
  const statements: string[] = [];
  const bindings: Record<string, unknown> = {
    notePath,
    sha: extraction.bodySha,
    wordCount: extraction.wordCount,
    tier1Class: TIER1_EDGE_CLASS,
  };

  statements.push("BEGIN TRANSACTION;");

  if (existingNoteId !== null) {
    bindings.existingNoteId = existingNoteId;
    statements.push("UPDATE $existingNoteId SET sha = $sha, word_count = $wordCount;");
    statements.push("LET $noteId = $existingNoteId;");
  } else {
    statements.push(
      "LET $noteId = (CREATE ONLY note CONTENT { path: $notePath, sha: $sha, word_count: $wordCount }).id;",
    );
  }

  for (const table of TIER1_EDGE_TABLES) {
    // Walk the edge's `in` record to its host note. For block-rooted edges
    // `in.note` resolves; for note-rooted edges `in` is the note itself.
    statements.push(
      `DELETE ${table} WHERE class = $tier1Class AND (in = $noteId OR in.note = $noteId);`,
    );
  }
  statements.push("DELETE wikilink_unresolved WHERE in = $noteId OR in.note = $noteId;");
  statements.push("DELETE embed_unresolved WHERE in = $noteId OR in.note = $noteId;");
  statements.push("DELETE block WHERE note = $noteId;");

  const blocks = extraction.blocks;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const fields: string[] = [
      "note: $noteId",
      `ord: $block${index}_ord`,
      `start_line: $block${index}_startLine`,
      `end_line: $block${index}_endLine`,
      `text: $block${index}_text`,
      `heading_path: $block${index}_headingPath`,
    ];
    bindings[`block${index}_ord`] = block.ord;
    bindings[`block${index}_startLine`] = block.startLine;
    bindings[`block${index}_endLine`] = block.endLine;
    bindings[`block${index}_text`] = block.text;
    bindings[`block${index}_headingPath`] = block.headingPath;
    if (block.blockId !== null) {
      fields.push(`block_id: $block${index}_blockId`);
      bindings[`block${index}_blockId`] = block.blockId;
    }
    if (block.headingSlug !== null) {
      fields.push(`heading_slug: $block${index}_headingSlug`);
      bindings[`block${index}_headingSlug`] = block.headingSlug;
    }
    if (block.headingLevel !== null) {
      fields.push(`heading_level: $block${index}_headingLevel`);
      bindings[`block${index}_headingLevel`] = block.headingLevel;
    }
    statements.push(
      `LET $block${index} = (CREATE ONLY block CONTENT { ${fields.join(", ")} }).id;`,
    );
  }

  let currentHeadingIndex: number | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    statements.push(
      `RELATE $block${index} -> contained_in -> $noteId SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
    );
    if (block.headingLevel !== null) {
      currentHeadingIndex = index;
      continue;
    }
    if (currentHeadingIndex !== null) {
      statements.push(
        `RELATE $block${index} -> under_heading -> $block${currentHeadingIndex} SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
      );
    }
  }

  for (let index = 0; index < extraction.wikilinks.length; index += 1) {
    const link = extraction.wikilinks[index];
    const target = wikilinkTargets[index];
    const fromExpr = fromExpression(link.fromBlockOrd, blocks.length);
    const isEmbed = link.isEmbed;
    const defaultSourceLabel = isEmbed ? "embed" : "wikilink";

    if (target.kind === "unresolved") {
      const unresolvedTable = isEmbed ? "embed_unresolved" : "wikilink_unresolved";
      bindings[`wl${index}_rawTarget`] = link.rawTarget;
      bindings[`wl${index}_source`] = defaultSourceLabel;
      statements.push(
        `CREATE ${unresolvedTable} CONTENT { in: ${fromExpr}, raw_target: $wl${index}_rawTarget, source: $wl${index}_source };`,
      );
      continue;
    }

    let toExpr: string;
    let resolvedTargetKey: string | null;
    if (target.kind === "selfNote") {
      toExpr = "$noteId";
      // Self-note edges (resolved back to the active note) do not have a
      // pre-known record-id string to match against `daemon_write.targets`,
      // so we leave them with the default source. Phase 4 writebacks never
      // record the active note as a self-target.
      resolvedTargetKey = null;
    } else {
      bindings[`wl${index}_target`] = target.recordId;
      toExpr = `$wl${index}_target`;
      resolvedTargetKey = target.recordId.toString();
    }
    const edgeTable = isEmbed ? "embed" : "wikilink";
    bindings[`wl${index}_source`] = resolveWikilinkSourceLabel(
      defaultSourceLabel,
      resolvedTargetKey,
      daemonOverride,
    );
    statements.push(
      `RELATE ${fromExpr} -> ${edgeTable} -> ${toExpr} SET source = $wl${index}_source, class = 'EXTRACTED', confidence = 1;`,
    );
  }

  for (let index = 0; index < extraction.frontmatterRefs.length; index += 1) {
    const target = frontmatterTargets[index];
    if (target.kind === "unresolved") {
      continue;
    }
    let toExpr: string;
    if (target.kind === "selfNote") {
      toExpr = "$noteId";
    } else {
      bindings[`fm${index}_target`] = target.recordId;
      toExpr = `$fm${index}_target`;
    }
    statements.push(
      `RELATE $noteId -> frontmatter_ref -> ${toExpr} SET source = 'frontmatter', class = 'EXTRACTED', confidence = 1;`,
    );
  }

  for (let index = 0; index < extraction.tags.length; index += 1) {
    const tag = extraction.tags[index];
    const existingTagId = existingTagIds[index];
    if (existingTagId !== null) {
      bindings[`tag${index}_existingId`] = existingTagId;
      statements.push(`LET $tag${index} = $tag${index}_existingId;`);
    } else {
      bindings[`tag${index}_path`] = tag.path;
      statements.push(
        `LET $tag${index} = (CREATE ONLY tag CONTENT { path: $tag${index}_path }).id;`,
      );
    }
    const fromExpr = fromExpression(tag.fromBlockOrd, blocks.length);
    statements.push(
      `RELATE ${fromExpr} -> tagged -> $tag${index} SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
    );
  }

  statements.push("UPDATE $noteId SET tier1_at = time::now();");
  statements.push("COMMIT TRANSACTION;");

  return { sql: statements.join("\n"), bindings };
}

export async function runTier1(db: Surreal, input: Tier1Input): Promise<Tier1Output> {
  const ast = processAst(input.source);
  const extraction = extract(ast, input.notePath, input.source);

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

  const [existingNoteId, wikilinkTargets, frontmatterTargets, existingTagIds] = await Promise.all([
    lookupNoteByPath(db, input.notePath),
    Promise.all(
      extraction.wikilinks.map((link, index) =>
        resolveWikilinkTarget(db, link, wikilinkResolutions[index].targetPath, input.notePath),
      ),
    ),
    Promise.all(
      frontmatterResolutions.map((resolution) =>
        resolveFrontmatterTarget(db, resolution.targetPath, input.notePath),
      ),
    ),
    Promise.all(extraction.tags.map((tag) => lookupTagId(db, tag.path))),
  ]);

  // The daemon_write audit row lives in SurrealDB and references the note
  // by record id. Only an existing note can have one, so we skip the lookup
  // for first-time-seen notes. The lookup runs exactly once per `runTier1`
  // invocation; the resulting target set is consulted for each wikilink
  // and embed edge that resolves to a record id.
  let daemonOverride: DaemonWriteOverride | null = null;
  if (existingNoteId !== null) {
    const match = await findRecentDaemonWrite(db, {
      noteId: existingNoteId,
      sha: extraction.bodySha,
    });
    if (match !== null) {
      daemonOverride = {
        agent: match.agent,
        targets: new Set(match.targets.map((target) => target.toString())),
      };
    }
  }

  const { sql, bindings } = buildTier1Transaction(
    input.notePath,
    extraction,
    existingNoteId,
    existingTagIds,
    wikilinkTargets,
    frontmatterTargets,
    daemonOverride,
  );

  await db.query(sql, bindings).collect();

  emitFrontmatterWarnings(
    input.bus,
    input.notePath,
    extraction.frontmatterRefs,
    frontmatterTargets,
  );

  const noteId = await lookupNoteByPath(db, input.notePath);
  if (noteId === null) {
    throw new Error(`runTier1: note not found by path '${input.notePath}' after commit.`);
  }
  return { noteId, extraction };
}
