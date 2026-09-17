import { createHash } from "node:crypto";
import type { Definition } from "mdast";
import { toString as markdownText } from "mdast-util-to-string";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import type { VaultAdapter } from "../adapters/vaultAdapter";
import { locateFrontmatter, readFrontmatter } from "../core/markdown/frontmatter";
import { parse, processAst } from "../core/markdown/pipeline";
import { parseWikilinkInner } from "../core/markdown/plugins/remarkWikilink";
import { inlineTagPattern, isTagName, tagName } from "../core/markdown/tags";
import {
  type JsonValue,
  NoteApiError,
  type NoteReadResult,
  type NoteSelector,
  type NoteStructure,
  type SourceRange,
  noteReadRequestSchema,
} from "./schema";

export function contentRevision(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Offsets are UTF-16 code units into the exact returned body; end is exclusive. */
export function sourceRange(body: string, start: number, end: number): SourceRange {
  return {
    start,
    end,
    startLine: body.slice(0, start).split(/\r\n|\n|\r/).length,
    endLine: body.slice(0, end).split(/\r\n|\n|\r/).length,
  };
}
function nodeRange(body: string, node: Node): SourceRange {
  const bom = body.startsWith("\ufeff") ? 1 : 0;
  return sourceRange(
    body,
    (node.position?.start.offset ?? 0) + bom,
    (node.position?.end.offset ?? 0) + bom,
  );
}
function strings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
}
function jsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("frontmatter must contain finite, nonrecursive JSON values");
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, next));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValue(item, next)]),
  );
}

export function inspectMarkdown(body: string): NoteStructure {
  const result: NoteStructure = {
    frontmatter: { properties: null, raw: "", range: null, error: null },
    headings: [],
    blocks: [],
    links: [],
    tags: [],
    aliases: [],
    callouts: [],
    tasks: [],
  };
  const frontmatter = locateFrontmatter(body);
  if (frontmatter) {
    result.frontmatter.raw = frontmatter.raw;
    result.frontmatter.range = sourceRange(body, frontmatter.start, frontmatter.end);
    try {
      result.frontmatter.properties = jsonValue(readFrontmatter(body).data) as Record<
        string,
        JsonValue
      > | null;
    } catch (error) {
      result.frontmatter.error = error instanceof Error ? error.message : String(error);
    }
  }
  result.aliases = strings(
    result.frontmatter.properties?.aliases ?? result.frontmatter.properties?.alias,
  );
  const tags = new Set(
    strings(result.frontmatter.properties?.tags ?? result.frontmatter.properties?.tag).flatMap(
      (tag) => tagName(tag) ?? [],
    ),
  );
  const ast = parse(body);
  const occurrences = new Map<string, number>();
  const definitions = new Map<string, Definition>();
  visit(ast, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
  });
  visit(ast, (node) => {
    if (node.type === "heading") {
      const text = markdownText(node);
      const occurrence = (occurrences.get(text) ?? 0) + 1;
      occurrences.set(text, occurrence);
      result.headings.push({
        text,
        level: node.depth,
        occurrence,
        range: nodeRange(body, node),
        section: nodeRange(body, node),
      });
    }
  });
  visit(ast, (node) => {
    if (node.type === "link" || node.type === "image") {
      result.links.push({
        kind: "markdown",
        target: node.url,
        alias: node.type === "image" ? (node.alt ?? null) : markdownText(node),
        heading: null,
        block: null,
        embed: node.type === "image",
        range: nodeRange(body, node),
      });
    }
  });
  visit(ast, (node) => {
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition?.type === "definition")
        result.links.push({
          kind: "markdown",
          target: definition.url,
          alias: node.type === "imageReference" ? (node.alt ?? null) : markdownText(node),
          heading: null,
          block: null,
          embed: node.type === "imageReference",
          range: nodeRange(body, node),
        });
    }
  });
  visit(ast, (node) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      result.tasks.push({
        checked: node.checked,
        text: markdownText(node),
        range: nodeRange(body, node),
      });
    } else if (node.type === "blockquote") {
      const match = /^\[!([\w-]+)\][+-]?\s*([^\n]*)/.exec(markdownText(node));
      if (match)
        result.callouts.push({ kind: match[1], title: match[2], range: nodeRange(body, node) });
    }
  });
  visit(ast, "text", (node) => {
    // Read raw text spans: remark's cooked values can collapse backslash escapes.
    const span = nodeRange(body, node);
    const offset = span.start;
    const raw = body.slice(offset, span.end);
    for (const match of raw.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g)) {
      const start = match.index;
      if (escaped(raw, start)) continue;
      const parsed = parseWikilinkInner(match[1]);
      result.links.push({
        kind: "wiki",
        target: parsed.target,
        alias: parsed.alias,
        heading: parsed.heading,
        block: parsed.block,
        embed: match[0].startsWith("!"),
        range: sourceRange(body, offset + start, offset + start + match[0].length),
      });
    }
    for (const match of raw.matchAll(inlineTagPattern())) {
      if (isTagName(match[2])) tags.add(match[2]);
    }
  });
  for (let index = 0; index < result.headings.length; index++) {
    const heading = result.headings[index];
    const next = result.headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    heading.section = sourceRange(body, heading.range.start, next?.range.start ?? body.length);
  }
  visit(processAst(body), (node) => {
    if ((node.type === "paragraph" || node.type === "listItem") && node.blockId)
      result.blocks.push({ id: node.blockId, range: nodeRange(body, node) });
  });
  result.links.sort((left, right) => left.range.start - right.range.start);
  result.tags = [...tags];
  return result;
}
function escaped(raw: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && raw[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

export function selectRange(
  body: string,
  structure: NoteStructure,
  selector: NoteSelector,
): SourceRange {
  if (selector.kind === "range") {
    if (selector.end < selector.start || selector.end > body.length)
      throw new NoteApiError("INVALID_PARAMS", "range is outside the note");
    return sourceRange(body, selector.start, selector.end);
  }
  const candidates =
    selector.kind === "block"
      ? structure.blocks.filter((block) => block.id === selector.id).map((block) => block.range)
      : structure.headings
          .filter(
            (heading) =>
              heading.text === selector.text &&
              (selector.occurrence === undefined || heading.occurrence === selector.occurrence),
          )
          .map((heading) => heading.section);
  if (candidates.length === 0)
    throw new NoteApiError("NOT_FOUND", "selector does not resolve in this revision");
  if (candidates.length !== 1)
    throw new NoteApiError(
      "CONFLICT",
      "selector is ambiguous; select an exact heading occurrence or revision-bound range",
    );
  return candidates[0];
}

export class NoteReadService {
  constructor(
    private readonly vault: Pick<VaultAdapter, "read"> & Partial<Pick<VaultAdapter, "readBounded">>,
    private readonly indexedRevision?: (path: string) => Promise<string | null>,
  ) {}
  async read(input: unknown): Promise<NoteReadResult> {
    const parsed = noteReadRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new NoteApiError(
        "INVALID_PARAMS",
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    const request = parsed.data;
    let body: string;
    try {
      body = this.vault.readBounded
        ? await this.vault.readBounded(request.path, 4 * 1024 * 1024)
        : await this.vault.read(request.path);
    } catch (error) {
      // Every caller distinguishes an absent note from a failed read.
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new NoteApiError("NOT_FOUND", "note does not exist");
      throw error;
    }
    if (Buffer.byteLength(body) > 4 * 1024 * 1024)
      throw new NoteApiError("LIMIT_EXCEEDED", "note exceeds 4 MiB read limit");
    const revision = contentRevision(body);
    if (request.revision && request.revision !== revision)
      throw new NoteApiError("CONFLICT", "note revision changed");
    const note = { path: request.path, revision };
    const structure = inspectMarkdown(body);
    const range = request.selector ? selectRange(body, structure, request.selector) : null;
    const indexedRevision = (await this.indexedRevision?.(request.path)) ?? null;
    return {
      ok: true,
      body,
      note,
      structure,
      selected: range ? { ...note, range, quote: body.slice(range.start, range.end) } : null,
      freshness: {
        source: "file",
        indexedRevision,
        state:
          indexedRevision === null
            ? "unknown"
            : indexedRevision === revision
              ? "current"
              : "lagging",
      },
    };
  }
}
