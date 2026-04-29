import { dirname } from "node:path/posix";

/**
 * Wikilink target resolver. Best-effort: never throws on unresolved.
 *
 * Spec: §8.3, Phase 2 plan §Task 10.
 *
 * Resolution order for a raw target string:
 *   1. Exact vault-relative path match, with or without the `.md` suffix.
 *   2. If the raw target has no `/`, basename match against all vault notes.
 *      When multiple notes share the basename, pick the one whose folder
 *      has the smallest edit distance to the active note's folder.
 *
 * Unresolved targets get `targetPath = null`. Persisting the original raw
 * target on the edge as `target_unresolved` is the caller's responsibility
 * (see Tier 1 indexer, Task 12).
 */

export interface ResolveInput {
  rawTarget: string;
  targetHeading: string | null;
  targetBlockId: string | null;
}

export interface ResolveOutput extends ResolveInput {
  targetPath: string | null;
}

function withMdSuffix(value: string): string {
  return value.endsWith(".md") ? value : `${value}.md`;
}

function basenameWithoutExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let column = 0; column <= b.length; column += 1) {
    previous[column] = column;
  }
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a.charCodeAt(row - 1) === b.charCodeAt(column - 1) ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      );
    }
    for (let column = 0; column <= b.length; column += 1) {
      previous[column] = current[column];
    }
  }
  return previous[b.length];
}

function resolveOne(
  raw: string,
  fromFolder: string,
  vaultPaths: string[],
  pathSet: Set<string>,
): string | null {
  if (raw.length === 0) {
    return null;
  }
  if (pathSet.has(raw)) {
    return raw;
  }
  const withSuffix = withMdSuffix(raw);
  if (pathSet.has(withSuffix)) {
    return withSuffix;
  }
  if (raw.includes("/")) {
    return null;
  }
  const baseTarget = basenameWithoutExtension(raw);
  const candidates = vaultPaths.filter(
    (path) => basenameWithoutExtension(path) === baseTarget,
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  let bestPath = candidates[0];
  let bestDistance = levenshtein(fromFolder, dirname(bestPath));
  for (let index = 1; index < candidates.length; index += 1) {
    const distance = levenshtein(fromFolder, dirname(candidates[index]));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPath = candidates[index];
    }
  }
  return bestPath;
}

export function resolveTargets(
  fromNotePath: string,
  inputs: ResolveInput[],
  vaultPaths: string[],
): ResolveOutput[] {
  const fromFolder = dirname(fromNotePath);
  const pathSet = new Set(vaultPaths);
  return inputs.map((input) => ({
    ...input,
    targetPath: resolveOne(input.rawTarget, fromFolder, vaultPaths, pathSet),
  }));
}
