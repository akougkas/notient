import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { VaultAdapter } from "../adapters/vaultAdapter";
import { hasTag } from "../core/markdown/tags";
import { isCanonicalOrdinaryNotePath } from "../core/vault/publicPath";
import { NoteReadService, contentRevision } from "./notes";
import { type OperationInput, operationInputs, scopeSchema } from "./operations";
import { type JsonValue, NoteApiError, type NoteReadResult, type NoteReference } from "./schema";

export type NoteListResult = {
  ok: true;
  notes: Array<
    NoteReference & {
      tags: string[];
      aliases: string[];
      properties: Record<string, JsonValue> | null;
    }
  >;
  nextCursor: string | null;
  snapshot: string;
};
const cursorSchema = z
  .object({
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    query: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string(),
  })
  .strict();
const inside = (path: string, folder: string) => folder === "" || path.startsWith(`${folder}/`);

/** Model-free catalog over the same live file authority as ordinary reads. */
export class NoteCatalogService {
  private readonly notes: NoteReadService;
  constructor(private readonly vault: Pick<VaultAdapter, "listMarkdown" | "read" | "readBounded">) {
    this.notes = new NoteReadService(vault);
  }
  /** Filter an indexed candidate inventory. Tag filters still inspect live
   * metadata; callers validate evidence against current bytes after retrieval. */
  async filterCandidates(
    candidates: readonly string[],
    input: unknown,
    signal: AbortSignal,
  ): Promise<string[]> {
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const scope = parsed.data;
    signal.throwIfAborted();
    const listing = candidates.filter(isCanonicalOrdinaryNotePath).map((path) => ({ path }));
    if (listing.length > 10000)
      throw new NoteApiError("LIMIT_EXCEEDED", "catalog scan exceeds 10,000 notes");
    const paths: string[] = [];
    for (const entry of listing) {
      signal.throwIfAborted();
      if (!matchesScopePath(entry.path, scope)) continue;
      if (scope.tags.length || scope.excludeTags.length) {
        let note: NoteReadResult;
        try {
          note = await this.notes.read({ path: entry.path });
        } catch (error) {
          if (
            (error instanceof NoteApiError && error.code === "NOT_FOUND") ||
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            continue;
          throw error;
        }
        if (
          !matchesMetadata(note.structure.tags, note.structure.frontmatter.properties, {
            scope,
            limit: 200,
          })
        )
          continue;
      }
      paths.push(entry.path);
    }
    return paths.sort();
  }
  async list(input: unknown): Promise<NoteListResult> {
    const parsed = operationInputs["notes.list"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const terms = (request.query ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    const { cursor: _cursor, ...filters } = request;
    const query = contentRevision(JSON.stringify(filters));
    const listing = (await this.vault.listMarkdown())
      .filter((entry) => isCanonicalOrdinaryNotePath(entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (listing.length > 10000)
      throw new NoteApiError("LIMIT_EXCEEDED", "catalog scan exceeds 10,000 notes");
    const snapshot = contentRevision(JSON.stringify(listing));
    const after = readCursor(request.cursor, snapshot, query);
    const result: NoteListResult["notes"] = [];
    for (const entry of listing) {
      if (entry.path <= after || !matchesScopePath(entry.path, request.scope)) continue;
      if (!terms.every((term) => entry.path.toLowerCase().includes(term))) continue;
      const note = await this.notes.read({ path: entry.path });
      if (!matchesMetadata(note.structure.tags, note.structure.frontmatter.properties, request))
        continue;
      result.push({
        ...note.note,
        tags: note.structure.tags,
        aliases: note.structure.aliases,
        properties: note.structure.frontmatter.properties,
      });
      if (result.length > request.limit) break;
    }
    const hasMore = result.length > request.limit;
    const page = result.slice(0, request.limit);
    return {
      ok: true,
      notes: page,
      snapshot,
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({ snapshot, query, after: page[page.length - 1].path }),
          ).toString("base64url")
        : null,
    };
  }
}
function readCursor(rawCursor: string | undefined, snapshot: string, query: string): string {
  let after = "";
  if (rawCursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")),
      );
      if (cursor.snapshot !== snapshot || cursor.query !== query)
        throw new NoteApiError("CONFLICT", "catalog or filters changed; restart pagination");
      after = cursor.after;
    } catch (error) {
      if (error instanceof NoteApiError) throw error;
      throw new NoteApiError("INVALID_PARAMS", "invalid catalog cursor");
    }
  }
  return after;
}
export function matchesScopePath(
  path: string,
  scope: OperationInput<"notes.list">["scope"],
): boolean {
  if (!scope) return true;
  if (scope.excludeFolders?.some((folder) => inside(path, folder))) return false;
  if (scope.paths?.length && !scope.paths.includes(path)) return false;
  return !scope.folders?.length || scope.folders.some((folder) => inside(path, folder));
}
function matchesMetadata(
  tags: string[],
  properties: Record<string, JsonValue> | null,
  request: OperationInput<"notes.list">,
): boolean {
  if (request.scope?.excludeTags?.some((tag) => hasTag(tags, tag))) return false;
  if (request.scope?.tags?.some((tag) => !hasTag(tags, tag))) return false;
  return Object.entries(request.properties ?? {}).every(
    ([key, value]) =>
      properties !== null &&
      Object.hasOwn(properties, key) &&
      isDeepStrictEqual(properties[key], value),
  );
}

export function matchesNoteScope(
  note: NoteReadResult,
  scope: OperationInput<"notes.list">["scope"],
): boolean {
  return (
    matchesScopePath(note.note.path, scope) &&
    matchesMetadata(note.structure.tags, note.structure.frontmatter.properties, { scope, limit: 1 })
  );
}
