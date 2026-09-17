/**
 * Real YAML frontmatter editing by byte-range splice.
 *
 * Whole-note serialization and flat, line-oriented YAML parsing are unsafe
 * for real Obsidian vaults: they can normalize Markdown and drop multiline
 * YAML values such as block-form `tags`, `aliases`, and `cssclasses`.
 *
 * The contract here is narrow on purpose:
 *
 *   readFrontmatter(text)   locates the `---` fenced block and parses it.
 *   patchFrontmatter(text)  splices only the top-level entries it changes.
 *
 * The body after the closing fence is never touched: callers can rely on
 * `text.slice(end)` being byte-identical before and after a patch. Common
 * scalar and list edits are applied to their source lines, so comments,
 * quoting styles, line endings, anchors and key order in unrelated entries are
 * byte-identical. Complex touched entries use `yaml`'s `Document` API rather
 * than being guessed at by a flat parser.
 */

import { Document, Scalar, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import type { Pair } from "yaml";

const BOM = "﻿";

export interface FrontmatterRead {
  /** Parsed mapping, or `null` when the note has no frontmatter block. */
  data: Record<string, unknown> | null;
  /** Offset of the opening `---` (after any BOM). */
  start: number;
  /** Offset just past the closing fence's line terminator (or EOF). */
  end: number;
  /** Raw YAML text between the fences, excluding both fence lines. */
  raw: string;
}

export interface FrontmatterLocation {
  /** Offset of the opening `---` after an optional BOM. */
  start: number;
  /** Offset just past the closing fence and its line terminator. */
  end: number;
  /** Bytes between the opening and closing fence lines. */
  raw: string;
}

export interface PatchFrontmatterOptions {
  /**
   * Newline sequence for any bytes this module authors. Defaults to the
   * dominant style of the input (`\r\n` when the text contains one).
   */
  newline?: string;
}

export class FrontmatterUnparseableError extends Error {
  constructor(reason: string) {
    super(`FRONTMATTER_UNPARSEABLE: ${reason}`);
    this.name = "FrontmatterUnparseableError";
  }
}

export function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function bomLength(text: string): number {
  return text.startsWith(BOM) ? BOM.length : 0;
}

function isFence(line: string): boolean {
  return /^---[ \t]*$/.test(line);
}

/**
 * Locate and parse the note's YAML frontmatter block.
 *
 * Recognises a block only when the very first line of the document (after an
 * optional BOM) is a `---` fence, matching Obsidian. A `---` appearing later in
 * the body is a thematic break and is left alone. An opening fence with no
 * closing fence is not a frontmatter block either.
 */
export function readFrontmatter(text: string): FrontmatterRead {
  const offset = bomLength(text);
  const none: FrontmatterRead = { data: null, start: offset, end: offset, raw: "" };
  const location = locateFrontmatter(text);
  if (location === null) return none;
  return { ...location, data: parseBlock(location.raw) };
}

/** Locate a frontmatter block without requiring its YAML to parse. */
export function locateFrontmatter(text: string): FrontmatterLocation | null {
  const offset = bomLength(text);
  if (text.length === offset) return null;

  const firstEnd = lineEnd(text, offset);
  const firstLine = text.slice(offset, firstEnd.contentEnd);
  if (!isFence(firstLine) || firstEnd.term.length === 0) return null;

  const rawStart = firstEnd.contentEnd + firstEnd.term.length;
  let cursor = rawStart;
  while (cursor < text.length) {
    const line = lineEnd(text, cursor);
    if (isFence(text.slice(cursor, line.contentEnd))) {
      return {
        start: offset,
        end: line.contentEnd + line.term.length,
        raw: text.slice(rawStart, cursor),
      };
    }
    cursor = line.contentEnd + line.term.length;
    if (line.term.length === 0) break;
  }
  return null;
}

function lineEnd(text: string, from: number): { contentEnd: number; term: string } {
  const index = text.indexOf("\n", from);
  if (index === -1) return { contentEnd: text.length, term: "" };
  if (index > from && text[index - 1] === "\r") {
    return { contentEnd: index - 1, term: "\r\n" };
  }
  return { contentEnd: index, term: "\n" };
}

function parseBlock(raw: string): Record<string, unknown> {
  const doc = parseDocument(normalizeEol(raw));
  if (doc.errors.length > 0) {
    throw new FrontmatterUnparseableError(doc.errors[0].message);
  }
  const value = doc.toJS() as unknown;
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterUnparseableError("frontmatter root must be a mapping");
  }
  return value as Record<string, unknown>;
}

function normalizeEol(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type CommonEntryShape = "scalar" | "block-list" | "flow-list";

interface SourceEdit {
  start: number;
  end: number;
  replacement: string;
}

type CommonEntryPlan =
  | { kind: "addition"; entry: readonly [string, unknown] }
  | { kind: "edit"; edit: SourceEdit }
  | { kind: "none" };

/**
 * Apply a shallow patch to the note's frontmatter and return the new text.
 *
 * Semantics:
 *   - top-level keys are set (created when absent, in patch order);
 *   - a `null` patch value deletes the key;
 *   - a plain-object patch value over an existing mapping merges one level
 *     (this is what `notient.*` vitals and typed relations need); anything
 *     else replaces wholesale.
 *
 * Throws `FRONTMATTER_UNPARSEABLE: <reason>` rather than guessing when the
 * existing block is not valid YAML. Guessing is how the old flat-YAML parser
 * destroyed block-form lists.
 */
export function patchFrontmatter(
  text: string,
  patch: Record<string, unknown>,
  options: PatchFrontmatterOptions = {},
): string {
  const newline = options.newline ?? detectNewline(text);
  const found = readFrontmatter(text);
  const doc = loadDocument(found);

  if (found.data !== null) {
    const spliced = spliceCommonEntries(found.raw, doc, patch, newline);
    if (spliced !== null) {
      return replaceRawBlock(text, found, spliced);
    }
  } else if (Object.values(patch).every((value) => value === null || isCommonPatchValue(value))) {
    const raw = serializeAdditions(Object.entries(patch), newline);
    if (raw.length === 0) return text;
    return `${text.slice(0, found.start)}---${newline}${raw}---${newline}${text.slice(found.end)}`;
  }

  for (const [key, value] of Object.entries(patch)) {
    applyKey(doc, key, value);
  }
  const yamlText = doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
  const raw = `${withNewline(yamlText, newline)}${newline}`;
  if (found.data !== null) {
    return replaceRawBlock(text, found, raw);
  }
  return `${text.slice(0, found.start)}---${newline}${raw}---${newline}${text.slice(found.end)}`;
}

function spliceCommonEntries(
  raw: string,
  doc: Document,
  patch: Record<string, unknown>,
  newline: string,
): string | null {
  if (
    !isMap(doc.contents) ||
    doc.contents.flow === true ||
    doc.contents.anchor !== undefined ||
    doc.contents.tag !== undefined
  ) {
    return null;
  }

  const edits: SourceEdit[] = [];
  const additions: Array<readonly [string, unknown]> = [];
  for (const [key, value] of Object.entries(patch)) {
    const pair = findTopLevelPair(doc.contents.items, key);
    const plan = planCommonEntry(raw, pair, key, value, newline);
    if (plan === null) return null;
    if (plan.kind === "edit") edits.push(plan.edit);
    if (plan.kind === "addition") additions.push(plan.entry);
  }

  const addedSource = serializeAdditions(additions, newline);
  if (addedSource.length > 0) {
    const insertion = doc.contents.range?.[2] ?? raw.length;
    edits.push({ start: insertion, end: insertion, replacement: addedSource });
  }

  edits.sort((a, b) => b.start - a.start);
  let next = raw;
  for (const edit of edits) {
    next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
  }
  return next;
}

function planCommonEntry(
  raw: string,
  pair: Pair | undefined,
  key: string,
  value: unknown,
  newline: string,
): CommonEntryPlan | null {
  if (value === null) {
    if (pair === undefined) return { kind: "none" };
    const range = pairSourceRange(raw, pair);
    return range === null ? null : { kind: "edit", edit: { ...range, replacement: "" } };
  }
  if (!isCommonPatchValue(value)) return null;
  if (pair === undefined) return { kind: "addition", entry: [key, value] };

  const shape = commonEntryShape(pair);
  const range = pairSourceRange(raw, pair);
  if (shape === null || range === null) return null;
  return {
    kind: "edit",
    edit: {
      ...range,
      replacement: serializeCommonEntry(key, value, shape, pair, raw, newline),
    },
  };
}

function findTopLevelPair(items: Pair[], key: string): Pair | undefined {
  return items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function commonEntryShape(pair: Pair): CommonEntryShape | null {
  const value = pair.value;
  if (isScalar(value)) {
    if (
      value.type === Scalar.BLOCK_FOLDED ||
      value.type === Scalar.BLOCK_LITERAL ||
      value.anchor !== undefined ||
      value.tag !== undefined
    ) {
      return null;
    }
    return "scalar";
  }
  if (!isSeq(value) || value.anchor !== undefined || value.tag !== undefined) return null;
  if (!value.items.every(isCommonSequenceItem)) return null;
  return value.flow === true ? "flow-list" : "block-list";
}

function isCommonSequenceItem(value: unknown): boolean {
  return (
    isScalar(value) &&
    value.type !== Scalar.BLOCK_FOLDED &&
    value.type !== Scalar.BLOCK_LITERAL &&
    value.anchor === undefined &&
    value.tag === undefined
  );
}

function isCommonPatchValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.every(isCommonScalarValue);
  return isCommonScalarValue(value);
}

function isCommonScalarValue(value: unknown): boolean {
  if (value === null || value instanceof Date) return true;
  if (typeof value === "string") return !/[\r\n]/.test(value);
  return ["bigint", "boolean", "number"].includes(typeof value);
}

function pairSourceRange(raw: string, pair: Pair): { start: number; end: number } | null {
  if (!isScalar(pair.key) || pair.key.range === undefined || pair.key.range === null) return null;
  const start = raw.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
  const valueEnd = isNode(pair.value) ? pair.value.range?.[2] : undefined;
  const nodeEnd = valueEnd ?? pair.key.range[2];
  if (nodeEnd === undefined) return null;
  if (nodeEnd > start && raw[nodeEnd - 1] === "\n") return { start, end: nodeEnd };
  const line = lineEnd(raw, nodeEnd);
  return { start, end: line.contentEnd + line.term.length };
}

function serializeCommonEntry(
  key: string,
  value: unknown,
  previousShape: CommonEntryShape,
  pair: Pair | undefined,
  raw: string,
  newline: string,
): string {
  const doc = new Document({});
  if (Array.isArray(value)) {
    const node = doc.createNode(value);
    if (isSeq(node) && previousShape === "flow-list") node.flow = true;
    doc.set(key, node);
  } else {
    doc.set(key, value);
  }

  let yaml = doc.toString({ indentSeq: false, lineWidth: 0 });
  if (Array.isArray(value) && previousShape !== "flow-list") {
    const indent = previousShape === "block-list" ? blockListIndent(pair, raw) : 2;
    if (indent > 0) {
      const prefix = " ".repeat(indent);
      yaml = yaml
        .split("\n")
        .map((line, index) => (index > 0 && line.startsWith("-") ? `${prefix}${line}` : line))
        .join("\n");
    }
  }
  return withNewline(yaml, newline);
}

function blockListIndent(pair: Pair | undefined, raw: string): number {
  if (pair === undefined) return 2;
  if (!isSeq(pair.value) || pair.value.range === undefined || pair.value.range === null) return 2;
  const valueStart = pair.value.range[0];
  return valueStart - (raw.lastIndexOf("\n", valueStart - 1) + 1);
}

function serializeAdditions(
  entries: Iterable<readonly [string, unknown]>,
  newline: string,
): string {
  let raw = "";
  for (const [key, value] of entries) {
    if (value !== null) {
      raw += serializeCommonEntry(key, value, "scalar", undefined, "", newline);
    }
  }
  return raw;
}

function replaceRawBlock(text: string, found: FrontmatterRead, raw: string): string {
  const openingLine = lineEnd(text, found.start);
  const rawStart = openingLine.contentEnd + openingLine.term.length;
  const rawEnd = rawStart + found.raw.length;
  return `${text.slice(0, rawStart)}${raw}${text.slice(rawEnd)}`;
}

function loadDocument(found: FrontmatterRead): Document {
  if (found.data === null) {
    return new Document({});
  }
  const parsed = parseDocument(found.raw);
  if (parsed.errors.length > 0) {
    throw new FrontmatterUnparseableError(parsed.errors[0].message);
  }
  if (parsed.contents === null) {
    return new Document({});
  }
  if (!isMap(parsed.contents)) {
    throw new FrontmatterUnparseableError("frontmatter root must be a mapping");
  }
  return parsed;
}

function applyKey(doc: Document, key: string, value: unknown): void {
  if (value === null) {
    doc.delete(key);
    return;
  }
  const existing = doc.get(key, true);
  if (!isPlainObject(value) || !isMap(existing)) {
    doc.set(key, value);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childValue === null) {
      doc.deleteIn([key, childKey]);
    } else {
      doc.setIn([key, childKey], childValue);
    }
  }
}

function withNewline(yamlText: string, newline: string): string {
  if (newline === "\n") return yamlText;
  return yamlText.replace(/\n/g, newline);
}
