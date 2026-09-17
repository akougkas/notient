import type { z } from "zod";
import { hasTag } from "../core/markdown/tags";
import type { scopeSchema } from "./operations";

export type NoteScope = z.infer<typeof scopeSchema>;
export const insideFolder = (path: string, folder: string): boolean =>
  folder === "" || path.startsWith(`${folder}/`);
export function scopeAllows(scope: NoteScope, path: string, tags: readonly string[]): boolean {
  return (
    (!scope.paths.length || scope.paths.includes(path)) &&
    (!scope.folders.length || scope.folders.some((folder) => insideFolder(path, folder))) &&
    !scope.excludeFolders.some((folder) => insideFolder(path, folder)) &&
    scope.tags.every((tag) => hasTag(tags, tag)) &&
    !scope.excludeTags.some((tag) => hasTag(tags, tag))
  );
}
