import type { RecordId, Surreal } from "surrealdb";
import { TIER1_EDGE_CLASS, TIER1_EDGE_TABLES } from "../db/edgeTables";
import {
  clearTierAtByPath,
  createNote,
  fetchNoteShaByPath,
  findRecentDaemonWrite,
  lookupBlockByExplicitId,
  lookupBlockByHeading,
  lookupNoteByPath,
  lookupNoteIdsByPaths,
} from "../db/surreal";
import { type EventBus, assertEventBus } from "../events/eventBus";
import { extract } from "../markdown/extractor";
import { processAst } from "../markdown/pipeline";
import { resolveMarkdownTarget, resolveTargets } from "../markdown/resolver";
import { headingSlug } from "../markdown/slug";
import { STRUCTURAL_INDEX_VERSION } from "../markdown/types";
import type { FrontmatterRefSpec, MarkdownExtraction, NoteLinkSpec } from "../markdown/types";
import { type ReferenceTarget, referenceTargets } from "./referenceTargets";

/**
 * Tier 1 indexer: turns a saved note into deterministic SurrealDB edges.
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
  /** Orchestrated indexing completes Tier 1 only after lexical chunks commit. */
  deferCompletion?: boolean;
  notePath: string;
  source: string;
  vaultPaths: string[];
  /** Receives an `indexer:warn` for each unresolved frontmatter reference. */
  bus: EventBus;
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
  link: NoteLinkSpec,
  resolvedTargetPath: string | null,
  activeNotePath: string,
  noteIdsByPath: ReadonlyMap<string, RecordId<"note">>,
): Promise<WikilinkTarget> {
  if (resolvedTargetPath === null) {
    return { kind: "unresolved" };
  }
  if (resolvedTargetPath === activeNotePath) {
    return { kind: "selfNote" };
  }
  const noteId = noteIdsByPath.get(resolvedTargetPath) ?? null;
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

function resolveFrontmatterTarget(
  resolvedTargetPath: string | null,
  activeNotePath: string,
  noteIdsByPath: ReadonlyMap<string, RecordId<"note">>,
): FrontmatterTarget {
  if (resolvedTargetPath === null) {
    return { kind: "unresolved" };
  }
  if (resolvedTargetPath === activeNotePath) {
    return { kind: "selfNote" };
  }
  const noteId = noteIdsByPath.get(resolvedTargetPath) ?? null;
  if (noteId === null) {
    return { kind: "unresolved" };
  }
  return { kind: "other", recordId: noteId };
}

function emitFrontmatterWarnings(
  bus: EventBus,
  notePath: string,
  refs: FrontmatterRefSpec[],
  targets: FrontmatterTarget[],
): void {
  for (let index = 0; index < refs.length; index += 1) {
    if (targets[index].kind !== "unresolved") {
      continue;
    }
    const ref = refs[index];
    bus.emit({
      type: "indexer:warn",
      phase: "tier1",
      message: `frontmatter ref unresolved: key='${ref.key}' raw='${ref.rawTarget}' note='${notePath}'`,
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

/**
 * Returns the record ids of every `block` row currently anchored to `noteId`,
 * sorted by `ord`. Tier 1's transaction script reuses these slots in place
 * via UPDATE rather than DELETE+CREATE because SurrealDB 2.x mishandles
 * same-table DELETE-then-CREATE inside a single transaction: the engine
 * reorders or coalesces the operations and a subset of the deleted rows
 * survives the commit, leaking duplicate blocks across re-runs. Reusing the
 * existing record ids avoids the conflict entirely.
 */
async function listBlockIdsForNote(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<Array<RecordId<"block">>> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block">; ord: number }>]>(
      "SELECT id, ord FROM block WHERE note = $note ORDER BY ord;",
      { note: noteId },
    )
    .collect<[Array<{ id: RecordId<"block">; ord: number }>]>();
  return rows.map((row) => row.id);
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

function resolveDaemonAttribution(
  resolvedTargetKey: string | null,
  daemonOverride: DaemonWriteOverride | null,
): string | null {
  if (
    daemonOverride !== null &&
    resolvedTargetKey !== null &&
    daemonOverride.targets.has(resolvedTargetKey)
  ) {
    return daemonOverride.agent;
  }
  return null;
}

interface Tier1TransactionState {
  statements: string[];
  bindings: Record<string, unknown>;
}

function appendNoteWrite(
  state: Tier1TransactionState,
  existingNoteId: RecordId<"note"> | null,
): void {
  if (existingNoteId !== null) {
    state.bindings.existingNoteId = existingNoteId;
    state.statements.push("UPDATE $existingNoteId SET sha = $sha, word_count = $wordCount;");
    state.statements.push("LET $noteId = $existingNoteId;");
    return;
  }
  state.statements.push(
    "LET $noteId = (CREATE ONLY note CONTENT { path: $notePath, sha: $sha, word_count: $wordCount }).id;",
  );
}

function appendTier1EdgeCleanup(
  state: Tier1TransactionState,
  existingBlockIds: Array<RecordId<"block">>,
): void {
  // Bind the pre-fetched block-id snapshot once. Edge cleanup targets the
  // set explicitly so the per-table DELETE never walks `in.note` through
  // the very rows we are about to mutate; the graph-walk variant tripped
  // a SurrealDB 2.x quirk where DELETE+CREATE on the same table inside one
  // transaction left a subset of the original rows on disk. Filtering on
  // `class` keeps Tier 3 edges (class = 'INFERRED') safe.
  state.bindings.oldBlockIds = existingBlockIds;
  for (const table of TIER1_EDGE_TABLES) {
    state.statements.push(
      `DELETE ${table} WHERE class = $tier1Class AND (in = $noteId OR in IN $oldBlockIds);`,
    );
  }
  state.statements.push("DELETE wikilink_unresolved WHERE in = $noteId OR in IN $oldBlockIds;");
  state.statements.push("DELETE embed_unresolved WHERE in = $noteId OR in IN $oldBlockIds;");
}

function blockContentFields(
  state: Tier1TransactionState,
  block: MarkdownExtraction["blocks"][number],
  index: number,
): string[] {
  const fields = [
    "note: $noteId",
    `ord: $block${index}_ord`,
    `start_line: $block${index}_startLine`,
    `end_line: $block${index}_endLine`,
    `text: $block${index}_text`,
    `heading_path: $block${index}_headingPath`,
  ];
  state.bindings[`block${index}_ord`] = block.ord;
  state.bindings[`block${index}_startLine`] = block.startLine;
  state.bindings[`block${index}_endLine`] = block.endLine;
  state.bindings[`block${index}_text`] = block.text;
  state.bindings[`block${index}_headingPath`] = block.headingPath;
  // `block_id`, `heading_slug`, and `heading_level` are `option<...>` in
  // the schema; we always set them so reused rows shed stale values when
  // the new extraction has none for that slot. JavaScript `undefined`
  // serializes to SurrealQL `NONE`, which is the empty branch of an
  // `option<T>` and satisfies every relevant ASSERT. JavaScript `null`
  // would be sent as a typed null and trip the ASSERT for option<string>.
  fields.push(`block_id: $block${index}_blockId`);
  state.bindings[`block${index}_blockId`] = block.blockId ?? undefined;
  fields.push(`heading_slug: $block${index}_headingSlug`);
  state.bindings[`block${index}_headingSlug`] = block.headingSlug ?? undefined;
  fields.push(`heading_level: $block${index}_headingLevel`);
  state.bindings[`block${index}_headingLevel`] = block.headingLevel ?? undefined;
  return fields;
}

function appendBlockWrites(
  state: Tier1TransactionState,
  blocks: MarkdownExtraction["blocks"],
  existingBlockIds: Array<RecordId<"block">>,
): void {
  // Block reuse strategy. SurrealDB 2.x reorders same-table DELETE+CREATE
  // pairs inside a single transaction, so the original "DELETE block /
  // CREATE block" pattern silently leaked the un-uniquely-keyed rows
  // (heading-aggregated blocks have no `block_id` and therefore no unique
  // index to force the delete). We avoid the conflict by reusing existing
  // record ids in place via UPDATE for the overlapping prefix, only
  // CREATE-ing rows when the new extraction is longer than the old, and
  // only DELETE-ing rows when it is shorter. UPDATE and CREATE coexist
  // without engine reordering; DELETE-only-the-surplus has no CREATE on
  // the same table after it.
  const reuseCount = Math.min(blocks.length, existingBlockIds.length);
  for (let index = 0; index < blocks.length; index += 1) {
    const fields = blockContentFields(state, blocks[index], index);
    if (index < reuseCount) {
      state.bindings[`block${index}_existingId`] = existingBlockIds[index];
      state.statements.push(`UPDATE $block${index}_existingId CONTENT { ${fields.join(", ")} };`);
      state.statements.push(`LET $block${index} = $block${index}_existingId;`);
      continue;
    }
    state.statements.push(
      `LET $block${index} = (CREATE ONLY block CONTENT { ${fields.join(", ")} }).id;`,
    );
  }

  if (existingBlockIds.length > blocks.length) {
    state.bindings.surplusBlockIds = existingBlockIds.slice(blocks.length);
    state.statements.push("DELETE block WHERE id IN $surplusBlockIds;");
  }
}

function appendBlockRelations(statements: string[], blocks: MarkdownExtraction["blocks"]): void {
  let currentHeadingIndex: number | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    statements.push(
      `RELATE $block${index} -> contained_in -> $noteId SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
    );
    if (blocks[index].headingLevel !== null) {
      currentHeadingIndex = index;
      continue;
    }
    if (currentHeadingIndex !== null) {
      statements.push(
        `RELATE $block${index} -> under_heading -> $block${currentHeadingIndex} SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
      );
    }
  }
}

type ResolvedEdgeTarget = Exclude<WikilinkTarget | FrontmatterTarget, { kind: "unresolved" }>;

function bindResolvedTarget(
  state: Tier1TransactionState,
  target: ResolvedEdgeTarget,
  bindingPrefix: string,
): { toExpr: string; resolvedTargetKey: string | null } {
  if (target.kind === "selfNote") {
    return { toExpr: "$noteId", resolvedTargetKey: null };
  }
  state.bindings[`${bindingPrefix}_target`] = target.recordId;
  return {
    toExpr: `$${bindingPrefix}_target`,
    resolvedTargetKey: target.recordId.toString(),
  };
}

function appendWikilink(
  state: Tier1TransactionState,
  link: NoteLinkSpec,
  target: WikilinkTarget,
  index: number,
  blockCount: number,
  daemonOverride: DaemonWriteOverride | null,
): void {
  const fromExpr = fromExpression(link.fromBlockOrd, blockCount);
  // The existing structural relation table also stores Markdown destinations;
  // provenance preserves the authored syntax without migrating stable edges.
  const defaultSourceLabel =
    link.syntax === "markdown" ? "markdown" : link.isEmbed ? "embed" : "wikilink";
  if (target.kind === "unresolved") {
    const unresolvedTable = link.isEmbed ? "embed_unresolved" : "wikilink_unresolved";
    state.bindings[`wl${index}_rawTarget`] = link.rawTarget;
    state.bindings[`wl${index}_source`] = defaultSourceLabel;
    state.statements.push(
      `CREATE ${unresolvedTable} CONTENT { in: ${fromExpr}, raw_target: $wl${index}_rawTarget, source: $wl${index}_source };`,
    );
    return;
  }
  const { toExpr, resolvedTargetKey } = bindResolvedTarget(state, target, `wl${index}`);
  const edgeTable = link.isEmbed ? "embed" : "wikilink";
  state.bindings[`wl${index}_source`] = defaultSourceLabel;
  const attributedAgent = resolveDaemonAttribution(resolvedTargetKey, daemonOverride);
  const agentClause = attributedAgent === null ? "" : `, agent = $wl${index}_agent`;
  if (attributedAgent !== null) state.bindings[`wl${index}_agent`] = attributedAgent;
  state.statements.push(
    `RELATE ${fromExpr} -> ${edgeTable} -> ${toExpr} SET source = $wl${index}_source, class = 'EXTRACTED', confidence = 1${agentClause};`,
  );
}

function appendWikilinks(
  state: Tier1TransactionState,
  extraction: MarkdownExtraction,
  targets: WikilinkTarget[],
  daemonOverride: DaemonWriteOverride | null,
): void {
  for (let index = 0; index < extraction.links.length; index += 1) {
    appendWikilink(
      state,
      extraction.links[index],
      targets[index],
      index,
      extraction.blocks.length,
      daemonOverride,
    );
  }
}

function appendFrontmatterRef(
  state: Tier1TransactionState,
  target: FrontmatterTarget,
  index: number,
  daemonOverride: DaemonWriteOverride | null,
): void {
  if (target.kind === "unresolved") return;
  const { toExpr, resolvedTargetKey } = bindResolvedTarget(state, target, `fm${index}`);
  state.bindings[`fm${index}_source`] = "frontmatter";
  const attributedAgent = resolveDaemonAttribution(resolvedTargetKey, daemonOverride);
  const agentClause = attributedAgent === null ? "" : `, agent = $fm${index}_agent`;
  if (attributedAgent !== null) state.bindings[`fm${index}_agent`] = attributedAgent;
  state.statements.push(
    `RELATE $noteId -> frontmatter_ref -> ${toExpr} SET source = $fm${index}_source, class = 'EXTRACTED', confidence = 1${agentClause};`,
  );
}

function appendFrontmatterRefs(
  state: Tier1TransactionState,
  refCount: number,
  targets: FrontmatterTarget[],
  daemonOverride: DaemonWriteOverride | null,
): void {
  for (let index = 0; index < refCount; index += 1) {
    appendFrontmatterRef(state, targets[index], index, daemonOverride);
  }
}

function bindTagVariable(
  state: Tier1TransactionState,
  path: string,
  existingTagId: RecordId<"tag"> | null,
  index: number,
  tagVarByPath: Map<string, string>,
): string {
  const existingTagVar = tagVarByPath.get(path);
  if (existingTagVar !== undefined) return existingTagVar;
  const tagVar = `$tag${index}`;
  tagVarByPath.set(path, tagVar);
  if (existingTagId !== null) {
    state.bindings[`tag${index}_existingId`] = existingTagId;
    state.statements.push(`LET $tag${index} = $tag${index}_existingId;`);
    return tagVar;
  }
  state.bindings[`tag${index}_path`] = path;
  state.statements.push(
    `LET $tag${index} = (CREATE ONLY tag CONTENT { path: $tag${index}_path }).id;`,
  );
  return tagVar;
}

function appendTags(
  state: Tier1TransactionState,
  extraction: MarkdownExtraction,
  existingTagIds: Array<RecordId<"tag"> | null>,
): void {
  const tagVarByPath = new Map<string, string>();
  for (let index = 0; index < extraction.tags.length; index += 1) {
    const tag = extraction.tags[index];
    const tagVar = bindTagVariable(state, tag.path, existingTagIds[index], index, tagVarByPath);
    const fromExpr = fromExpression(tag.fromBlockOrd, extraction.blocks.length);
    state.statements.push(
      `RELATE ${fromExpr} -> tagged -> ${tagVar} SET source = 'structure', class = 'EXTRACTED', confidence = 1;`,
    );
  }
}

function buildTier1Transaction(
  notePath: string,
  extraction: MarkdownExtraction,
  existingNoteId: RecordId<"note"> | null,
  existingBlockIds: Array<RecordId<"block">>,
  existingTagIds: Array<RecordId<"tag"> | null>,
  wikilinkTargets: WikilinkTarget[],
  frontmatterTargets: FrontmatterTarget[],
  references: ReferenceTarget[],
  daemonOverride: DaemonWriteOverride | null,
  deferCompletion = false,
): TransactionScript {
  const state: Tier1TransactionState = {
    statements: ["BEGIN TRANSACTION;"],
    bindings: {
      notePath,
      sha: extraction.bodySha,
      wordCount: extraction.wordCount,
      tier1Class: TIER1_EDGE_CLASS,
      structuralVersion: STRUCTURAL_INDEX_VERSION,
      referenceTargets: JSON.stringify(references),
    },
  };
  appendNoteWrite(state, existingNoteId);
  state.statements.push("UPDATE $noteId SET reference_targets = $referenceTargets;");
  appendTier1EdgeCleanup(state, existingBlockIds);
  appendBlockWrites(state, extraction.blocks, existingBlockIds);
  appendBlockRelations(state.statements, extraction.blocks);
  appendWikilinks(state, extraction, wikilinkTargets, daemonOverride);
  appendFrontmatterRefs(
    state,
    extraction.frontmatterRefs.length,
    frontmatterTargets,
    daemonOverride,
  );
  appendTags(state, extraction, existingTagIds);
  state.statements.push(
    deferCompletion
      ? "UPDATE $noteId SET tier1_at = NONE, structural_version = $structuralVersion;"
      : "UPDATE $noteId SET tier1_at = time::now(), structural_version = $structuralVersion;",
  );
  state.statements.push("COMMIT TRANSACTION;");
  return { sql: state.statements.join("\n"), bindings: state.bindings };
}

export interface PrepareNoteRowInput {
  path: string;
  sha: string;
  wordCount: number;
}

/**
 * Pre-create (or refresh) the bare `note` row for a given path so cross-note
 * edge resolution inside `runTier1` can succeed on a single awaken pass.
 *
 * Bug fix context. `runTier1` resolves wikilink and frontmatter_ref targets
 * by calling `lookupNoteByPath`. When a note is processed before its
 * neighbour is known to the database, those lookups return null:
 * wikilinks fall back to the recoverable `wikilink_unresolved` table, but
 * frontmatter_refs are silently dropped. Pre-creating every note row
 * before the per-note loop guarantees the lookups find a target. The
 * pre-create writes only `path`, `sha`, and `word_count`; it never
 * advances `tier1_at`/`tier2_at`/`tier3_at`, never deletes blocks, and
 * never relates edges. Tier 1's existing transaction continues to own
 * those mutations and will overwrite the placeholder `sha`/`word_count`
 * with the freshly extracted values when it runs against the same path.
 *
 * Idempotent. Calling it twice with the same input is a no-op write of
 * the same scalar fields. The caller orchestrates the two phases:
 * `prepareNoteRow` first for every queued path, then the indexer drains
 * its queue and `runTier1` walks the AST as before. `runTier1` does not
 * call `prepareNoteRow` itself.
 */
export async function prepareNoteRow(db: Surreal, input: PrepareNoteRowInput): Promise<void> {
  const existing = await lookupNoteByPath(db, input.path);
  if (existing !== null) {
    const storedSha = await fetchNoteShaByPath(db, input.path);
    if (storedSha !== input.sha) {
      await clearTierAtByPath(db, input.path, [1, 2, 3]);
    }
    await db
      .query("UPDATE $id SET sha = $sha, word_count = $wordCount;", {
        id: existing,
        sha: input.sha,
        wordCount: input.wordCount,
      })
      .collect();
    return;
  }
  await createNote(db, input);
}

export async function runTier1(db: Surreal, input: Tier1Input): Promise<Tier1Output> {
  assertEventBus(input.bus, "runTier1");
  const ast = processAst(input.source);
  const extraction = extract(ast, input.notePath, input.source);

  const wikilinkResolutions = resolveTargets(
    input.notePath,
    extraction.links.map((wikilink) => ({
      rawTarget: wikilink.rawTarget,
      targetHeading: wikilink.targetHeading,
      targetBlockId: wikilink.targetBlockId,
    })),
    input.vaultPaths,
  ).map((resolution, index) =>
    extraction.links[index].syntax === "markdown"
      ? {
          ...resolution,
          targetPath: resolveMarkdownTarget(input.notePath, resolution.rawTarget, input.vaultPaths),
        }
      : resolution,
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

  // One batched `path -> note id` resolution for every link target on this
  // note (wikilinks + frontmatter refs) instead of one round-trip per link.
  const targetPaths: string[] = [];
  for (const resolution of wikilinkResolutions) {
    if (resolution.targetPath !== null) targetPaths.push(resolution.targetPath);
  }
  for (const resolution of frontmatterResolutions) {
    if (resolution.targetPath !== null) targetPaths.push(resolution.targetPath);
  }
  const noteIdsByPath = await lookupNoteIdsByPaths(db, targetPaths);

  const [existingNoteId, wikilinkTargets, existingTagIds] = await Promise.all([
    lookupNoteByPath(db, input.notePath),
    // Block-anchored wikilinks still need a per-link `block` lookup; plain
    // note targets are served entirely from `noteIdsByPath`.
    Promise.all(
      extraction.links.map((link, index) =>
        resolveWikilinkTarget(
          db,
          link,
          wikilinkResolutions[index].targetPath,
          input.notePath,
          noteIdsByPath,
        ),
      ),
    ),
    Promise.all(extraction.tags.map((tag) => lookupTagId(db, tag.path))),
  ]);
  const frontmatterTargets = frontmatterResolutions.map((resolution) =>
    resolveFrontmatterTarget(resolution.targetPath, input.notePath, noteIdsByPath),
  );

  // Fetching block ids is sequential after `existingNoteId` resolves
  // because the lookup needs the note record id. First-time-seen notes
  // skip the round-trip and start with an empty slot list.
  const existingBlockIds: Array<RecordId<"block">> =
    existingNoteId === null ? [] : await listBlockIdsForNote(db, existingNoteId);

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
    existingBlockIds,
    existingTagIds,
    wikilinkTargets,
    frontmatterTargets,
    referenceTargets(input.notePath, extraction, input.vaultPaths).map((ref, index) => ({
      ...ref,
      resolved:
        (index < wikilinkTargets.length
          ? wikilinkTargets[index]
          : frontmatterTargets[index - wikilinkTargets.length]
        ).kind === "unresolved"
          ? null
          : ref.resolved,
    })),
    daemonOverride,
    input.deferCompletion,
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
