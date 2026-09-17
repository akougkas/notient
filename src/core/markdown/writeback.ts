import { detectNewline, locateFrontmatter, patchFrontmatter, readFrontmatter } from "./frontmatter";
import { parseWikilinkInner } from "./plugins/remarkWikilink";

/**
 * Byte-range splicing writeback for approved cross-document edges.
 *
 * Two pure entry points:
 *   applyApprovedLink     appends a `[[target]]` (or qualified variant) under
 *                         a `## Related` H2, creating the section at the end
 *                         of the file when absent.
 *   applyApprovedRelation appends `[[target]]` to the
 *                         `frontmatter.notient.<key>` array, creating the
 *                         frontmatter and `notient` mapping if absent.
 *
 * remark's stringifier is a *normalizer*: it rewrites `- [ ] task` to `- task`,
 * escapes `> [!note]` to
 * `> \[!note]`, and turns `$a_i$` into `$a\_i$` and `5 * 3` into `5 \* 3`.
 * Running it over a note the user wrote is data loss, so no write path may
 * re-serialize a document. Instead both functions locate an offset in the
 * ORIGINAL text and splice; every byte outside the inserted range is
 * preserved exactly, including newline style, indentation, trailing-newline
 * convention and any syntax remark does not model.
 *
 * The remark pipeline remains the reader (AST, blocks, links). It is not on
 * any write path.
 *
 * Both functions are pure and idempotent: when the approved edge is already
 * present the original `source` is returned byte-for-byte.
 *
 * Failure-semantics contract, owned by `ApprovalService.approveEdge`:
 *   1. UPDATE edge SET approved = true, applied = false.
 *   2. Run `applyApprovedLink` / `applyApprovedRelation` in memory.
 *   3. If output equals input, flip `applied = true` and finish (idempotent
 *      no-op).
 *   4. Otherwise: insert a `daemon_write` row, perform the atomic file
 *      write, then a single SurrealDB transaction inserts the `history`
 *      row and flips `applied = true`.
 *
 * On crash anywhere between steps 1 and 4, daemon start runs
 * `ApprovalService.reconcilePendingApplications`, which selects rows with
 * `approved = true AND applied = false` and replays the flow from step 2.
 */

export interface ApplyApprovedLinkInput {
  target: string;
  heading?: string;
  block?: string;
}

export interface ApplyApprovedRelationInput {
  key: string;
  target: string;
}

interface LineSpan {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the last content character (before the terminator). */
  contentEnd: number;
  /** `\n`, `\r\n`, or `""` for a final line with no terminator. */
  term: string;
}

const RELATED_HEADING = /^[ \t]{0,3}##[ \t]+related[ \t]*$/i;
const HEADING_LE_H2 = /^[ \t]{0,3}#{1,2}[ \t]+/;
const ANY_HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/;
const LIST_ITEM = /^([ \t]{0,3})[-+*][ \t]+/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const COMPLETE_WIKILINK = /^\[\[([^\]\n]+?)\]\]$/;

interface FenceState {
  character: "`" | "~";
  length: number;
}

interface InsertionAnchor {
  line: number;
  kind: "heading" | "content" | "list";
}

interface VisibleLine {
  index: number;
  raw: string;
}

function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const index = text.indexOf("\n", cursor);
    if (index === -1) {
      lines.push({ start: cursor, contentEnd: text.length, term: "" });
      break;
    }
    const hasCr = index > cursor && text[index - 1] === "\r";
    lines.push({
      start: cursor,
      contentEnd: hasCr ? index - 1 : index,
      term: hasCr ? "\r\n" : "\n",
    });
    cursor = index + 1;
  }
  // A text ending in a newline yields a trailing zero-length span; drop it so
  // "last non-empty line" logic does not have to special-case it.
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last !== undefined && last.term === "" && last.start === text.length) {
    lines.pop();
  }
  return lines;
}

function lineText(text: string, line: LineSpan): string {
  return text.slice(line.start, line.contentEnd);
}

function formatWikilink(target: string, heading: string | null, block: string | null): string {
  let body = target;
  if (heading !== null) {
    body += `#${heading}`;
  } else if (block !== null) {
    body += `#^${block}`;
  }
  return `[[${body}]]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches `[[target]]` and `[[target|alias]]` (alias is display-only, so an
 * aliased link is the same edge) but never `![[target]]`: an embed is
 * transclusion, a link is a reference, and they are distinct edge kinds.
 */
function linkPresencePattern(target: string, heading: string | null, block: string | null): RegExp {
  let body = escapeRegExp(target);
  if (heading !== null) {
    body += `#${escapeRegExp(heading)}`;
  } else if (block !== null) {
    body += `#\\^${escapeRegExp(block)}`;
  }
  return new RegExp(`(^|[^!])\\[\\[${body}(\\|[^\\]\\n]*)?\\]\\]`);
}

function nextFenceState(raw: string, state: FenceState | null): FenceState | null {
  const match = raw.match(FENCE);
  if (match === null) return state;
  const marker = match[1];
  const character = marker[0] as "`" | "~";
  if (state === null) return { character, length: marker.length };
  if (character !== state.character || marker.length < state.length) return state;
  return match[2].trim().length === 0 ? null : state;
}

function firstBodyLine(lines: LineSpan[], bodyStart: number): number {
  const index = lines.findIndex((line) => line.start >= bodyStart);
  return index === -1 ? lines.length : index;
}

function closeOpenFenceAtEof(
  source: string,
  lines: LineSpan[],
  startLine: number,
  newline: string,
): string {
  let fence: FenceState | null = null;
  for (let index = startLine; index < lines.length; index += 1) {
    const raw = bodyLineText(source, lines[index], index === startLine);
    fence = nextFenceState(raw, fence);
  }
  if (fence === null) return source;
  const marker = fence.character.repeat(fence.length);
  return source.endsWith("\n") ? `${source}${marker}${newline}` : `${source}${newline}${marker}`;
}

function bodyLineText(text: string, line: LineSpan, firstBodyLine: boolean): string {
  const raw = lineText(text, line);
  return firstBodyLine && raw.startsWith("﻿") ? raw.slice(1) : raw;
}

/** Index of the first body `## Related` heading outside a fenced code block. */
function findRelatedHeadingLine(text: string, lines: LineSpan[], startLine: number): number {
  let fence: FenceState | null = null;
  for (let index = startLine; index < lines.length; index += 1) {
    const raw = bodyLineText(text, lines[index], index === startLine);
    const next = nextFenceState(raw, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence !== null) continue;
    if (RELATED_HEADING.test(raw)) return index;
  }
  return -1;
}

/** First line index after the `## Related` section (next H1/H2, or EOF). */
function findSectionEndLine(text: string, lines: LineSpan[], headingLine: number): number {
  let fence: FenceState | null = null;
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    const raw = lineText(text, lines[index]);
    const next = nextFenceState(raw, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence !== null) continue;
    if (HEADING_LE_H2.test(raw)) return index;
  }
  return lines.length;
}

function sectionContainsLink(
  text: string,
  lines: LineSpan[],
  headingLine: number,
  sectionEnd: number,
  presence: RegExp,
): boolean {
  let fence: FenceState | null = null;
  for (let index = headingLine + 1; index < sectionEnd; index += 1) {
    const raw = lineText(text, lines[index]);
    const next = nextFenceState(raw, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence === null && presence.test(raw)) return true;
  }
  return false;
}

function findInsertionAnchor(
  text: string,
  lines: LineSpan[],
  headingLine: number,
  sectionEnd: number,
): InsertionAnchor {
  const visible = topLevelSectionLines(text, lines, headingLine, sectionEnd);
  const firstListAt = visible.findIndex((line) => LIST_ITEM.test(line.raw));
  if (firstListAt !== -1) {
    return listInsertionAnchor(visible, firstListAt);
  }
  const content = lastNonBlankLine(visible);
  return content === null
    ? { line: headingLine, kind: "heading" }
    : { line: content.index, kind: "content" };
}

function topLevelSectionLines(
  text: string,
  lines: LineSpan[],
  headingLine: number,
  sectionEnd: number,
): VisibleLine[] {
  let fence: FenceState | null = null;
  const visible: VisibleLine[] = [];
  for (let index = headingLine + 1; index < sectionEnd; index += 1) {
    const raw = lineText(text, lines[index]);
    const next = nextFenceState(raw, fence);
    if (next !== fence) {
      fence = next;
      continue;
    }
    if (fence !== null) continue;
    if (ANY_HEADING.test(raw)) break;
    visible.push({ index, raw });
  }
  return visible;
}

function lastNonBlankLine(lines: VisibleLine[]): VisibleLine | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.raw.trim().length > 0) return line;
  }
  return null;
}

function listInsertionAnchor(lines: VisibleLine[], firstListAt: number): InsertionAnchor {
  const first = lines[firstListAt];
  const baseIndent = first.raw.match(LIST_ITEM)?.[1] ?? "";
  let last = first.index;
  for (const line of lines.slice(firstListAt + 1)) {
    if (line.raw.trim().length === 0) continue;
    const match = line.raw.match(LIST_ITEM);
    if (match?.[1] === baseIndent || indentation(line.raw) > baseIndent.length) {
      last = line.index;
      continue;
    }
    break;
  }
  return { line: last, kind: "list" };
}

function indentation(raw: string): number {
  return raw.length - raw.trimStart().length;
}

function insertBullet(
  source: string,
  lines: LineSpan[],
  anchor: InsertionAnchor,
  bullet: string,
  newline: string,
): string {
  const line = lines[anchor.line];
  const term = line.term.length === 0 ? newline : line.term;
  const separator = line.term.length === 0 || anchor.kind !== "list" ? term : "";
  const insertion = `${separator}${bullet}${line.term.length === 0 ? "" : line.term}`;
  if (line.term.length === 0) return `${source}${insertion}`;
  const at = line.contentEnd + line.term.length;
  return `${source.slice(0, at)}${insertion}${source.slice(at)}`;
}

export function applyApprovedLink(source: string, input: ApplyApprovedLinkInput): string {
  if (input.heading !== undefined && input.block !== undefined) {
    throw new Error("applyApprovedLink: heading and block qualifiers are mutually exclusive");
  }
  const heading = input.heading ?? null;
  const block = input.block ?? null;
  const bullet = `- ${formatWikilink(input.target, heading, block)}`;
  const newline = detectNewline(source);
  const bodyStart = locateFrontmatter(source)?.end ?? 0;
  const originalLines = splitLines(source);
  const originalStartLine = firstBodyLine(originalLines, bodyStart);
  const originalHeadingLine = findRelatedHeadingLine(source, originalLines, originalStartLine);
  if (originalHeadingLine !== -1) {
    const originalSectionEnd = findSectionEndLine(source, originalLines, originalHeadingLine);
    const presence = linkPresencePattern(input.target, heading, block);
    if (
      sectionContainsLink(source, originalLines, originalHeadingLine, originalSectionEnd, presence)
    ) {
      return source;
    }
  }
  const reconciled = closeOpenFenceAtEof(source, originalLines, originalStartLine, newline);
  const lines = splitLines(reconciled);
  const headingLine = findRelatedHeadingLine(reconciled, lines, firstBodyLine(lines, bodyStart));

  if (headingLine === -1) {
    return appendRelatedSection(reconciled, bullet, newline);
  }

  const sectionEnd = findSectionEndLine(reconciled, lines, headingLine);
  const presence = linkPresencePattern(input.target, heading, block);
  if (sectionContainsLink(reconciled, lines, headingLine, sectionEnd, presence)) {
    return reconciled;
  }
  return insertBullet(
    reconciled,
    lines,
    findInsertionAnchor(reconciled, lines, headingLine, sectionEnd),
    bullet,
    newline,
  );
}

function appendRelatedSection(source: string, bullet: string, newline: string): string {
  const section = `## Related${newline}${newline}${bullet}`;
  if (source.length === 0) {
    return `${section}${newline}`;
  }
  if (source.endsWith("\n")) {
    return `${source}${newline}${section}${newline}`;
  }
  return `${source}${newline}${newline}${section}`;
}

export function applyApprovedRelation(source: string, input: ApplyApprovedRelationInput): string {
  const wikilink = `[[${input.target}]]`;
  const found = readFrontmatter(source);
  const existing = readRelationArray(found.data, input.key);
  if (existing.some((entry) => relationTargets(entry, input.target))) {
    return source;
  }
  return patchFrontmatter(source, {
    notient: { [input.key]: [...existing, wikilink] },
  });
}

function relationTargets(entry: string, target: string): boolean {
  const match = entry.match(COMPLETE_WIKILINK);
  return match !== null && parseWikilinkInner(match[1]).target === target;
}

function readRelationArray(data: Record<string, unknown> | null, key: string): string[] {
  if (data === null) return [];
  const notient = data.notient;
  if (notient === undefined || notient === null) return [];
  if (typeof notient !== "object" || Array.isArray(notient)) {
    throw new Error("frontmatter.notient must be a mapping");
  }
  const existing = (notient as Record<string, unknown>)[key];
  if (existing === undefined || existing === null) return [];
  if (!Array.isArray(existing)) {
    throw new Error(`frontmatter.notient.${key} must be an array`);
  }
  const out: string[] = [];
  for (const entry of existing) {
    if (typeof entry !== "string") {
      throw new Error(`frontmatter.notient.${key} entries must be strings`);
    }
    out.push(entry);
  }
  return out;
}
