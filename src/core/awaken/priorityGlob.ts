import { globToRegExp } from "../indexer/excludePaths";

/**
 * Build the one ordering relation used by awaken plan creation and cursor
 * resume. The shared vault-glob compiler is the sole authority for `*`, `**`,
 * and `?` semantics across indexing entry points.
 */
export function createPriorityComparator(
  globs: ReadonlyArray<string>,
): (left: string, right: string) => number {
  const matchers = validatePriorityGlobs(globs).map((pattern) => globToRegExp(pattern));
  const bucketFor = (path: string): number => {
    for (let index = 0; index < matchers.length; index += 1) {
      if (matchers[index]?.test(path)) return index;
    }
    return matchers.length;
  };
  return (left, right) => bucketFor(left) - bucketFor(right) || compareVaultPaths(left, right);
}

/** Return a new priority-ordered plan without mutating the vault listing. */
export function sortByPriorityGlobs(
  paths: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
): string[] {
  return [...paths].sort(createPriorityComparator(globs));
}

export function compareVaultPaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatePriorityGlobs(globs: ReadonlyArray<string>): string[] {
  if (!Array.isArray(globs)) {
    throw new Error("awaken priority globs must be an array");
  }
  const seen = new Set<string>();
  return globs.map((pattern, index) => {
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.trim() !== pattern ||
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      hasControlCharacter(pattern)
    ) {
      throw new Error(`awaken priority glob ${index} must be a canonical vault-relative pattern`);
    }
    const segments = pattern.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error(`awaken priority glob ${index} must be a canonical vault-relative pattern`);
    }
    if (seen.has(pattern)) {
      throw new Error(`awaken priority glob '${pattern}' is duplicated`);
    }
    seen.add(pattern);
    return pattern;
  });
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
